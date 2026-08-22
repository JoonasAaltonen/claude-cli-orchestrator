#!/usr/bin/env node
/**
 * The command surface.
 *
 * C5 — "Manual dispatch before any watcher. A `dispatch <agent>` command run by
 * hand: read pending rows, build the prompt, invoke, sweep, validate, append.
 * Everything observable, nothing able to run away. The watcher is the component
 * that converts a controllable system into an unattended one, so it goes in last,
 * after the guards have been seen working."
 *
 * Ordering below follows §11, and `watch` prints that warning when it starts.
 */
import { Command } from 'commander';
import process from 'node:process';
import { loadConfig, findAgent, ConfigError } from '../config/load.js';
import type { Config } from '../config/load.js';
import { readIndex, layout, appendRow, initCommsRoot, migrateIndex } from '../ledger/store.js';
import { writeStatusFile } from '../ledger/status-file.js';
import { withWriterLock, WriterLockHeld } from '../ledger/lock.js';
import { fold, awaiting } from '../ledger/fold.js';
import { OPERATOR, MESSAGE_TYPES, OUTCOMES } from '../ledger/row.js';
import type { MessageType, Outcome } from '../ledger/row.js';
import { dispatchOnce, runUntilQuiescent } from '../dispatch/run.js';
import type { DispatchOutcome } from '../dispatch/run.js';
import { sweepOutbox } from '../dispatch/sweep.js';
import { readDispatchState } from '../dispatch/state.js';
import { recordChainBudget, killSwitchTripped, chainSpend, readChainBudgets } from '../guards/budget.js';
import { readInvocationLog } from '../log/invocations.js';
import { runDoctor } from './doctor.js';
import { runInit } from './init.js';
import { runUi } from './ui.js';
import { runAgentAdd, runAgentList, runAgentRemove, runAgentProtocol, runAgentSkills } from './agents.js';
import { runProbe } from './probe.js';
import { runProbeSlash } from './probe-slash.js';
import { runProbeContract } from './probe-contract.js';
import { runWatch } from './watch.js';
import {
  renderStatus, renderInbox, renderThread, renderCost, renderWall,
  heading, bold, dim, red, green, yellow, verdictBadge, rowLine,
} from './render.js';
import { readTextIfExists, writeText, exists } from '../util/fsx.js';
import { nowIso } from '../util/time.js';

const program = new Command();

program
  .name('orchestrator')
  .description('Local multi-agent orchestrator and append-only communications ledger for Claude Code agents.')
  .option('-c, --config <file>', 'path to the configuration file (default: orchestrator.config.json, or $ORCHESTRATOR_CONFIG)')
  .showHelpAfterError();

async function cfg(): Promise<Config> {
  const opts = program.opts<{ config?: string }>();
  const c = await loadConfig(opts.config);
  for (const w of c.warnings) console.error(`${yellow('warning')} ${w}`);
  return c;
}

async function currentFold(c: Config) {
  const { rows, bad } = await readIndex(c);
  for (const b of bad) {
    console.error(`${red('index line ' + b.lineNumber)} ${b.errors.join('; ')}`);
  }
  return fold(rows, {
    staleThreadDays: c.staleThreadDays,
    maxRejectionsPerThread: c.maxRejectionsPerThread,
    decisionsDigestLimit: c.decisionsDigestLimit,
  });
}

// ---------------------------------------------------------------- §11 step 0

program
  .command('init')
  .description('Create the comms root and a configuration file with an empty roster')
  .option('--comms-root <dir>', 'where the ledger lives (T1/T2: its own directory, outside every agent home and outside this repo)')
  .option('--force', 'overwrite an existing configuration file')
  .action(async (opts) => {
    await runInit({
      configPath: program.opts<{ config?: string }>().config,
      commsRoot: opts.commsRoot,
      force: !!opts.force,
    });
  });

// The roster. This tool ships no agents — `add` registers a directory that already
// exists rather than creating one, which is the direction P1 actually reads in.
const agentCmd = program.command('agent').description('Manage the roster of agent directories');

agentCmd
  .command('add')
  .description('Register an existing agent directory')
  .argument('<name>', 'roster name, also the Writer on every row it produces')
  .requiredOption('--home <dir>', 'the directory the agent lives in — its CLAUDE.md is loaded from here')
  .option('--description <text>', 'for your benefit; never shown to agents')
  .option('--model <model>', 'per-agent model override')
  .option('--dispatch-excluded', 'P2 — set this for any directory you work in interactively')
  .option('--shell-allowed', 'X2 — makes its file boundaries advisory, and denies skill-write (X3a)')
  .option('--allow-mcp', 'X3 — .mcp.json entries start processes without an approval step')
  .option('--allow-subagents', 'X3 — subagent definitions carry their own tool grants')
  .option('--read-path <dir...>', 'X4 — directories it may read but never write')
  .option('--write-protocol', 'install the protocol file, a one-line CLAUDE.md pointer, and the ledger skills')
  .action(async (name: string, opts) => {
    process.exitCode = await runAgentAdd(await cfg(), {
      name,
      home: opts.home,
      description: opts.description,
      model: opts.model,
      dispatchExcluded: !!opts.dispatchExcluded,
      shellAllowed: !!opts.shellAllowed,
      allowMcp: !!opts.allowMcp,
      allowSubagents: !!opts.allowSubagents,
      readPaths: opts.readPath ?? [],
      writeProtocol: !!opts.writeProtocol,
    });
  });

agentCmd
  .command('list')
  .description('Show the roster, and whether each agent knows the ledger protocol')
  .action(async () => {
    process.exitCode = await runAgentList(await cfg());
  });

agentCmd
  .command('remove')
  .description('Remove an agent from the roster. Its directory is not touched.')
  .argument('<name>')
  .action(async (name: string) => {
    process.exitCode = await runAgentRemove(await cfg(), name);
  });

agentCmd
  .command('protocol')
  .description('Print the agent protocol, show where it is installed, or install it')
  .argument('[name]', 'an agent to inspect or install into; omit to print the text')
  .option('--install', 'write the protocol file into the agent directory and point CLAUDE.md at it')
  .option('--all', 'apply to every agent in the roster — the update path after pulling a new version')
  .action(async (name: string | undefined, opts) => {
    process.exitCode = await runAgentProtocol(await cfg(), name, {
      install: !!opts.install,
      all: !!opts.all,
    });
  });

agentCmd
  .command('skills')
  .description('Show or install the ledger skill that dispatch enters. Agents\' own skills are never touched.')
  .argument('[name]', 'an agent to inspect or install into; omit and pass --all for every agent')
  .option('--install', 'write the skill into the agent directory')
  .option('--all', 'apply to every agent in the roster — the update path after pulling a new version')
  .action(async (name: string | undefined, opts) => {
    process.exitCode = await runAgentSkills(await cfg(), name, {
      install: !!opts.install,
      all: !!opts.all,
    });
  });

program
  .command('migrate-index')
  .description('Convert a pre-NDJSON index.txt into index.jsonl. The old file is left untouched.')
  .action(async () => {
    const c = await cfg();
    try {
      const r = await migrateIndex(c);
      if (r.alreadyDone) {
        console.log(dim(`No legacy index at ${r.from} — nothing to migrate.`));
        return;
      }
      console.log(`${green('migrated')} ${r.migrated} row(s)`);
      console.log(dim(`  from ${r.from}`));
      console.log(dim(`  to   ${r.to}`));
      for (const s of r.skipped) console.log(`  ${yellow('skipped')} ${s}`);
      console.log(dim('\n  The old file is untouched (L1). Delete it by hand once you are satisfied.'));
    } catch (err: any) {
      console.error(red(err?.message ?? String(err)));
      process.exitCode = 1;
    }
  });

program
  .command('doctor')
  .description('Check the configuration, the paths, the roster, the prompt template, and the installed CLI flags (F3)')
  .option('--fix-hooks-audit', 'record the current permission-hook audit result into the config (P3)')
  .action(async (opts) => {
    const code = await runDoctor(await cfg(), { fixHooksAudit: !!opts.fixHooksAudit });
    process.exitCode = code;
  });

// ---------------------------------------------------------------- §11 step 1

program
  .command('ledger')
  .description('Print the index')
  .option('--thread <id>', 'show one thread, root-first')
  .option('--raw', 'print the index file verbatim')
  .action(async (opts) => {
    const c = await cfg();
    if (opts.raw) {
      console.log((await readTextIfExists(layout(c).index)) ?? '(no index yet)');
      return;
    }
    const f = await currentFold(c);
    if (opts.thread) {
      const t = f.threadOf.get(String(opts.thread).padStart(4, '0'));
      if (!t) {
        console.error(red(`No thread contains row ${opts.thread}.`));
        process.exitCode = 1;
        return;
      }
      console.log(renderThread(t));
      return;
    }
    if (!f.rows.length) {
      console.log(dim('The ledger is empty. Write the first row with `orchestrator write`.'));
      return;
    }
    console.log(heading(`Ledger — ${f.rows.length} row(s)`));
    for (const r of f.rows) console.log('  ' + rowLine(r).replace(/\n/g, '\n  '));
  });

program
  .command('status')
  .description('L6 — open-thread status and the recent-decisions digest. Also rewrites status.md, the copy agents read.')
  .action(async () => {
    const c = await cfg();
    console.log(renderStatus(c, await currentFold(c)));

    // Normally written by `appendRow`, so this only matters when the file has been
    // deleted or predates the feature. Cheap, and it makes `status` the one command
    // that always repairs it.
    const { rows } = await readIndex(c);
    await writeStatusFile(c, rows);
    console.log(dim(`\n  status.md refreshed — ${layout(c).statusFile}`));
    console.log(dim('  Agents have no shell (X1); that file is how they read the fold.'));

    const kill = await killSwitchTripped(c);
    if (kill !== null) {
      console.log(heading('Kill switch'));
      console.log(`  ${red('SET')} ${layout(c).kill} — ${kill}`);
      console.log(dim('  Nothing will be dispatched until this file is removed (C3).'));
    }
  });

// J2 — "a way to write a row without hand-editing the index. If that is awkward
// they will stop using it, and the audit trail acquires a hole exactly where the
// authority sits."
program
  .command('write')
  .description('J1/J2 — write a row to the ledger as the operator')
  .requiredOption('--to <names>', 'recipient(s), + separated')
  .option('--type <type>', `one of: ${MESSAGE_TYPES.join(', ')}`, 'request')
  .requiredOption('--summary <text>', 'one line, no semicolons')
  .option('--body <text>', 'the message body')
  .option('--body-file <file>', 'read the body from a file')
  .option('--reply-to <id>', 'the row this answers')
  .option('--needs <names>', 'agents whose sign-off is required, + separated (M2: leave blank unless it crosses a publication boundary)')
  .option('--outcome <outcome>', `on response/signoff only: ${OUTCOMES.join(', ')}`)
  .option('--hop-budget <n>', 'C1 — hops this chain may spend (new chains only)')
  .option('--invocation-ceiling <n>', 'C1 — invocations this chain may spend (new chains only)')
  .action(async (opts) => {
    const c = await cfg();
    await initCommsRoot(c);

    let body = opts.body ?? '';
    if (opts.bodyFile) {
      const t = await readTextIfExists(opts.bodyFile);
      if (t === null) {
        console.error(red(`No such file: ${opts.bodyFile}`));
        process.exitCode = 1;
        return;
      }
      body = t;
    }
    if (!body.trim()) {
      // L3 — the index row is an address label; the substance lives in the file.
      body = opts.summary;
    }

    try {
      const written = await locked(c, 'write', () => appendRow(c, {
        writer: OPERATOR,
        draft: {
          to: String(opts.to).split('+').map((s: string) => s.trim()).filter(Boolean),
          type: opts.type as MessageType,
          replyTo: opts.replyTo ? String(opts.replyTo).padStart(4, '0') : null,
          needs: opts.needs ? String(opts.needs).split('+').map((s: string) => s.trim()).filter(Boolean) : [],
          outcome: (opts.outcome ?? null) as Outcome | null,
          summary: String(opts.summary),
          body,
        },
      }));
      if (!written) return;
      const { row, messageFile } = written;

      // C1 — "A request carries a hop count and an invocation ceiling when created."
      if (!row.replyTo) {
        await recordChainBudget(c, {
          rootId: row.id,
          hopBudget: opts.hopBudget ? Number(opts.hopBudget) : c.defaults.hopBudget,
          invocationCeiling: opts.invocationCeiling ? Number(opts.invocationCeiling) : c.defaults.invocationCeiling,
          createdAt: nowIso(),
          createdBy: OPERATOR,
        });
      }

      console.log(`${green('appended')} ${bold(row.id)}  ${row.summary}`);
      console.log(dim(`  ${messageFile}`));
      if (!row.replyTo) {
        const budgets = await readChainBudgets(c);
        const b = budgets.get(row.id)!;
        console.log(dim(`  chain budget: ${b.hopBudget} hop(s), ${b.invocationCeiling} invocation(s) (C1)`));
      }
      console.log(dim(`  next: orchestrator run --dry-run`));
    } catch (err: any) {
      console.error(red(err?.message ?? String(err)));
      process.exitCode = 1;
    }
  });

program
  .command('inbox')
  .description('J2 — a filtered view of what is waiting on you')
  .option('--for <who>', 'whose inbox', OPERATOR)
  .action(async (opts) => {
    const c = await cfg();
    const f = await currentFold(c);
    console.log(renderInbox(String(opts.for), awaiting(f, String(opts.for)), f));
  });

// J3/P2 — "Rows addressed to a dispatch-excluded agent queue for manual relay."
program
  .command('relay')
  .description('P2/J3 — rows queued for manual relay to a dispatch-excluded agent')
  .action(async () => {
    const c = await cfg();
    const f = await currentFold(c);
    const states = await readDispatchState(c);
    const excluded = c.agents.filter((a) => a.dispatchExcluded);

    console.log(heading('Manual relay queue'));
    if (!excluded.length) {
      console.log(dim('  No agent is dispatch-excluded (P2).'));
      return;
    }
    for (const a of excluded) {
      const items = awaiting(f, a.name);
      console.log(`  ${bold(a.name)} ${dim(a.home)}`);
      if (!items.length) {
        console.log(dim('    nothing queued'));
        continue;
      }
      console.log(dim('    A human has a live session in this directory; starting a second instance there is a collision (P2).'));
      for (const o of items) {
        const s = states.get(`${o.row.id} ${a.name.toLowerCase()}`);
        console.log(`    ${bold(o.row.id)} from ${o.row.writer}: ${o.row.summary}${s ? dim(`  [${s.status}]`) : ''}`);
        if (o.row.ref) console.log(dim(`      ${o.row.ref}`));
      }
    }
  });

program
  .command('sweep')
  .description('L5/M7 — sweep agent outboxes, validate, and append valid rows')
  .argument('[agent]', 'one agent, or all of them')
  .action(async (agentName?: string) => {
    const c = await cfg();
    const targets = agentName
      ? [findAgent(c, agentName)].filter(Boolean)
      : c.agents;
    if (!targets.length) {
      console.error(red(agentName ? `"${agentName}" is not in the roster.` : 'The roster is empty.'));
      process.exitCode = 1;
      return;
    }
    const swept = await locked(c, agentName ? `sweep ${agentName}` : 'sweep', async () => {
      const out = [];
      for (const a of targets) out.push({ a: a!, r: await sweepOutbox(c, a!) });
      return out;
    });
    if (!swept) return;
    for (const { a, r } of swept) {
      console.log(`${bold(a.name)} ${dim(a.outbox)}`);
      for (const acc of r.accepted) console.log(`  ${green('appended')} ${acc.row.id}  ${acc.row.summary}`);
      for (const rej of r.rejected) {
        console.log(`  ${red('rejected')} ${rej.file}`);
        for (const e of rej.errors) console.log(`    ${e}`);
        console.log(dim(`    preserved at ${rej.preservedAt}`));
      }
      for (const ig of r.ignored) console.log(dim(`  ignored (not a .md file) ${ig}`));
      if (!r.accepted.length && !r.rejected.length && !r.ignored.length) console.log(dim('  outbox empty'));
    }
  });

/**
 * Wraps a writing command in the cross-process writer lock.
 *
 * Read-only commands are deliberately outside it: `status`, `ledger` and `inbox`
 * must stay usable while a run is in progress, which is exactly when you want to
 * look. Only the four that append rows or dispatch contend.
 */
async function locked<T>(c: Config, who: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await withWriterLock(c, who, fn);
  } catch (err: unknown) {
    if (err instanceof WriterLockHeld) {
      console.error(red(err.message));
      process.exitCode = 1;
      return undefined;
    }
    throw err;
  }
}

// ---------------------------------------------------------------- §11 step 2

program
  .command('dispatch')
  .description('C5 — manual dispatch: read pending rows, build the prompt, invoke, sweep, validate, append')
  .argument('<agent>')
  .option('-n, --dry-run', 'C4 — print what would be sent; spend nothing')
  .action(async (agentName: string, opts) => {
    const c = await cfg();
    const outcome = await locked(c, `dispatch ${agentName}`, () =>
      dispatchOnce(c, agentName, { dryRun: !!opts.dryRun, onLog: (l) => console.log(l) })
    );
    if (!outcome) return;
    printOutcome(outcome, !!opts.dryRun);
  });

program
  .command('run')
  .description('D7 — drive the chain serially until nothing is outstanding')
  .option('-n, --dry-run', 'C4 — print the first prompt that would be sent; spend nothing')
  .option('--sweep', 'sweep every outbox first, adopting notes agents left from their own interactive sessions')
  .option('--max-iterations <n>', 'safety ceiling on loop iterations', '25')
  .action(async (opts) => {
    const c = await cfg();
    const outcomes = await locked(c, opts.sweep ? 'run --sweep' : 'run', () =>
      runUntilQuiescent(c, {
        dryRun: !!opts.dryRun,
        sweepFirst: !!opts.sweep,
        maxIterations: Number(opts.maxIterations),
        onLog: (l) => console.log(l),
      })
    );
    if (!outcomes) return;
    for (const o of outcomes) printOutcome(o, !!opts.dryRun);

    if (!opts.dryRun && outcomes.length) {
      const spent = outcomes.reduce((n, o) => n + (o.costUsd ?? 0), 0);
      console.log(heading('Run summary'));
      console.log(`  ${outcomes.length} invocation(s), ${renderCost(spent)} ${dim('(client-side estimate, §14)')}`);
    }
  });

// ---------------------------------------------------------------- §11 step 3

program
  .command('log')
  .description('D12 — the invocation log')
  .option('--last <n>', 'how many entries', '20')
  .option('--json', 'print raw entries')
  .action(async (opts) => {
    const c = await cfg();
    const entries = (await readInvocationLog(c)).slice(-Number(opts.last));
    if (opts.json) {
      for (const e of entries) console.log(JSON.stringify(e));
      return;
    }
    console.log(heading(`Invocations — last ${entries.length}`));
    if (!entries.length) console.log(dim('  none yet'));
    for (const e of entries) {
      console.log(`  ${dim(e.startedAt.slice(0, 19).replace('T', ' '))} ${bold(e.agent)} ${verdictBadge(e.verdict)}`);
      console.log(`     rows ${e.rowIds.join(', ') || '—'}  ${renderWall(e.wallMs)}  ${renderCost(e.costUsd)}  ${e.numTurns ?? '?'} turn(s)`);
      console.log(dim(`     ${e.verdictWhy}`));
      // V1 — recorded, and deliberately shown next to the verdict so the gap
      // between "the CLI said success" and "nothing happened" stays visible.
      console.log(dim(`     CLI reported: exit ${e.cliReported.exitCode}, subtype ${e.cliReported.resultSubtype}, is_error ${e.cliReported.isError}`));
      if (e.permissionDenials.length) {
        for (const d of e.permissionDenials) {
          console.log(`     ${yellow('denied')} ${d.toolName} ${dim(JSON.stringify(d.toolInput).slice(0, 200))}`);
        }
      }
      if (e.skillsDiff?.any) {
        console.log(`     ${yellow('D13')} skills/commands changed: +${e.skillsDiff.added.length} ~${e.skillsDiff.changed.length} -${e.skillsDiff.removed.length}`);
      }
      console.log(dim(`     prompt: ${e.promptFile}`));
    }
  });

program
  .command('budget')
  .description('C1/C2 — what each chain has left')
  .action(async () => {
    const c = await cfg();
    const f = await currentFold(c);
    const budgets = await readChainBudgets(c);
    const log = await readInvocationLog(c);
    console.log(heading('Chain budgets'));
    if (!f.threads.length) console.log(dim('  no chains yet'));
    for (const t of f.threads) {
      const s = chainSpend(c, t.rootId, budgets, log);
      const flag = s.exhausted ? red('exhausted') : green('ok');
      console.log(`  ${bold(t.rootId)} ${flag}  hops ${s.hopsUsed}/${s.hopBudget}  invocations ${s.invocationsUsed}/${s.invocationCeiling}`);
      console.log(dim(`     ${t.rows[0]!.summary}`));
    }
    console.log(heading('Global caps (C2)'));
    const lastHour = log.filter((e) => Date.now() - Date.parse(e.startedAt) < 3_600_000).length;
    console.log(`  ${lastHour}/${c.caps.perHourInvocations} invocations in the last hour`);
    console.log(`  per-thread cap: ${c.caps.perThreadInvocations}`);
  });

program
  .command('stop')
  .description('C3 — set the kill switch. Nothing is dispatched until it is cleared.')
  .argument('[reason]', 'why', 'stopped by the operator')
  .action(async (reason: string) => {
    const c = await cfg();
    await initCommsRoot(c);
    await writeText(layout(c).kill, `${reason}\n${nowIso()}\n`);
    console.log(`${red('kill switch set')} ${layout(c).kill}`);
    console.log(dim('  Checked before every dispatch, and polled during one (C3).'));
  });

program
  .command('resume')
  .description('C3 — clear the kill switch')
  .action(async () => {
    const c = await cfg();
    const file = layout(c).kill;
    if (!(await exists(file))) {
      console.log(dim('The kill switch was not set.'));
      return;
    }
    const { unlink } = await import('node:fs/promises');
    await unlink(file);
    console.log(`${green('kill switch cleared')} ${file}`);
  });

program
  .command('probe')
  .description('§14 — verify the CLI honours an external working directory and that the deny rules hold. One live invocation.')
  .argument('[agent]', 'which agent directory to probe')
  .option('-y, --yes', 'skip the confirmation')
  .action(async (agentName: string | undefined, opts) => {
    const code = await runProbe(await cfg(), { agentName, yes: !!opts.yes });
    process.exitCode = code;
  });

program
  .command('probe-contract')
  .description('Run the real skill + MCP path against a made-up job and read the outbox. One live invocation; the ledger is not touched.')
  .argument('[agent]', 'which agent to probe')
  .option('-y, --yes', 'skip the confirmation')
  .action(async (agentName: string | undefined, opts) => {
    process.exitCode = await runProbeContract(await cfg(), { agentName, yes: !!opts.yes });
  });

program
  .command('probe-slash')
  .description('Establish whether a slash command resolves in a --print run, and whether the file behind it is read. Up to three small invocations.')
  .argument('[agent]', 'which agent directory to probe')
  .option('-y, --yes', 'skip the confirmation')
  .action(async (agentName: string | undefined, opts) => {
    const code = await runProbeSlash(await cfg(), { agentName, yes: !!opts.yes });
    process.exitCode = code;
  });

// ---------------------------------------------------------------- §11 step 4

program
  .command('watch')
  .description('D4 — watch outboxes for writes the application did not cause, then dispatch. Built last, on purpose (C5).')
  .option('-n, --dry-run', 'C4 — report what would be dispatched; spend nothing')
  .option('--outboxes', 'also watch agent outboxes, for notes agents leave from their own interactive sessions')
  .action(async (opts) => {
    await runWatch(await cfg(), { dryRun: !!opts.dryRun, outboxes: !!opts.outboxes });
  });

// ------------------------------------------------- the operator dashboard (J2)

program
  .command('ui')
  .description('Serve the operator dashboard on loopback. The URL is stable — bookmark it.')
  .option('--port <n>', 'override ports.operatorView', (v) => Number.parseInt(v, 10))
  .option('--open', 'launch a browser at it, so a shortcut needs no URL')
  .option('--new-token', 'mint a fresh token; every existing bookmark stops working')
  .action(async (opts) => {
    process.exitCode = await runUi(await cfg(), {
      port: opts.port,
      open: !!opts.open,
      newToken: !!opts.newToken,
    });
  });

function printOutcome(o: DispatchOutcome, _dryRun: boolean): void {
  if (o.dryRunPlan) {
    const p = o.dryRunPlan;
    console.log(heading(`Dry run — ${o.agent}`));
    console.log(`${bold('working directory')}  ${p.cwd}   ${dim('(D2 — so it loads its own CLAUDE.md)')}`);
    console.log(`${bold('settings file')}      ${p.settingsFile}   ${dim('(X6 — declared where the agent lives)')}`);
    console.log(`\n${bold('argv')}`);
    console.log('  ' + p.argv.map(quoteForDisplay).join(' \\\n  '));
    console.log(`\n${bold('boundaries')}`);
    for (const r of p.permissions.rationale) console.log(`  · ${r}`);
    console.log(`\n${bold('deny rules')}`);
    for (const d of p.permissions.settings.permissions.deny) console.log(`  ${red('deny')}  ${d}`);
    console.log(`\n${bold('prompt')} ${dim(`(${p.prompt.length} characters, delivered on stdin)`)}`);
    console.log(dim('─'.repeat(72)));
    console.log(p.prompt);
    console.log(dim('─'.repeat(72)));
    console.log(`\n${yellow('Nothing was invoked and nothing was spent (C4).')}`);
    return;
  }

  if (o.skipped) {
    console.log(`${bold(o.agent)} ${dim('skipped')} — ${o.skipReason}`);
    return;
  }

  console.log(`\n${bold(o.agent)} ${verdictBadge(o.verdict ?? 'unknown')}  ${renderWall(o.wallMs)}  ${renderCost(o.costUsd)}`);
  console.log(`  rows dispatched: ${o.rowIds.join(', ')}`);
  if (o.produced.length) console.log(`  ${green('appended')}: ${o.produced.join(', ')}`);
  if (o.rejected) console.log(`  ${red(`${o.rejected} file(s) rejected and bounced (M7)`)}`);
  if (o.stopChain) console.log(`  ${red('chain stopped')}: ${o.stopReason}`);
}

/** Display only — nothing in this application hands a path to a shell (T5). */
function quoteForDisplay(a: string): string {
  return /[\s"]/.test(a) ? JSON.stringify(a) : a;
}

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof ConfigError) {
    console.error(`${red('configuration error')} ${err.message}`);
    for (const d of err.details) console.error(`  ${d}`);
    process.exit(2);
  }
  console.error(`${red('error')} ${err?.stack ?? err?.message ?? String(err)}`);
  process.exit(1);
});
