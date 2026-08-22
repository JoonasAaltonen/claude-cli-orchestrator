/**
 * Recipient names, and the silent failure they used to cause.
 *
 * `To: Coordinator` against a roster holding `coordinator` produced a perfectly
 * valid row that nothing would ever dispatch: the fold keys outstanding work by
 * the string in `To` and asks for it by the roster's spelling, so the two never
 * met. No error, no bounce — just a thread that stayed open forever.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadConfig, canonicalName, unknownNames } from '../src/config/load.js';
import type { Config } from '../src/config/load.js';
import { appendRow, initCommsRoot, readIndex } from '../src/ledger/store.js';
import { fold, awaiting } from '../src/ledger/fold.js';
import { sweepOutbox } from '../src/dispatch/sweep.js';
import { writeRow } from '../src/ui/actions.js';
import { BadRequest } from '../src/ui/actions.js';
import { writeText } from '../src/util/fsx.js';

let counter = 0;

async function scratch(): Promise<Config> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `orch-names-${counter++}-`));
  const agentsRoot = path.join(base, 'agents');
  const configFile = path.join(base, 'orchestrator.config.json');
  for (const name of ['coordinator', 'worker']) {
    await fs.mkdir(path.join(agentsRoot, name, 'outbox'), { recursive: true });
    await writeText(path.join(agentsRoot, name, 'CLAUDE.md'), `# ${name}\n`);
  }
  await writeText(
    configFile,
    JSON.stringify({
      commsRoot: path.join(base, 'comms'),
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

function settings(c: Config) {
  return {
    staleThreadDays: c.staleThreadDays,
    maxRejectionsPerThread: c.maxRejectionsPerThread,
    decisionsDigestLimit: c.decisionsDigestLimit,
  };
}

test('canonicalName maps any casing to the roster spelling', async () => {
  const c = await scratch();
  assert.equal(canonicalName(c, 'Coordinator'), 'coordinator');
  assert.equal(canonicalName(c, '  WORKER '), 'worker');
  assert.equal(canonicalName(c, 'operator'), 'operator');
  assert.equal(canonicalName(c, 'Operator'), 'operator');
  assert.equal(canonicalName(c, 'nobody'), null);
});

test('a miscased recipient is stored as the roster spells it', async () => {
  const c = await scratch();
  const { row } = await appendRow(c, {
    writer: 'operator',
    draft: {
      to: ['Coordinator'],
      type: 'request',
      replyTo: null,
      needs: [],
      outcome: null,
      summary: 'mind the capital',
      body: 'b',
    },
  });
  assert.deepEqual(row.to, ['coordinator']);
});

test('the miscased row is actually dispatchable — the bug this exists for', async () => {
  const c = await scratch();
  await appendRow(c, {
    writer: 'operator',
    draft: {
      to: ['COORDINATOR'],
      type: 'request',
      replyTo: null,
      needs: [],
      outcome: null,
      summary: 'shouting',
      body: 'b',
    },
  });
  const { rows } = await readIndex(c);
  const f = fold(rows, settings(c));
  assert.equal(
    awaiting(f, 'coordinator').length,
    1,
    'without canonicalisation this is 0 and the thread never moves'
  );
});

test('needs is canonicalised too, or sign-off can never be satisfied', async () => {
  const c = await scratch();
  const { row } = await appendRow(c, {
    writer: 'operator',
    draft: {
      to: ['coordinator'],
      type: 'request',
      replyTo: null,
      needs: ['Worker'],
      outcome: null,
      summary: 's',
      body: 'b',
    },
  });
  assert.deepEqual(row.needs, ['worker']);
});

test('unknownNames reports only names nobody answers to', async () => {
  const c = await scratch();
  assert.deepEqual(unknownNames(c, ['coordinator', 'Worker', 'operator']), []);
  assert.deepEqual(unknownNames(c, ['coordinator', 'marketing']), ['marketing']);
});

test('the dashboard refuses a recipient that is not on the roster', async () => {
  const c = await scratch();
  await assert.rejects(
    () => writeRow(c, { to: 'marketng', summary: 'typo' }),
    (err: unknown) => {
      assert.ok(err instanceof BadRequest);
      assert.match(err.message, /No agent named marketng/);
      assert.match(err.message, /coordinator, worker/, 'it says who does exist');
      return true;
    }
  );
});

test('the dashboard accepts any casing', async () => {
  const c = await scratch();
  const { row } = await writeRow(c, { to: 'Coordinator', summary: 'fine' });
  assert.deepEqual(row.to, ['coordinator']);
});

test('recipients may be separated by + or , with or without spaces', async () => {
  const c = await scratch();
  const a = await writeRow(c, { to: 'coordinator+worker', summary: 'plus' });
  assert.deepEqual(a.row.to, ['coordinator', 'worker']);
  const b = await writeRow(c, { to: 'coordinator + worker', summary: 'spaced' });
  assert.deepEqual(b.row.to, ['coordinator', 'worker']);
  const d = await writeRow(c, { to: 'coordinator, worker', summary: 'comma' });
  assert.deepEqual(d.row.to, ['coordinator', 'worker']);
});

test('a sweep bounces a message addressed to nobody (M7)', async () => {
  const c = await scratch();
  const worker = c.agents.find((a) => a.name === 'worker')!;
  await writeText(
    path.join(worker.outbox, 'note.md'),
    ['---', 'to: marketing', 'type: report', 'summary: addressed to a stranger', '---', '', 'Nobody is called that.', ''].join('\n')
  );
  const r = await sweepOutbox(c, worker);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0]!.errors.join(' '), /nobody is named marketing/i);
  assert.match(r.rejected[0]!.errors.join(' '), /coordinator, worker/);
});

test('a sweep accepts a miscased recipient and fixes the spelling', async () => {
  const c = await scratch();
  const worker = c.agents.find((a) => a.name === 'worker')!;
  await writeText(
    path.join(worker.outbox, 'note.md'),
    ['---', 'to: Coordinator', 'type: report', 'summary: capitalised on purpose', '---', '', 'Capitalised on purpose.', ''].join('\n')
  );
  const r = await sweepOutbox(c, worker);
  assert.equal(r.rejected.length, 0, r.rejected.map((x) => x.errors.join(' ')).join(' | '));
  assert.deepEqual(r.accepted[0]!.row.to, ['coordinator']);
});

test('D3 still catches self-addressing through a capital letter', async () => {
  const c = await scratch();
  const worker = c.agents.find((a) => a.name === 'worker')!;
  await writeText(
    path.join(worker.outbox, 'note.md'),
    ['---', 'to: Worker', 'type: request', 'summary: addressed to myself', '---', '', 'Addressed to myself.', ''].join('\n')
  );
  const r = await sweepOutbox(c, worker);
  assert.equal(r.accepted.length, 0);
  assert.match(r.rejected[0]!.errors.join(' '), /yourself/i);
});
