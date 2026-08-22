import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRow, parseLine, nextId, validateRowShape, indexHeaderLine, parseLegacyLine } from '../src/ledger/row.js';
import type { Row } from '../src/ledger/row.js';

function row(over: Partial<Row> = {}): Row {
  return {
    id: '0001',
    time: '2026-08-21T09:00:00Z',
    writer: 'operator',
    to: ['coordinator'],
    type: 'request',
    replyTo: null,
    needs: [],
    outcome: null,
    ref: 'messages\\0001-do-the-thing.md',
    summary: 'Do the thing',
    ...over,
  };
}

test('M1 round-trips a row through the index format', () => {
  const r = row();
  const parsed = parseLine(formatRow(r));
  assert.equal(parsed.ok, true, parsed.errors.join('; '));
  assert.deepEqual(parsed.row, r);
});

test('the character that broke a real run now round-trips untouched', () => {
  // Observed live: an agent wrote this summary and the message was bounced, costing
  // a full invocation. Under NDJSON nothing about it is special.
  const r = row({ summary: 'Both agents can tell orchestrated from interactive; worker flagged friction' });
  const parsed = parseLine(formatRow(r));
  assert.equal(parsed.ok, true, parsed.errors.join('; '));
  assert.equal(parsed.row?.summary, r.summary, 'lossless — no character is substituted');
});

test('no punctuation an agent can write breaks the index', () => {
  const nasty = [
    'semicolons; and, commas',
    'quotes "double" and \'single\'',
    'a backtick `fence` and a pipe | and a tab\tinside',
    'braces {} brackets [] and a backslash C:\\Users\\x',
    'unicode — em dash, ellipsis…, emoji 🙂',
    'a newline\nin the middle',
    'a lone quote " and a lone backslash \\',
  ];
  for (const summary of nasty) {
    const line = formatRow(row({ summary }));
    // Whatever it contained, the record is still exactly one physical line.
    assert.equal(line.includes('\n'), false, `${JSON.stringify(summary)} produced a multi-line record`);

    const parsed = parseLine(line);
    assert.equal(parsed.ok, true, `failed on ${JSON.stringify(summary)}: ${parsed.errors.join('; ')}`);
    // Only whitespace is normalised; every other character survives verbatim.
    assert.equal(parsed.row?.summary, summary.replace(/\s+/g, ' ').trim());
  }
});

test('T5: backslashes in Ref survive, escaped by JSON.stringify rather than by hand', () => {
  const r = row({ ref: 'messages\\0001-a\\b.md' });
  const parsed = parseLine(formatRow(r));
  assert.equal(parsed.row?.ref, 'messages\\0001-a\\b.md');
});

test('M1 confines Outcome to response and signoff rows', () => {
  assert.ok(
    validateRowShape(row({ type: 'request', outcome: 'done' })).some((e) => e.includes('outcome'))
  );
  assert.ok(
    validateRowShape(row({ type: 'response', replyTo: '0001', outcome: null })).some((e) =>
      e.includes('outcome')
    )
  );
  assert.deepEqual(
    validateRowShape(row({ type: 'response', replyTo: '0001', writer: 'worker', to: ['coordinator'], outcome: 'done' })),
    []
  );
});

test('D3 is unrepresentable: a row addressed to its own writer is invalid', () => {
  const errs = validateRowShape(row({ writer: 'worker', to: ['worker'] }));
  assert.ok(errs.some((e) => e.includes('D3')));
});

test('formatRow still refuses a row that is structurally wrong', () => {
  // Summary *content* can no longer do this — only shape errors can.
  assert.throws(() => formatRow(row({ id: 'nope' })), /malformed/);
  assert.throws(() => formatRow(row({ to: [] })), /malformed/);
  assert.throws(() => formatRow(row({ writer: 'worker', to: ['worker'] })), /malformed/);
});

test('a long summary is truncated, never refused — the index is a label (L3)', () => {
  const parsed = parseLine(formatRow(row({ summary: 'x'.repeat(600) })));
  assert.equal(parsed.ok, true);
  assert.ok((parsed.row?.summary.length ?? 0) <= 400);
  assert.ok(parsed.row?.summary.endsWith('…'));
});

test('the schema header line is skipped, not treated as a row', () => {
  const parsed = parseLine(indexHeaderLine());
  assert.equal(parsed.skip, true);
  assert.deepEqual(parsed.errors, []);
});

test('a legacy delimited row is recognised and says what to do about it', () => {
  const parsed = parseLine(
    '0001 ; 2026-08-21T09:00:00Z ; operator ; coordinator ; request ;  ;  ;  ; m.md ; Do the thing'
  );
  assert.equal(parsed.ok, false);
  assert.ok(parsed.errors.join(' ').includes('migrate-index'));
});

test('legacy rows convert without loss, including a leaked delimiter', () => {
  const converted = parseLegacyLine(
    '0007 ; 2026-08-21T09:00:00Z ; worker ; coordinator ; response ; 0006 ;  ; done ; m\\0007.md ; Ran it; it worked'
  )!;
  assert.equal(converted.id, '0007');
  assert.equal(converted.outcome, 'done');
  // M6's positional rule is exactly what makes the old format recoverable.
  assert.equal(converted.summary, 'Ran it; it worked');
  assert.equal(parseLine(formatRow(converted)).ok, true);
});

test('Summary containing no delimiter is left intact including trailing punctuation', () => {
  const r = row({ summary: 'Q3 figures: revenue, margin and headcount (draft)' });
  assert.equal(parseLine(formatRow(r)).row?.summary, r.summary);
});

test('nextId allocates a zero-padded sequence and tolerates an empty ledger', () => {
  assert.equal(nextId([]), '0001');
  assert.equal(nextId(['0001', '0002']), '0003');
  assert.equal(nextId(['0009']), '0010');
  // Gaps do not cause reuse: the sequence only ever moves forward.
  assert.equal(nextId(['0001', '0005']), '0006');
});

test('a row with too few fields is rejected rather than misread', () => {
  const parsed = parseLine('0001 ; 2026-08-21 ; operator ; coordinator');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.row, undefined);
});

test('comment and blank lines are skipped, so the index can carry its own header', () => {
  assert.equal(parseLine('# ID ; Time ; Writer').ok, false);
  assert.equal(parseLine('   ').ok, false);
});
