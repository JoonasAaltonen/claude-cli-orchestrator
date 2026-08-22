/**
 * The watcher. §11 step 4 — last, on purpose.
 *
 * C5 — "The watcher is the component that converts a controllable system into an
 * unattended one, so it goes in last, after the guards have been seen working."
 *
 * D4 is the requirement that decides what this file may and may not do:
 *
 *   "Sweep on process exit for the machine path; watch the filesystem only for the
 *   human path. The application started the agent, so it knows when the invocation
 *   finished — no polling, no debounce, no reading a file mid-write. A watcher is
 *   needed only for writes the application did not cause, which means the operator
 *   writing a row by hand."
 *
 * So this does *not* watch agent outboxes during a dispatch — run.ts sweeps on exit,
 * which is exact. It watches the ledger index for changes the application did not
 * make, which is the human path, and then hands off to the same `runUntilQuiescent`
 * the manual command uses. There is no second dispatch path.
 */
import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import type { Config } from '../config/load.js';
import { layout } from '../ledger/store.js';
import { runUntilQuiescent } from '../dispatch/run.js';
import { killSwitchTripped } from '../guards/budget.js';
import { ensureDir, sha256, readTextIfExists, listFiles } from '../util/fsx.js';
import { bold, dim, green, red, yellow, heading } from './render.js';

export interface WatchOptions {
  dryRun: boolean;
  /**
   * Also watch every agent's outbox, not only the index.
   *
   * D4 scoped the watcher to "writes the application did not cause, which means the
   * operator writing a row by hand". There turns out to be a second kind: an agent
   * leaving a message during a session a human started (`/ledger-note`). That is also
   * a write this application did not cause — it just lands in an outbox rather than
   * in the index, so the index watch never sees it.
   */
  outboxes: boolean;
}

/**
 * A write the application did not cause needs a settling delay, because the operator
 * may be writing with an editor that saves in several steps. This is the only
 * debounce in the application, and D4 is explicit that it exists solely for this
 * path — the machine path has none.
 */
const SETTLE_MS = 750;

/** Which of the two watched things moved. Decides whether the index-hash check applies. */
type Cause = 'index' | 'outbox';

export async function runWatch(config: Config, opts: WatchOptions): Promise<void> {
  const l = layout(config);
  await ensureDir(l.root);

  console.log(heading('Watching'));
  console.log(`  index     ${bold(l.index)}`);
  console.log(`  mode      ${opts.dryRun ? yellow('dry run — nothing will be spent (C4)') : green('live')}`);
  console.log(`  stop      ${dim('Ctrl-C, or `orchestrator stop` to set the kill switch (C3)')}`);
  console.log(`  outboxes  ${opts.outboxes ? green(`${config.agents.length} watched`) : dim('not watched — pass --outboxes')}`);
  console.log(dim('\n  D4: only writes this application did not cause are watched for. During a'));
  console.log(dim('  dispatch, outboxes are swept on process exit instead, which needs no polling.'));
  if (opts.outboxes) {
    console.log(dim('  --outboxes covers notes agents leave from their own interactive sessions.'));
  }

  const kill = await killSwitchTripped(config);
  if (kill !== null) {
    console.log(`\n  ${red('kill switch is set')} — ${kill}`);
    console.log(dim('  Watching, but nothing will be dispatched until `orchestrator resume`.'));
  }

  let lastHash = await hashIndex(l.index);
  let busy = false;
  let timer: NodeJS.Timeout | null = null;
  let stopping = false;
  let pendingCause: Cause = 'index';
  let lastOutboxHash = opts.outboxes ? await hashOutboxes(config) : '';

  const react = async (cause: Cause = 'index') => {
    if (busy || stopping) return;

    // Both watched things get the same treatment: compare content, act only on a
    // real change, and rebase afterwards. The application writes to both — it
    // appends to the index and the sweep *moves files out of* outboxes — so without
    // this every reaction triggers the next one.
    //
    // Measured before the guard was here: a swept file left the outbox, that removal
    // fired an outbox event, and the watcher reacted a second time one second later.
    // Harmless on a run that worked, and not harmless on one that produced nothing:
    // runUntilQuiescent deliberately stops there rather than repeat a failed
    // invocation (C6), and a spurious re-trigger walks straight around that stop.
    //
    // The index hash cannot stand in for the outbox: a file sitting in an outbox is
    // not in the index yet, and that is the entire point of it.
    const hash = await hashIndex(l.index);
    const outboxHash = opts.outboxes ? await hashOutboxes(config) : '';
    const moved = cause === 'outbox' ? outboxHash !== lastOutboxHash : hash !== lastHash;
    if (!moved) return;
    lastHash = hash;
    lastOutboxHash = outboxHash;

    busy = true;
    try {
      const what = cause === 'outbox' ? 'outbox changed' : 'index changed';
      console.log(`\n${dim(new Date().toISOString().slice(11, 19))} ${what}`);
      const outcomes = await runUntilQuiescent(config, {
        dryRun: opts.dryRun,
        sweepFirst: opts.outboxes,
        onLog: (line) => console.log(line),
      });
      if (!outcomes.length) console.log(dim('  nothing to dispatch'));
      // The dispatches appended rows of their own and swept files out of outboxes.
      // Rebase both, so neither re-triggers this.
      lastHash = await hashIndex(l.index);
      if (opts.outboxes) lastOutboxHash = await hashOutboxes(config);
    } catch (err: any) {
      console.error(`${red('dispatch failed')} ${err?.message ?? String(err)}`);
    } finally {
      busy = false;
    }
  };

  const schedule = (cause: Cause = 'index') => {
    if (timer) clearTimeout(timer);
    // An outbox write wins the coalesce: if both fired inside one settle window, the
    // outbox is the one carrying something the fold has not seen yet.
    if (cause === 'outbox') pendingCause = 'outbox';
    timer = setTimeout(() => {
      const c = pendingCause;
      pendingCause = 'index';
      void react(c);
    }, SETTLE_MS);
  };

  let watcher: fs.FSWatcher;
  try {
    // Watching the directory rather than the file: an editor that saves by
    // rename-over replaces the inode, and a file watch would follow the old one.
    // Derived from the layout, never spelled out here. A hardcoded "index.txt"
    // survived the move to NDJSON and left the watcher silently inert: the name
    // never matched, so nothing was ever scheduled, and a watcher that reacts to
    // nothing looks exactly like a ledger with nothing pending.
    const indexName = path.basename(l.index).toLowerCase();
    const killName = path.basename(l.kill).toLowerCase();

    watcher = fs.watch(l.root, { persistent: true }, (_event, filename) => {
      if (!filename) return schedule();
      const name = String(filename).toLowerCase();
      if (name === indexName) schedule();
      // C3 — the kill switch appearing is worth reacting to immediately.
      if (name === killName) {
        void killSwitchTripped(config).then((reason) => {
          if (reason !== null) console.log(`\n${red('kill switch set')} — ${reason}`);
        });
      }
    });
  } catch (err: any) {
    console.error(`${red('could not watch')} ${l.root}: ${err?.message ?? String(err)}`);
    process.exitCode = 1;
    return;
  }

  // One watcher per outbox. Watching each agent's directory rather than the tree
  // keeps this to N watchers on directories the operator already knows about, and
  // avoids following an agent's own working files around its home.
  const outboxWatchers: fs.FSWatcher[] = [];
  if (opts.outboxes) {
    for (const agent of config.agents) {
      await ensureDir(agent.outbox);
      try {
        outboxWatchers.push(
          fs.watch(agent.outbox, { persistent: true }, (_event, filename) => {
            // Only message files. An agent may keep scratch files here, and a sweep
            // ignores anything that is not .md anyway.
            if (filename && !/\.(md|markdown)$/i.test(String(filename))) return;
            schedule('outbox');
          })
        );
      } catch (err: any) {
        console.error(`  ${yellow('could not watch')} ${agent.outbox}: ${err?.message ?? String(err)}`);
      }
    }
  }

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    watcher.close();
    for (const w of outboxWatchers) w.close();
    console.log(`\n${dim('stopped watching')}`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // An initial pass, so starting the watcher on a ledger that already has pending
  // work does something rather than waiting for the next keystroke. With --outboxes
  // it also adopts anything left sitting in an outbox since last time, which is the
  // common case when this is started after a day of interactive work.
  await react(opts.outboxes ? 'outbox' : 'index');

  // Keep the process alive; the watcher holds the loop but this makes it explicit.
  await new Promise<void>(() => {});
}

async function hashIndex(file: string): Promise<string> {
  const text = await readTextIfExists(file);
  return text === null ? '' : sha256(text);
}

/**
 * A fingerprint of every outbox: which message files are present, and their size and
 * modification time.
 *
 * Names alone are not enough — an agent rewriting a file it already wrote would leave
 * the listing identical, and that is a real edit worth sweeping. Contents would be
 * exact but means reading every file on every filesystem event, for a directory that
 * is normally empty.
 */
async function hashOutboxes(config: Config): Promise<string> {
  const parts: string[] = [];
  for (const agent of [...config.agents].sort((a, b) => a.name.localeCompare(b.name))) {
    const files = (await listFiles(agent.outbox)).filter((f) => /\.(md|markdown)$/i.test(f)).sort();
    for (const f of files) {
      let stamp = '?';
      try {
        const st = await stat(f);
        stamp = `${st.size}:${st.mtimeMs}`;
      } catch {
        // Raced with the sweep moving it. Absent from the next fingerprint anyway.
      }
      parts.push(`${agent.name} ${f} ${stamp}`);
    }
  }
  return sha256(parts.join('\n'));
}
