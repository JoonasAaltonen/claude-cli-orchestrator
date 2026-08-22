/**
 * §8 — the guards, and D6's per-row dispatch state.
 *
 * These use a real temporary comms root, because the guards read append-only files
 * and folding those files is the behaviour under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { loadConfig } from '../src/config/load.js';
import type { Config } from '../src/config/load.js';
import { initCommsRoot, layout } from '../src/ledger/store.js';
import { checkGuards, recordChainBudget, readChainBudgets, chainSpend, killSwitchTripped } from '../src/guards/budget.js';
import { isDispatchable, readDispatchState, recordDispatch, stateOf } from '../src/dispatch/state.js';
import type { InvocationLogEntry } from '../src/log/invocations.js';
import { writeText } from '../src/util/fsx.js';
import { nowIso } from '../src/util/time.js';

let counter = 0;

/**
 * ConfigError carries its findings in `details`, not in `message`, because a config
 * can fail several cross-checks at once and the caller prints them as a list. So
 * asserting on the message alone would miss the thing under test.
 */
async function rejectsWith(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await fn();
  } catch (err: any) {
    const all = [err?.message, ...(err?.details ?? [])].join('\n');
    assert.match(all, pattern);
    return;
  }
  assert.fail(`expected a rejection matching ${pattern}`);
}

async function scratch(): Promise<Config> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `orch-test-${counter++}-`));
  const commsRoot = path.join(base, 'comms');
  const agentsRoot = path.join(base, 'agents');
  const configFile = path.join(base, 'orchestrator.config.json');

  for (const name of ['coordinator', 'worker']) {
    await fs.mkdir(path.join(agentsRoot, name, 'outbox'), { recursive: true });
    await writeText(path.join(agentsRoot, name, 'CLAUDE.md'), `# ${name}\n`);
  }
  await writeText(
    configFile,
    JSON.stringify({
      commsRoot,
      agents: [
        { name: 'coordinator', home: path.join(agentsRoot, 'coordinator') },
        { name: 'worker', home: path.join(agentsRoot, 'worker') },
      ],
    })
  );
  const config = await loadConfig(configFile);
  await initCommsRoot(config);
  return config;
}

function invocations(rootId: string, n: number, atMs = Date.now()): InvocationLogEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    invocationId: `i${i}`,
    agent: 'worker',
    rowIds: ['0001'],
    threadRootIds: [rootId],
    startedAt: new Date(atMs).toISOString(),
    endedAt: new Date(atMs).toISOString(),
    wallMs: 1000,
    costUsd: 0.01,
    numTurns: 2,
    // C6 — a failed invocation costs more than a successful one, so the caps below
    // must count these the same as successes.
    verdict: 'ran-nothing' as const,
    verdictWhy: '',
    cliReported: { exitCode: 0, signal: null, resultSubtype: 'success', isError: false, processOutcome: 'exited' },
    permissionDenials: [], finalText: null, rateLimitEvent: null,
    artefacts: [], rejected: [], skillsDiff: null,
    promptFile: '', promptChars: 0, promptTemplate: 'v1',
    eventCounts: {}, argv: [], cwd: '', stderr: '', dryRun: false,
  }));
}

test('C3: the kill switch outranks everything and is checked before every dispatch', async () => {
  const c = await scratch();
  const budgets = await readChainBudgets(c);
  assert.equal(await killSwitchTripped(c), null);
  assert.equal((await checkGuards(c, { rootId: '0001', budgets, log: [] })).allowed, true);

  await writeText(layout(c).kill, 'stopped by the operator\n2026-08-21T09:00:00Z\n');
  const v = await checkGuards(c, { rootId: '0001', budgets, log: [] });
  assert.equal(v.allowed, false);
  assert.equal(v.code, 'kill-switch');
  // The operator pulled it, so they do not need a row telling them they pulled it.
  assert.equal(v.escalate, false);
});

test('C3/M6: the kill reason is one line, because it reaches a Summary field', async () => {
  const c = await scratch();
  await writeText(layout(c).kill, 'because I said so; and also this\nsecond line\n');
  const reason = await killSwitchTripped(c);
  assert.ok(!reason!.includes('\n'));
  assert.ok(!reason!.includes(';'));
});

test('C1: the budget attaches to the chain, and at zero it stops and escalates', async () => {
  const c = await scratch();
  await recordChainBudget(c, {
    rootId: '0001', hopBudget: 3, invocationCeiling: 5,
    createdAt: nowIso(), createdBy: 'operator',
  });
  const budgets = await readChainBudgets(c);

  let v = await checkGuards(c, { rootId: '0001', budgets, log: invocations('0001', 2) });
  assert.equal(v.allowed, true, 'two of three hops used');

  v = await checkGuards(c, { rootId: '0001', budgets, log: invocations('0001', 3) });
  assert.equal(v.allowed, false);
  assert.equal(v.code, 'hop-budget');
  assert.equal(v.escalate, true, 'C1: write a row rather than asking for more');
});

test('C1: a chain budget cannot be quietly raised by writing a second record', async () => {
  const c = await scratch();
  await recordChainBudget(c, { rootId: '0001', hopBudget: 2, invocationCeiling: 2, createdAt: nowIso(), createdBy: 'operator' });
  await recordChainBudget(c, { rootId: '0001', hopBudget: 99, invocationCeiling: 99, createdAt: nowIso(), createdBy: 'operator' });
  const budgets = await readChainBudgets(c);
  assert.equal(budgets.get('0001')!.hopBudget, 2, 'first write wins');
});

test('C1: another chain spending its budget does not touch this one', async () => {
  const c = await scratch();
  const budgets = await readChainBudgets(c);
  const log = [...invocations('0009', 5)];
  const v = await checkGuards(c, { rootId: '0001', budgets, log });
  assert.equal(v.allowed, true, 'the budget attaches to the chain, not globally');
});

test('C2: the per-hour cap counts invocations, not successes (C6)', async () => {
  const c = await scratch();
  const budgets = await readChainBudgets(c);
  // Spread across chains so no chain budget trips first.
  const log = Array.from({ length: 30 }, (_, i) => invocations(`00${10 + i}`, 1)[0]!);
  const v = await checkGuards(c, { rootId: '0001', budgets, log });
  assert.equal(v.allowed, false);
  assert.equal(v.code, 'per-hour-cap');
  assert.equal(v.escalate, true, 'C2: stop, write a row to the operator, do not self-restart');
});

test('C2: invocations older than an hour do not count against the per-hour cap', async () => {
  const c = await scratch();
  const budgets = await readChainBudgets(c);
  const twoHoursAgo = Date.now() - 7_200_000;
  const log = Array.from({ length: 30 }, (_, i) => invocations(`00${10 + i}`, 1, twoHoursAgo)[0]!);
  assert.equal((await checkGuards(c, { rootId: '0001', budgets, log })).allowed, true);
});

test('C1: chainSpend reports what is left, which is what the prompt tells the agent', async () => {
  const c = await scratch();
  await recordChainBudget(c, { rootId: '0001', hopBudget: 8, invocationCeiling: 12, createdAt: nowIso(), createdBy: 'operator' });
  const s = chainSpend(c, '0001', await readChainBudgets(c), invocations('0001', 3));
  assert.equal(s.hopsRemaining, 5);
  assert.equal(s.invocationsRemaining, 9);
  assert.equal(s.exhausted, false);
});

test('D6: dispatch state is per (row, agent), so a partial batch failure is expressible', async () => {
  const c = await scratch();
  // One row addressed to two agents, dispatched together; one produced an artefact,
  // one produced nothing. A high-water cursor cannot express this, which is D6's point.
  await recordDispatch(c, { rowId: '0001', agent: 'worker', status: 'dispatched', invocationId: 'i1', at: nowIso() });
  await recordDispatch(c, { rowId: '0001', agent: 'coordinator', status: 'dispatched', invocationId: 'i1', at: nowIso() });
  await recordDispatch(c, { rowId: '0001', agent: 'worker', status: 'progressed', invocationId: 'i1', at: nowIso() });
  await recordDispatch(c, { rowId: '0001', agent: 'coordinator', status: 'failed', invocationId: 'i1', at: nowIso() });

  const states = await readDispatchState(c);
  assert.equal(stateOf(states, '0001', 'worker')!.consecutiveFailures, 0);
  assert.equal(stateOf(states, '0001', 'coordinator')!.consecutiveFailures, 1);
  // Both remain dispatchable as far as *state* is concerned. Whether either row is
  // answered is derived by replaying the ledger (L1), not stored here — recording it
  // here is what ended a live chain one hop short.
  assert.equal(isDispatchable(states, '0001', 'worker', 2).ok, true);
  assert.equal(isDispatchable(states, '0001', 'coordinator', 2).ok, true, 'one empty run, still retriable');
});

test('D6: producing an artefact resets the empty-run counter for that row', async () => {
  const c = await scratch();
  await recordDispatch(c, { rowId: '0007', agent: 'worker', status: 'failed', invocationId: 'i1', at: nowIso() });
  let states = await readDispatchState(c);
  assert.equal(stateOf(states, '0007', 'worker')!.consecutiveFailures, 1);

  await recordDispatch(c, { rowId: '0007', agent: 'worker', status: 'progressed', invocationId: 'i2', at: nowIso() });
  states = await readDispatchState(c);
  assert.equal(stateOf(states, '0007', 'worker')!.consecutiveFailures, 0, 'a row making progress is not a runaway');
  assert.equal(isDispatchable(states, '0007', 'worker', 2).ok, true);
});

test('D6: a restart does not replay history — state survives a fresh process', async () => {
  const c = await scratch();
  await recordDispatch(c, { rowId: '0002', agent: 'worker', status: 'dispatched', invocationId: 'i1', at: nowIso() });
  await recordDispatch(c, { rowId: '0002', agent: 'worker', status: 'escalated', invocationId: 'i1', at: nowIso(), note: 'gave up' });
  // Re-read from disk, exactly as a fresh process would.
  const states = await readDispatchState(await loadConfig(c.configFile));
  const check = isDispatchable(states, '0002', 'worker', 2);
  assert.equal(check.ok, false);
  assert.ok(check.reason.includes('gave up'), 'the reason survives the restart too');
});

test('D6: the legacy "handled" spelling is still read, so an existing ledger keeps working', async () => {
  const c = await scratch();
  await recordDispatch(c, { rowId: '0008', agent: 'worker', status: 'failed', invocationId: 'i1', at: nowIso() });
  await recordDispatch(c, { rowId: '0008', agent: 'worker', status: 'handled', invocationId: 'i2', at: nowIso() });
  const states = await readDispatchState(c);
  assert.equal(stateOf(states, '0008', 'worker')!.consecutiveFailures, 0, 'read as progressed');
});

test('C6: attempts are capped, so a loop of denials cannot run away', async () => {
  const c = await scratch();
  for (let i = 0; i < 2; i++) {
    await recordDispatch(c, { rowId: '0003', agent: 'worker', status: 'dispatched', invocationId: `i${i}`, at: nowIso() });
    await recordDispatch(c, { rowId: '0003', agent: 'worker', status: 'failed', invocationId: `i${i}`, at: nowIso() });
  }
  const states = await readDispatchState(c);
  const check = isDispatchable(states, '0003', 'worker', 2);
  assert.equal(check.ok, false);
  assert.ok(check.reason.includes('ceiling'));
  assert.ok(check.reason.includes('produced nothing'));
});

test('P2/J3: a row queued for manual relay is never dispatched', async () => {
  const c = await scratch();
  await recordDispatch(c, { rowId: '0004', agent: 'coordinator', status: 'manual-relay', invocationId: null, at: nowIso() });
  const states = await readDispatchState(c);
  assert.equal(isDispatchable(states, '0004', 'coordinator', 2).ok, false);
});

test('D6/T5: dispatch state is case-insensitive on the agent name', async () => {
  const c = await scratch();
  await recordDispatch(c, { rowId: '0005', agent: 'Worker', status: 'escalated', invocationId: 'i1', at: nowIso() });
  const states = await readDispatchState(c);
  assert.equal(isDispatchable(states, '0005', 'worker', 2).ok, false, 'two spellings must not become two states');
});

test('T2: a comms root inside the repository is refused at load', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-t2-'));
  const configFile = path.join(base, 'orchestrator.config.json');
  const repoRoot = path.resolve(import.meta.dirname, '..');
  await writeText(configFile, JSON.stringify({ commsRoot: path.join(repoRoot, 'comms'), agents: [] }));
  await rejectsWith(() => loadConfig(configFile), /T2/);
});

test('P4: the orchestrator directory cannot be added to the roster', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-p4-'));
  const configFile = path.join(base, 'orchestrator.config.json');
  const repoRoot = path.resolve(import.meta.dirname, '..');
  await writeText(
    configFile,
    JSON.stringify({
      commsRoot: path.join(base, 'comms'),
      agents: [{ name: 'self', home: repoRoot }],
    })
  );
  await rejectsWith(() => loadConfig(configFile), /P4/);
});

test('T5: two spellings of one directory are refused as two agents', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-t5-'));
  const configFile = path.join(base, 'orchestrator.config.json');
  const home = path.join(base, 'agents', 'worker');
  await fs.mkdir(home, { recursive: true });
  await writeText(
    configFile,
    JSON.stringify({
      commsRoot: path.join(base, 'comms'),
      agents: [
        { name: 'a', home },
        { name: 'b', home: path.join(base, 'agents', '.', 'worker') },
      ],
    })
  );
  await rejectsWith(() => loadConfig(configFile), /same directory/);
});

test('N1: a non-loopback bind address is refused', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-n1-'));
  const configFile = path.join(base, 'orchestrator.config.json');
  await writeText(
    configFile,
    JSON.stringify({ commsRoot: path.join(base, 'comms'), agents: [], ports: { bindAddress: '0.0.0.0' } })
  );
  // Rejected by the schema enumeration, before the cross-check even runs.
  await assert.rejects(() => loadConfig(configFile));
});
