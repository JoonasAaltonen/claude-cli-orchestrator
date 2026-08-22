/**
 * The watcher, run as a real process.
 *
 * Both bugs this pins were invisible to inspection and to every other kind of test:
 *
 *   1. A hardcoded `index.txt` survived the move to NDJSON, so the filename never
 *      matched and the watcher was completely inert. A watcher that reacts to nothing
 *      looks exactly like a ledger with nothing pending.
 *   2. `--outboxes` fed itself. The sweep *moves* a file out of the outbox, that
 *      removal fires another outbox event, and the watcher reacted a second time.
 *      Harmless after a run that worked; not harmless after one that produced
 *      nothing, because `runUntilQuiescent` deliberately stops there rather than
 *      repeat a failed invocation (C6), and the re-trigger walks around that stop.
 *
 * Neither shows up without starting the process and touching the filesystem, so that
 * is what these do. `--dry-run` throughout: nothing is ever invoked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const CLI = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));

/** Generous: 750ms settle, plus process start and a fold read. */
const SETTLE = 4000;

interface Harness {
  root: string;
  configFile: string;
  outbox: string;
  commsIndex: string;
  child: ChildProcess;
  log: () => string;
  stop: () => void;
}

async function startWatcher(flags: string[]): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'orch-watch-'));
  const comms = path.join(root, 'comms');
  const home = path.join(root, 'agents', 'alpha');
  const outbox = path.join(home, 'outbox');
  await mkdir(outbox, { recursive: true });
  await mkdir(path.join(root, 'agents', 'beta', 'outbox'), { recursive: true });
  await mkdir(comms, { recursive: true });
  await writeFile(path.join(home, 'CLAUDE.md'), '# alpha\n');
  await writeFile(path.join(root, 'agents', 'beta', 'CLAUDE.md'), '# beta\n');

  const configFile = path.join(root, 'orchestrator.config.json');
  await writeFile(
    configFile,
    JSON.stringify(
      {
        commsRoot: comms,
        agents: [
          { name: 'alpha', home },
          { name: 'beta', home: path.join(root, 'agents', 'beta') },
        ],
      },
      null,
      2
    )
  );

  let out = '';
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', CLI, '-c', configFile, 'watch', '--dry-run', ...flags],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c: string) => (out += c));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => (out += c));

  return {
    root,
    configFile,
    outbox,
    commsIndex: path.join(comms, 'index.jsonl'),
    child,
    log: () => out,
    stop: () => child.kill(),
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const NOTE = [
  '---',
  'to: beta',
  'type: request',
  'summary: Left in an outbox while the watcher was running',
  '---',
  '',
  'Nobody ran sweep. The watcher has to notice this by itself.',
].join('\n');

test('--outboxes notices a file nobody told it about, and adopts it', async () => {
  const h = await startWatcher(['--outboxes']);
  try {
    await wait(SETTLE);
    await writeFile(path.join(h.outbox, 'note.md'), NOTE);
    await wait(SETTLE);

    const log = h.log();
    assert.match(log, /outbox changed/, `watcher never reacted:\n${log}`);
    assert.match(log, /swept alpha: 0001/, `the note was not adopted:\n${log}`);
    assert.match(log, /beta/, 'and it should be routed to the addressee');
  } finally {
    h.stop();
    await rm(h.root, { recursive: true, force: true });
  }
});

test('it reacts exactly once — the sweep moving the file must not re-trigger it', async () => {
  const h = await startWatcher(['--outboxes']);
  try {
    await wait(SETTLE);
    await writeFile(path.join(h.outbox, 'note.md'), NOTE);
    // Deliberately long: the second reaction previously landed about a second after
    // the first, so a short wait would have passed while the bug was present.
    await wait(SETTLE * 2);

    const log = h.log();
    const reactions = (log.match(/(outbox|index) changed/g) ?? []).length;
    assert.equal(reactions, 1, `expected one reaction, got ${reactions}:\n${log}`);
  } finally {
    h.stop();
    await rm(h.root, { recursive: true, force: true });
  }
});

test('without --outboxes the same file is ignored, which is what makes the flag meaningful', async () => {
  const h = await startWatcher([]);
  try {
    await wait(SETTLE);
    await writeFile(path.join(h.outbox, 'note.md'), NOTE);
    await wait(SETTLE);

    const log = h.log();
    assert.doesNotMatch(log, /outbox changed/, `outboxes should not be watched:\n${log}`);
    assert.match(log, /not watched/, 'and the header should say so plainly');
  } finally {
    h.stop();
    await rm(h.root, { recursive: true, force: true });
  }
});

test('the index it watches is the one the store actually writes', async () => {
  // The regression that made this worth asserting: the watched filename was spelled
  // out as "index.txt" and the store moved to index.jsonl, so nothing ever matched.
  const h = await startWatcher([]);
  try {
    await wait(SETTLE);
    assert.match(h.log(), /index\.jsonl/, 'the watcher reports the index it is watching');
  } finally {
    h.stop();
    await rm(h.root, { recursive: true, force: true });
  }
});
