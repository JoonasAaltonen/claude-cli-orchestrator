import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessageText, renderMessageFile, yamlPlainScalar } from '../src/ledger/message.js';

const FILE = 'C:\\YourDirectory\\agents\\worker\\outbox\\reply.md';

function msg(frontmatter: string, body = 'A body long enough to be a real message.'): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

test('the minimum an agent must write is accepted', () => {
  const p = parseMessageText(msg('to: coordinator\ntype: report\nsummary: Did the thing'), FILE);
  assert.equal(p.ok, true, p.errors.join('; '));
  assert.deepEqual(p.draft?.to, ['coordinator']);
  assert.equal(p.draft?.type, 'report');
  assert.equal(p.draft?.replyTo, null);
  assert.deepEqual(p.draft?.needs, []);
});

test('T6: Writer is never asked for, so an agent cannot forge one', () => {
  const p = parseMessageText(
    msg('to: coordinator\ntype: report\nwriter: operator\nsummary: Trying to sign as someone else'),
    FILE
  );
  assert.equal(p.ok, true);
  // The frontmatter schema has no writer field, so the claim is simply not carried.
  assert.equal((p.draft as any)?.writer, undefined);
});

test('M1: enumerations are closed, and the error names every legal value', () => {
  const p = parseMessageText(msg('to: coordinator\ntype: reponse\nsummary: Typo in type'), FILE);
  assert.equal(p.ok, false);
  const e = p.errors.join(' ');
  assert.ok(e.includes('reponse'));
  for (const t of ['report', 'request', 'response', 'signoff', 'decision']) assert.ok(e.includes(t));
});

test('M1: outcome is required on response and signoff, and forbidden elsewhere', () => {
  assert.ok(
    parseMessageText(msg('to: c\ntype: response\nreplyTo: 0001\nsummary: No outcome'), FILE)
      .errors.join(' ').includes('outcome')
  );
  assert.ok(
    parseMessageText(msg('to: c\ntype: report\noutcome: done\nsummary: Outcome on a report'), FILE)
      .errors.join(' ').includes('outcome')
  );
  assert.equal(
    parseMessageText(msg('to: c\ntype: response\nreplyTo: 0001\noutcome: done\nsummary: Fine'), FILE).ok,
    true
  );
});

test('a summary with any punctuation is accepted — the app normalises, agents do not (T6)', () => {
  // This exact shape bounced a real message and cost a full invocation, back when the
  // index was delimited and the summary had to avoid the delimiter.
  const p = parseMessageText(msg('to: c\ntype: report\nsummary: Ran it; it worked'), FILE);
  assert.equal(p.ok, true, p.errors.join('; '));
  assert.equal(p.draft?.summary, 'Ran it; it worked');
});

test('a colon in the summary parses, via the lenient reader when YAML refuses', () => {
  // Measured: `summary: Q3: what happened` is not valid YAML. It is a completely
  // ordinary thing for an agent to write, so it must not cost a round trip.
  const p = parseMessageText(msg('to: c\ntype: report\nsummary: Q3: what happened'), FILE);
  assert.equal(p.ok, true, p.errors.join('; '));
  assert.equal(p.draft?.summary, 'Q3: what happened');
  assert.equal(p.lenient, true, 'and we record that the strict parse failed');
});

test('other shapes YAML rejects but an agent will write', () => {
  const cases: [string, string][] = [
    ['summary: "quoted" thing', '"quoted" thing'],
    ['summary: - dashed', '- dashed'],
    ['summary: 60% done, 40% left', '60% done, 40% left'],
    ['summary: a | pipe and a > gt', 'a | pipe and a > gt'],
  ];
  for (const [line, expected] of cases) {
    const p = parseMessageText(msg(`to: c\ntype: report\n${line}`), FILE);
    assert.equal(p.ok, true, `${line} -> ${p.errors.join('; ')}`);
    assert.equal(p.draft?.summary, expected, `wrong value for ${line}`);
  }
});

test('a very long summary is normalised rather than rejected', () => {
  const p = parseMessageText(msg(`to: c\ntype: report\nsummary: ${'x'.repeat(600)}`), FILE);
  assert.equal(p.ok, true, p.errors.join('; '));
  assert.ok((p.draft?.summary.length ?? 0) <= 400);
});

test('M4: a rejection without a body saying what would make it pass is invalid', () => {
  const bare = parseMessageText(
    msg('to: c\ntype: response\nreplyTo: 0001\noutcome: rejected\nsummary: Not good enough', 'No.'),
    FILE
  );
  assert.equal(bare.ok, false);
  assert.ok(bare.errors.join(' ').includes('M4'));

  const specific = parseMessageText(
    msg(
      'to: c\ntype: response\nreplyTo: 0001\noutcome: rejected\nsummary: Needs the Q3 figure in the opening line',
      'Add the actual Q3 revenue number to the first sentence. Everything else can stand as written.'
    ),
    FILE
  );
  assert.equal(specific.ok, true, specific.errors.join('; '));
});

test('replyTo is normalised to the zero-padded form the index uses', () => {
  const p = parseMessageText(msg('to: c\ntype: response\nreplyTo: 2\noutcome: done\nsummary: X'), FILE);
  assert.equal(p.draft?.replyTo, '0002');
});

test('a + separated recipient list is split, and so is a comma separated one', () => {
  assert.deepEqual(
    parseMessageText(msg('to: a+b\ntype: report\nsummary: X'), FILE).draft?.to,
    ['a', 'b']
  );
  assert.deepEqual(
    parseMessageText(msg('to: a, b\ntype: report\nsummary: X'), FILE).draft?.to,
    ['a', 'b']
  );
});

test('M7: a file with no frontmatter is rejected with an actionable reason', () => {
  const p = parseMessageText('Just some prose, no frontmatter at all.', FILE);
  assert.equal(p.ok, false);
  assert.ok(p.errors[0]!.includes('---'));
});

test('M7: frontmatter YAML cannot parse and cannot be salvaged either', () => {
  // The lenient reader needs `key: value` lines. When there are none, the message is
  // genuinely unreadable and M7's bounce is the right answer.
  const p = parseMessageText('---\nthis is not fields at all\njust prose\n---\n\nBody', FILE);
  assert.equal(p.ok, false);
  assert.ok(p.errors.length > 0);
});

test('M7: a bounce still fires when a required field is simply absent', () => {
  const p = parseMessageText(msg('type: report\nsummary: No recipient'), FILE);
  assert.equal(p.ok, false);
  assert.ok(p.errors.join(' ').includes('to:'));
});

test('a BOM does not stop the frontmatter delimiter from matching', () => {
  const p = parseMessageText('\ufeff' + msg('to: c\ntype: report\nsummary: X'), FILE);
  assert.equal(p.ok, true, p.errors.join('; '));
});

test('CRLF line endings parse, because Windows editors write them', () => {
  const text = '---\r\nto: c\r\ntype: report\r\nsummary: X\r\n---\r\n\r\nBody here.\r\n';
  assert.equal(parseMessageText(text, FILE).ok, true);
});

test('T5: rendering never emits a double-quoted scalar, so backslashes pass through', () => {
  const rendered = renderMessageFile({
    to: ['coordinator'],
    type: 'report',
    replyTo: null,
    needs: [],
    outcome: null,
    summary: 'Wrote it to C:\\YourDirectory\\agents\\worker\\outbox',
    body: 'Body.',
  });
  assert.ok(!rendered.includes('"'), 'a double-quoted YAML scalar would eat the backslashes');
  const reparsed = parseMessageText(rendered, FILE);
  assert.equal(reparsed.ok, true, reparsed.errors.join('; '));
  assert.equal(reparsed.draft?.summary, 'Wrote it to C:\\YourDirectory\\agents\\worker\\outbox');
});

test('T5: a summary needing quotes gets single quotes, which are backslash-transparent', () => {
  assert.equal(yamlPlainScalar('C:\\x'), 'C:\\x');
  assert.equal(yamlPlainScalar('# leading hash'), "'# leading hash'");
  assert.equal(yamlPlainScalar("it's fine"), "it's fine");
  assert.equal(yamlPlainScalar('key: value'), "'key: value'");
  // The one that matters: a quoted form must still pass backslashes through.
  const q = yamlPlainScalar('- C:\\YourDirectory\\x');
  assert.ok(q.startsWith("'") && q.includes('C:\\YourDirectory\\x'));
});

test('a rendered file round-trips through the parser unchanged', () => {
  const draft = {
    to: ['coordinator', 'reviewer'],
    type: 'signoff' as const,
    replyTo: '0007',
    needs: ['editor'],
    outcome: 'done' as const,
    summary: 'Approved with no changes',
    body: 'Reads correctly and the figure matches row 0003.',
  };
  const reparsed = parseMessageText(renderMessageFile(draft), FILE);
  assert.equal(reparsed.ok, true, reparsed.errors.join('; '));
  assert.deepEqual(reparsed.draft, draft);
});
