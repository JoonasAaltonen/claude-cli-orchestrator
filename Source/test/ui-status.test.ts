/**
 * The two things the dashboard header and the Now tab read that nothing else does:
 * the quota the CLI last reported, and the last message with its body.
 *
 * Field names are the risk here. These are projections of records written elsewhere,
 * and a wrong key produces `undefined` rather than an error — the panel simply shows
 * nothing and nobody finds out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadConfig } from '../src/config/load.js';
import type { Config } from '../src/config/load.js';
import { appendRow, initCommsRoot, layout } from '../src/ledger/store.js';
import { statusPayload } from '../src/ui/api.js';
import { writeText } from '../src/util/fsx.js';

let n = 0;

async function scratch(): Promise<Config> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `orch-uistatus-${n++}-`));
  const agents = path.join(base, 'agents');
  await fs.mkdir(path.join(agents, 'coordinator', 'outbox'), { recursive: true });
  await writeText(path.join(agents, 'coordinator', 'CLAUDE.md'), '# coordinator\n');
  const configFile = path.join(base, 'orchestrator.config.json');
  await writeText(
    configFile,
    JSON.stringify({
      commsRoot: path.join(base, 'comms'),
      agents: [{ name: 'coordinator', home: path.join(agents, 'coordinator') }],
    })
  );
  const c = await loadConfig(configFile);
  await initCommsRoot(c);
  return c;
}

/** Writes invocation entries carrying only the fields the quota view reads. */
async function writeInvocations(c: Config, entries: unknown[]): Promise<void> {
  await writeText(layout(c).invocations, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function entry(startedAt: string, info: Record<string, unknown> | null) {
  return {
    invocationId: 'x',
    agent: 'coordinator',
    startedAt,
    rateLimitStatus: info ? { type: 'rate_limit_event', rate_limit_info: info } : null,
  };
}

test('the quota comes from the most recent invocation that reported one', async () => {
  const c = await scratch();
  await writeInvocations(c, [
    entry('2026-08-22T05:00:00Z', { status: 'allowed', resetsAt: 1787380800, rateLimitType: 'five_hour' }),
    entry('2026-08-22T05:32:32Z', {
      status: 'allowed_warning',
      utilization: 0.99,
      resetsAt: 1787380800,
      rateLimitType: 'five_hour',
    }),
  ]);
  const s = await statusPayload(c);
  assert.equal(s.quota?.status, 'allowed_warning');
  assert.equal(s.quota?.utilization, 0.99);
  assert.equal(s.quota?.limitType, 'five_hour');
  assert.equal(s.quota?.resetsAt, '2026-08-22T06:40:00.000Z');
  assert.equal(s.quota?.at, '2026-08-22T05:32:32Z', 'the operator is told how old the figure is');
});

test('an invocation with no rate limit info is skipped, not reported as blank', async () => {
  const c = await scratch();
  await writeInvocations(c, [
    entry('2026-08-22T05:00:00Z', { status: 'allowed', rateLimitType: 'five_hour' }),
    entry('2026-08-22T05:40:00Z', null),
  ]);
  const s = await statusPayload(c);
  assert.equal(s.quota?.status, 'allowed');
  assert.equal(s.quota?.at, '2026-08-22T05:00:00Z');
});

test('no invocations at all means no quota chip rather than a crash', async () => {
  const c = await scratch();
  const s = await statusPayload(c);
  assert.equal(s.quota, null);
});

/** A request from the operator, so a response has something lawful to reply to (M1). */
async function ask(c: Config, summary: string) {
  const { row } = await appendRow(c, {
    writer: 'operator',
    draft: {
      to: ['coordinator'], type: 'request', replyTo: null, needs: [], outcome: null,
      summary, body: 'q',
    },
  });
  return row.id;
}

async function answer(c: Config, replyTo: string, summary: string, body: string) {
  await appendRow(c, {
    writer: 'coordinator',
    draft: {
      to: ['operator'], type: 'response', replyTo, needs: [], outcome: 'done', summary, body,
    },
  });
}

test('the last message is returned with the body, not just the row', async () => {
  const c = await scratch();
  const id = await ask(c, 'what is the state of the comms layer');
  await answer(c, id, 'Status report on the comms layer', 'The part the operator actually wants to read.');

  const s = await statusPayload(c);
  assert.equal(s.latest?.writer, 'coordinator');
  assert.deepEqual(s.latest?.to, ['operator']);
  assert.equal(s.latest?.outcome, 'done');
  assert.match(s.latest?.body ?? '', /actually wants to read/);
});

test('the panel never shows the same row twice', async () => {
  const c = await scratch();
  const id = await ask(c, 'a question');
  await answer(c, id, 'to the operator', 'b');

  const s = await statusPayload(c);
  assert.ok(s.latest, 'there is a latest row');
  assert.equal(s.answer, null, 'the latest already is the report to the operator');
});

test('a run that stopped mid-chain still shows the report you last got', async () => {
  const c = await scratch();
  const id = await ask(c, 'the original question');
  await answer(c, id, 'the answer you were waiting for', 'the answer body');
  // ...and then the chain carried on and stopped somewhere that is not you.
  await ask(c, 'a new question');

  const s = await statusPayload(c);
  assert.equal(s.latest?.summary, 'a new question');
  assert.equal(s.answer?.summary, 'the answer you were waiting for');
  assert.match(s.answer?.body ?? '', /the answer body/);
});
