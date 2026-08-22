/**
 * A chain whose first row was written by an agent during an *interactive* session,
 * before the orchestrator was running at all.
 *
 * The requirements assume every chain starts with the operator: C1 records a budget
 * "when a request is created", D4 justifies the watcher as existing solely for "the
 * operator writing a row by hand", and §13b's acceptance chain opens with an operator
 * row. None of them anticipate an agent, mid-conversation with a human, noticing that
 * a file another agent owns needs updating and leaving a message about it.
 *
 * Nothing was built for that. These assert what the existing pieces already do, so
 * the answer is measured rather than reasoned about — and so the parts that only work
 * by coincidence are pinned before something quietly changes them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/load.js';
import type { Config } from '../src/config/load.js';
import { sweepOutbox } from '../src/dispatch/sweep.js';
import { readIndex } from '../src/ledger/store.js';
import { fold, awaiting } from '../src/ledger/fold.js';
import { chainSpend } from '../src/guards/budget.js';
import { runUntilQuiescent } from '../src/dispatch/run.js';

interface Fixture {
  root: string;
  config: Config;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'orch-interactive-'));
  const comms = path.join(root, 'comms');
  await mkdir(comms, { recursive: true });

  const agents: { name: string; home: string }[] = [];
  for (const name of ['coordinator', 'archivist']) {
    const home = path.join(root, 'agents', name);
    await mkdir(path.join(home, 'outbox'), { recursive: true });
    await writeFile(path.join(home, 'CLAUDE.md'), `# ${name}\n`);
    agents.push({ name, home });
  }

  const configFile = path.join(root, 'orchestrator.config.json');
  await writeFile(configFile, JSON.stringify({ commsRoot: comms, agents }, null, 2));
  return { root, config: await loadConfig(configFile) };
}

/** Exactly what an agent would leave behind mid-conversation. Nothing else involved. */
async function dropInOutbox(config: Config, agentName: string, text: string): Promise<void> {
  const agent = config.agents.find((a) => a.name === agentName)!;
  await writeFile(path.join(agent.outbox, 'note-to-archivist.md'), text);
}

test('an agent can open a chain from an interactive session, and the sweep adopts it', async () => {
  const f = await fixture();
  try {
    await dropInOutbox(
      f.config,
      'coordinator',
      [
        '---',
        'to: archivist',
        'type: request',
        'summary: The Q3 rollup you own is out of date; the revenue line moved',
        '---',
        '',
        'While working through something else with the operator I noticed the revenue',
        'figure in your rollup no longer matches. Please reconcile it.',
      ].join('\n')
    );

    const result = await sweepOutbox(f.config, f.config.agents.find((a) => a.name === 'coordinator')!);
    assert.equal(result.rejected.length, 0, result.rejected.map((r) => r.errors.join('; ')).join(' | '));
    assert.equal(result.accepted.length, 1);

    const row = result.accepted[0]!.row;
    assert.equal(row.id, '0001', 'it opens the chain rather than joining one');
    assert.equal(row.replyTo, null);

    // The property that makes this safe: `Writer` comes from which outbox the file
    // was found in, never from a field. An interactive agent cannot sign as anyone
    // else, exactly as a dispatched one cannot.
    assert.equal(row.writer, 'coordinator');
    assert.deepEqual(row.to, ['archivist']);

    // And the outbox is left clean, so a second sweep cannot append it twice.
    const agent = f.config.agents.find((a) => a.name === 'coordinator')!;
    assert.deepEqual(await readdir(agent.outbox), []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('the addressee is then pending, so `run` would dispatch it with no operator row anywhere', async () => {
  const f = await fixture();
  try {
    await dropInOutbox(
      f.config,
      'coordinator',
      '---\nto: archivist\ntype: request\nsummary: Reconcile the Q3 rollup\n---\n\nThe revenue figure moved.\n'
    );
    await sweepOutbox(f.config, f.config.agents.find((a) => a.name === 'coordinator')!);

    const { rows } = await readIndex(f.config);
    const folded = fold(rows, { staleThreadDays: 3, maxRejectionsPerThread: 2, decisionsDigestLimit: 15 });

    const forArchivist = awaiting(folded, 'archivist');
    assert.equal(forArchivist.length, 1, 'the addressee has work waiting');
    assert.equal(forArchivist[0]!.row.writer, 'coordinator');

    // D3 — and it is not waiting on the agent that wrote it.
    assert.equal(awaiting(folded, 'coordinator').length, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('C1: a chain nobody recorded a budget for still gets one, from the defaults', async () => {
  // C1 says the budget is recorded when a request is created, and only `write` does
  // that — an agent-opened chain has no record. The cap must still bind, or an
  // interactive-origin chain would be the one path with no ceiling on it.
  const f = await fixture();
  try {
    await dropInOutbox(
      f.config,
      'coordinator',
      '---\nto: archivist\ntype: request\nsummary: Reconcile the Q3 rollup\n---\n\nThe revenue figure moved.\n'
    );
    await sweepOutbox(f.config, f.config.agents.find((a) => a.name === 'coordinator')!);

    // An empty budget map is precisely the state an agent-opened chain leaves behind:
    // nothing called recordChainBudget, because only `write` does.
    const spend = chainSpend(f.config, '0001', new Map(), []);
    assert.equal(spend.hopBudget, f.config.defaults.hopBudget);
    assert.equal(spend.invocationCeiling, f.config.defaults.invocationCeiling);
    assert.ok(spend.hopsRemaining > 0);
    assert.equal(spend.exhausted, false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('M7 still applies: a malformed note is bounced back to the agent that left it', async () => {
  const f = await fixture();
  try {
    await dropInOutbox(f.config, 'coordinator', 'Just a note to self, no frontmatter.\n');
    const result = await sweepOutbox(f.config, f.config.agents.find((a) => a.name === 'coordinator')!);

    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected.length, 1);
    // The bounce is a ledger row addressed to the author, so it surfaces on that
    // agent's next cold invocation rather than being lost with the session.
    assert.equal(result.rejected[0]!.bounceRow?.to[0], 'coordinator');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// ---- the pieces built for this path ----------------------------------------

test('run --sweep adopts an outbox note before deciding what is outstanding', async () => {
  const f = await fixture();
  try {
    await dropInOutbox(
      f.config,
      'coordinator',
      '---\nto: archivist\ntype: request\nsummary: Reconcile the Q3 rollup\n---\n\nThe revenue figure moved.\n'
    );

    // Without the sweep, the fold sees an empty ledger: the file is real, sitting in
    // a real outbox, and completely invisible.
    const before = await readIndex(f.config);
    assert.equal(before.rows.length, 0);

    const lines: string[] = [];
    await runUntilQuiescent(f.config, {
      dryRun: true,
      sweepFirst: true,
      onLog: (l) => lines.push(l),
    });

    const after = await readIndex(f.config);
    assert.equal(after.rows.length, 1, 'the note is now a ledger row');
    assert.equal(after.rows[0]!.writer, 'coordinator');
    assert.ok(
      lines.some((l) => l.includes('swept coordinator') && l.includes('archivist')),
      `the sweep should be reported; got:\n${lines.join('\n')}`
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('without --sweep the note stays invisible, which is why the flag exists', async () => {
  const f = await fixture();
  try {
    await dropInOutbox(
      f.config,
      'coordinator',
      '---\nto: archivist\ntype: request\nsummary: Reconcile the Q3 rollup\n---\n\nThe revenue figure moved.\n'
    );

    await runUntilQuiescent(f.config, { dryRun: true, onLog: () => {} });

    const after = await readIndex(f.config);
    assert.equal(after.rows.length, 0, 'nothing swept, so nothing in the ledger');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a sweep reports a malformed note rather than swallowing it', async () => {
  const f = await fixture();
  try {
    await dropInOutbox(f.config, 'coordinator', 'No frontmatter, just a thought.\n');

    const lines: string[] = [];
    await runUntilQuiescent(f.config, { dryRun: true, sweepFirst: true, onLog: (l) => lines.push(l) });

    const joined = lines.join('\n');
    assert.match(joined, /REJECTED/);
    assert.match(joined, /preserved at/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
