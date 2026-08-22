/**
 * `status.md` — the fold rendered for agents that cannot run the CLI.
 *
 * The value of this file is that it is *not* re-derived by a model, so what matters
 * is that it states the same facts the fold does and cannot silently fall behind the
 * index. Both are asserted here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderStatusFile, statusRowCount, statusFilePath } from '../src/ledger/status-file.js';
import { parseLegacyLine } from '../src/ledger/row.js';
import type { Row } from '../src/ledger/row.js';
import { appendRow, readIndex } from '../src/ledger/store.js';
import { loadConfig } from '../src/config/load.js';

const OPTS = { staleThreadDays: 3, maxRejectionsPerThread: 2, decisionsDigestLimit: 15 };
const rows = (...ls: string[]): Row[] => ls.map((l) => parseLegacyLine(l)!);

test('an open thread names who can move and who is merely blocked', () => {
  const text = renderStatusFile(
    rows(
      '0001 ; 2026-08-22T09:00:00Z ; operator ; coordinator ; request ;  ;  ;  ; m\\a.md ; Draft the Q3 post',
      '0002 ; 2026-08-22T09:05:00Z ; coordinator ; worker ; request ; 0001 ;  ;  ; m\\b.md ; Pull the figures'
    ),
    OPTS
  );

  assert.match(text, /## Open threads \(1\)/);
  assert.match(text, /\*\*Can move now:\*\* worker/);
  // The coordinator is blocked by its own sub-request, and the table must say which.
  assert.match(text, /\| 0001 \| operator \| coordinator \| unanswered request \| 0002 \|/);
  assert.doesNotMatch(text, /Nobody can move/);
});

test('a finished chain that never addressed the operator is called out', () => {
  const text = renderStatusFile(
    rows(
      '0001 ; 2026-08-22T09:00:00Z ; coordinator ; worker ; request ;  ;  ;  ; m\\a.md ; Please do the thing',
      '0002 ; 2026-08-22T09:20:00Z ; worker ; coordinator ; response ; 0001 ;  ; done ; m\\b.md ; Done, file is at X'
    ),
    OPTS
  );

  assert.match(text, /## Nothing is outstanding/);
  assert.match(text, /## Finished without reporting to operator \(1\)/);
  assert.match(text, /\*\*0001\*\*/);
});

test('the same chain with the operator addressed is not called out', () => {
  const text = renderStatusFile(
    rows(
      '0001 ; 2026-08-22T09:00:00Z ; coordinator ; worker ; request ;  ;  ;  ; m\\a.md ; Please do the thing',
      '0002 ; 2026-08-22T09:20:00Z ; worker ; operator ; response ; 0001 ;  ; done ; m\\b.md ; Done, file is at X'
    ),
    OPTS
  );
  assert.match(text, /## Everything finished has been reported/);
});

test('a lone report is not mistaken for finished work', () => {
  // An M7 bounce and a /ledger-note heads-up are both single `report` rows. Neither
  // is something anyone is waiting on the result of, and listing them buried the real
  // cases on a live ledger.
  const text = renderStatusFile(
    rows(
      '0001 ; 2026-08-22T09:00:00Z ; orchestrator ; coordinator ; report ;  ;  ;  ; m\\a.md ; Message file rejected',
      '0002 ; 2026-08-22T09:01:00Z ; worker ; coordinator ; report ;  ;  ;  ; m\\b.md ; Heads up about the rollup'
    ),
    OPTS
  );
  assert.match(text, /## Everything finished has been reported/);
});

test('a halted thread is reported as needing a decision, with the reason', () => {
  const text = renderStatusFile(
    rows(
      '0001 ; 2026-08-18T09:00:00Z ; operator ; coordinator ; request ;  ;  ;  ; m\\a.md ; Draft it',
      '0002 ; 2026-08-18T09:05:00Z ; coordinator ; operator ; response ; 0001 ;  ; rejected ; m\\b.md ; Not good enough',
      '0003 ; 2026-08-18T09:10:00Z ; coordinator ; operator ; response ; 0001 ;  ; rejected ; m\\c.md ; Still not good enough'
    ),
    { ...OPTS, now: new Date('2026-08-22T09:00:00Z') }
  );
  assert.match(text, /## Needs a decision/);
  assert.match(text, /halted after 2 rejection\(s\)/);
});

test('it states the row count it was built from, so staleness is checkable', () => {
  const text = renderStatusFile(
    rows('0001 ; 2026-08-22T09:00:00Z ; operator ; coordinator ; request ;  ;  ;  ; m\\a.md ; One'),
    OPTS
  );
  assert.equal(statusRowCount(text), 1);
  // The instruction an agent follows to check it: rows + the schema header line.
  assert.match(text, /should have \*\*2 line\(s\)\*\*/);
});

test('appendRow refreshes it, so it cannot fall behind the index', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'orch-status-'));
  try {
    const comms = path.join(root, 'comms');
    const home = path.join(root, 'agents', 'worker');
    await mkdir(path.join(home, 'outbox'), { recursive: true });
    await mkdir(comms, { recursive: true });
    await writeFile(path.join(home, 'CLAUDE.md'), '# worker\n');

    const configFile = path.join(root, 'orchestrator.config.json');
    await writeFile(
      configFile,
      JSON.stringify({ commsRoot: comms, agents: [{ name: 'worker', home }] }, null, 2)
    );
    const config = await loadConfig(configFile);

    for (let i = 1; i <= 3; i++) {
      await appendRow(config, {
        writer: 'operator',
        draft: {
          to: ['worker'],
          type: 'request',
          replyTo: null,
          needs: [],
          outcome: null,
          summary: `Row number ${i}`,
          body: 'A body long enough to be a real message.',
        },
      });

      // After every single append, without anything else being run.
      const text = await readFile(statusFilePath(comms), 'utf8');
      const { rows: indexRows } = await readIndex(config);
      assert.equal(
        statusRowCount(text),
        indexRows.length,
        `status.md fell behind after append ${i}`
      );
    }

    const text = await readFile(statusFilePath(comms), 'utf8');
    assert.match(text, /## Open threads \(3\)/);
    assert.match(text, /\*\*Can move now:\*\* worker/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
