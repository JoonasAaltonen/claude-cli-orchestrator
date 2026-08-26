/**
 * §11 step 1: "The fold is testable against hand-written fixture rows with nothing
 * else built." These are those rows. The §13b chain appears verbatim, because it is
 * the falsifiable v1 target and the fold has to describe it correctly before any
 * invocation exists to produce it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, walkToRoot, mayReadBody, awaiting } from '../src/ledger/fold.js';
import { parseLegacyLine } from '../src/ledger/row.js';
import type { Row } from '../src/ledger/row.js';

const SETTINGS = {
  staleThreadDays: 3,
  maxRejectionsPerThread: 2,
  decisionsDigestLimit: 15,
  now: new Date('2026-08-21T12:00:00Z'),
};

/**
 * The fold operates on Row objects and knows nothing about how they are stored, so
 * these fixtures stay in the compact tabular form that is easiest to read in a diff.
 * parseLegacyLine turns that form into rows; the index itself is NDJSON.
 */
function rows(...lines: string[]): Row[] {
  return lines.map((l, i) => {
    const r = parseLegacyLine(l);
    assert.ok(r, `fixture line ${i + 1} could not be read`);
    return r!;
  });
}

/** §13b — the first pipeline. Five rows, three invocations, two agents, Needs blank. */
const CHAIN = rows(
  '0001 ; 2026-08-21T09:00:00Z ; operator ; coordinator ; request ;  ;  ;  ; messages\\0001-a.md ; How did Q3 go and what should we do about it',
  '0002 ; 2026-08-21T09:05:00Z ; coordinator ; worker ; request ; 0001 ;  ;  ; messages\\0002-b.md ; Pull the Q3 revenue and margin figures',
  '0003 ; 2026-08-21T09:20:00Z ; worker ; coordinator ; response ; 0002 ;  ; done ; messages\\0003-c.md ; Q3 figures attached',
  '0004 ; 2026-08-21T09:30:00Z ; coordinator ; operator ; response ; 0001 ;  ; done ; messages\\0004-d.md ; Q3 report with recommendation'
);

test('the §13b chain folds into one thread rooted at the operator request', () => {
  const f = fold(CHAIN, SETTINGS);
  assert.equal(f.threads.length, 1);
  assert.equal(f.threads[0]!.rootId, '0001');
  assert.equal(f.threads[0]!.rows.length, 4);
});

test('§13b acceptance 4: the chain stops on its own once row 4 answers row 1', () => {
  const f = fold(CHAIN, SETTINGS);
  assert.deepEqual(f.openThreads, [], 'nothing should still be outstanding');
  assert.equal(f.awaitingBy.size, 0, 'the chain must not continue past row 4 looking for more to do');
});

test('D10a: walking back from row 4 reaches row 1, which is the question it must answer', () => {
  const f = fold(CHAIN, SETTINGS);
  const walk = walkToRoot(f.byId.get('0004')!, f.byId);
  assert.equal(walk.rootId, '0001');
  assert.deepEqual(walk.chain.map((r) => r.id), ['0001', '0004']);

  // And the thread handed to the agent carries every row, including row 2 — which
  // this same agent wrote and, being cold, does not remember writing.
  assert.deepEqual(f.threadOf.get('0004')!.rows.map((r) => r.id), ['0001', '0002', '0003', '0004']);
});

test('mid-chain, the ball is visibly with the right agent', () => {
  const f = fold(CHAIN.slice(0, 2), SETTINGS);
  const t = f.threads[0]!;

  // Two different questions, and this test used to conflate them — which is how the
  // chain-stops-short bug survived a green suite.
  //
  //   "still owed"     -> thread.outstanding. Row 1 is owed by the coordinator.
  //   "actionable now" -> awaiting(). Row 1 is not, because the coordinator is
  //                       itself waiting on the row 2 it just wrote.
  assert.deepEqual(
    t.outstanding.map((o) => o.row.id).sort(),
    ['0001', '0002'],
    'both rows are still owed'
  );
  assert.deepEqual(awaiting(f, 'worker').map((o) => o.row.id), ['0002'], 'the worker can act');
  assert.deepEqual(awaiting(f, 'coordinator'), [], 'the coordinator cannot act yet');
  assert.equal(f.openThreads.length, 1);
});

test('a report replying to a request does not close it — reports go to the operator (M9)', () => {
  const r = rows(
    '0001 ; 2026-08-21T09:00:00Z ; operator ; coordinator ; request ;  ;  ;  ; messages\\0001-a.md ; Do the thing',
    '0002 ; 2026-08-21T09:05:00Z ; coordinator ; operator ; report ; 0001 ;  ;  ; messages\\0002-b.md ; Progress note'
  );
  const f = fold(r, SETTINGS);
  assert.deepEqual(awaiting(f, 'coordinator').map((o) => o.row.id), ['0001']);
});

test('M2: Needs blank means report-and-act — one row, no counter-signature', () => {
  const r = rows(
    '0001 ; 2026-08-21T09:00:00Z ; coordinator ; operator ; report ;  ;  ;  ; messages\\0001-a.md ; Fixed the typo'
  );
  const f = fold(r, SETTINGS);
  assert.deepEqual(f.openThreads, []);
});

test('M2: a non-blank Needs holds the row open until each named agent signs off', () => {
  const base =
    '0001 ; 2026-08-21T09:00:00Z ; coordinator ; operator ; report ;  ; reviewer+editor ;  ; messages\\0001-a.md ; Draft of the public post';
  let f = fold(rows(base), SETTINGS);
  assert.deepEqual(awaiting(f, 'reviewer').map((o) => o.reason), ['awaiting-signoff']);
  assert.deepEqual(awaiting(f, 'editor').map((o) => o.reason), ['awaiting-signoff']);

  f = fold(
    rows(
      base,
      '0002 ; 2026-08-21T09:10:00Z ; reviewer ; coordinator ; signoff ; 0001 ;  ; done ; messages\\0002-b.md ; Reads correctly'
    ),
    SETTINGS
  );
  assert.deepEqual(awaiting(f, 'reviewer'), [], 'reviewer has signed');
  assert.equal(awaiting(f, 'editor').length, 1, 'editor still owes a signature');

  f = fold(
    rows(
      base,
      '0002 ; 2026-08-21T09:10:00Z ; reviewer ; coordinator ; signoff ; 0001 ;  ; done ; messages\\0002-b.md ; Reads correctly',
      '0003 ; 2026-08-21T09:12:00Z ; editor ; coordinator ; signoff ; 0001 ;  ; done ; messages\\0003-c.md ; Approved'
    ),
    SETTINGS
  );
  assert.deepEqual(awaiting(f, 'reviewer'), []);
  assert.deepEqual(awaiting(f, 'editor'), []);
  // Both signatures are in, so the row returns to the agent that asked for them — once,
  // carrying both, not once per signature.
  const back = awaiting(f, 'coordinator');
  assert.deepEqual(back.map((o) => o.reason), ['undelivered-answer']);
  assert.deepEqual(back[0]!.answeredBy.map((r) => r.id), ['0002', '0003']);
});

test('M5: two rejections halt the thread and it stops being dispatchable', () => {
  const f = fold(
    rows(
      '0001 ; 2026-08-21T09:00:00Z ; coordinator ; worker ; request ;  ;  ;  ; messages\\0001-a.md ; Write the summary paragraph',
      '0002 ; 2026-08-21T09:05:00Z ; worker ; coordinator ; response ; 0001 ;  ; done ; messages\\0002-b.md ; First draft',
      '0003 ; 2026-08-21T09:10:00Z ; coordinator ; worker ; request ; 0002 ;  ;  ; messages\\0003-c.md ; Needs the figure in the opening line',
      '0004 ; 2026-08-21T09:15:00Z ; worker ; coordinator ; response ; 0003 ;  ; rejected ; messages\\0004-d.md ; Cannot verify the figure',
      '0005 ; 2026-08-21T09:20:00Z ; coordinator ; worker ; request ; 0004 ;  ;  ; messages\\0005-e.md ; Use the figure from row 2',
      '0006 ; 2026-08-21T09:25:00Z ; worker ; coordinator ; response ; 0005 ;  ; rejected ; messages\\0006-f.md ; Still cannot verify'
    ),
    SETTINGS
  );
  const t = f.threads[0]!;
  assert.equal(t.rejectionCount, 2);
  assert.equal(t.halted, true, 'M5: it stops and escalates to the operator');
  assert.equal(t.open, false, 'a halted thread is not open work');
  assert.equal(f.awaitingBy.size, 0, 'nothing is dispatched from a halted thread');
  assert.deepEqual(f.haltedThreads.map((x) => x.rootId), ['0001']);
});

test('L7: a stale thread is flagged, not closed', () => {
  const f = fold(
    rows(
      '0001 ; 2026-08-10T09:00:00Z ; coordinator ; worker ; request ;  ;  ;  ; messages\\0001-a.md ; Something asked eleven days ago'
    ),
    SETTINGS
  );
  const t = f.threads[0]!;
  assert.equal(t.stale, true);
  assert.equal(t.open, true, 'flagging must not close it — chasing is supervision');
  assert.deepEqual(awaiting(f, 'worker').map((o) => o.row.id), ['0001'], 'still dispatchable');
});

test('L6 output 2: the decisions digest is built from decision rows, most recent last', () => {
  const f = fold(
    rows(
      '0001 ; 2026-08-19T09:00:00Z ; operator ; coordinator ; decision ;  ;  ;  ; messages\\0001-a.md ; We ship on Fridays',
      '0002 ; 2026-08-20T09:00:00Z ; coordinator ; worker ; request ;  ;  ;  ; messages\\0002-b.md ; Unrelated work',
      '0003 ; 2026-08-20T10:00:00Z ; operator ; coordinator ; decision ;  ;  ;  ; messages\\0003-c.md ; Prices stay in euros'
    ),
    SETTINGS
  );
  assert.deepEqual(f.decisions.map((d) => d.id), ['0001', '0003']);
  assert.equal(f.decisions.at(-1)!.summary, 'Prices stay in euros');
});

test('L6: the digest respects its limit, keeping the most recent decisions', () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    `${String(i + 1).padStart(4, '0')} ; 2026-08-20T09:00:00Z ; operator ; coordinator ; decision ;  ;  ;  ; messages\\x.md ; Decision ${i + 1}`
  );
  const f = fold(rows(...many), { ...SETTINGS, decisionsDigestLimit: 5 });
  assert.deepEqual(f.decisions.map((d) => d.summary), [
    'Decision 16', 'Decision 17', 'Decision 18', 'Decision 19', 'Decision 20',
  ]);
});

test('T4: the participant list is derived from the index, never stored', () => {
  const f = fold(CHAIN, SETTINGS);
  assert.deepEqual(f.participants, ['coordinator', 'operator', 'worker']);
});

test('L8: bodies are readable by the parties to that thread; the operator reads all', () => {
  const f = fold(CHAIN, SETTINGS);
  const t = f.threads[0]!;
  assert.equal(mayReadBody(t, 'coordinator'), true);
  assert.equal(mayReadBody(t, 'worker'), true);
  assert.equal(mayReadBody(t, 'operator'), true);
  assert.equal(mayReadBody(t, 'stranger'), false);
});

test('a dangling ReplyTo degrades to a shorter thread rather than crashing the fold', () => {
  const f = fold(
    rows(
      '0004 ; 2026-08-21T09:30:00Z ; coordinator ; operator ; response ; 0099 ;  ; done ; messages\\0004-d.md ; Answer to a row that is not here'
    ),
    SETTINGS
  );
  const walk = walkToRoot(f.byId.get('0004')!, f.byId);
  assert.equal(walk.rootId, '0004');
  assert.equal(walk.broken, '0099');
});

test('a ReplyTo cycle terminates the walk instead of hanging', () => {
  const a = parseLegacyLine('0001 ; 2026-08-21T09:00:00Z ; operator ; coordinator ; request ; 0002 ;  ;  ; m\\a.md ; A')!;
  const b = parseLegacyLine('0002 ; 2026-08-21T09:00:00Z ; coordinator ; operator ; report ; 0001 ;  ;  ; m\\b.md ; B')!;
  const byId = new Map([['0001', a], ['0002', b]]);
  const walk = walkToRoot(a, byId);
  assert.ok(walk.broken !== null);
  assert.ok(walk.chain.length <= 2);
});

test('L1: the fold is a pure replay — same rows in, same state out, no mutation', () => {
  const snapshot = JSON.stringify(CHAIN);
  const a = fold(CHAIN, SETTINGS);
  const b = fold(CHAIN, SETTINGS);
  assert.equal(JSON.stringify(CHAIN), snapshot, 'folding must not mutate the rows');
  assert.deepEqual(a.threads.map((t) => t.rootId), b.threads.map((t) => t.rootId));
  assert.deepEqual(a.participants, b.participants);
});

/**
 * The bug the first live acceptance run found: the chain stopped after row 3.
 *
 * The coordinator was dispatched for row 1, delegated by writing row 2, and dispatch
 * state recorded row 1 as "handled" because the invocation had produced *an*
 * artefact. Row 1 was never answered, so §13b's row 4 was never written — the chain
 * ended one hop short while every invocation reported success.
 *
 * The fix is to derive the distinction rather than store it: a row is outstanding
 * until the ledger says otherwise, and separately it is *blocked* while the agent it
 * sits on is waiting for its own sub-request.
 */

test('after delegating, the coordinator still owes row 1 but cannot act on it yet', () => {
  const f = fold(CHAIN.slice(0, 2), SETTINGS);
  const t = f.threads[0]!;

  const row1 = t.outstanding.find((o) => o.row.id === '0001')!;
  assert.ok(row1, 'row 1 is still outstanding — nobody has answered it');
  assert.deepEqual(row1.awaiting, ['coordinator']);
  assert.deepEqual(row1.blockedBy, ['0002'], 'blocked on the request it just wrote');

  // So the worker is dispatchable and the coordinator is not.
  assert.deepEqual(awaiting(f, 'worker').map((o) => o.row.id), ['0002']);
  assert.deepEqual(awaiting(f, 'coordinator'), [], 'must not be re-dispatched, or it delegates again');
});

test('once the worker answers, row 1 becomes actionable again — this is §13b row 4', () => {
  const f = fold(CHAIN.slice(0, 3), SETTINGS);
  const row1 = f.threads[0]!.outstanding.find((o) => o.row.id === '0001')!;
  assert.deepEqual(row1.blockedBy, [], 'the sub-request is answered, so nothing blocks it');
  assert.deepEqual(
    awaiting(f, 'coordinator').map((o) => o.row.id),
    ['0001'],
    'the coordinator must be dispatched a second time, cold, to answer the operator'
  );
});

test('a blocked item is still visible as outstanding — it is not silently dropped', () => {
  const f = fold(CHAIN.slice(0, 2), SETTINGS);
  assert.equal(f.openThreads.length, 1, 'the thread is still open');
  assert.equal(f.threads[0]!.outstanding.length, 2, 'both row 1 and row 2 are outstanding');
  // Only dispatchability is affected.
  assert.equal(f.awaitingBy.get('coordinator'), undefined);
});

test('a two-level delegation blocks each layer in turn rather than deadlocking', () => {
  const r = rows(
    '0001 ; 2026-08-21T09:00:00Z ; operator ; coordinator ; request ;  ;  ;  ; m\a.md ; Top level ask',
    '0002 ; 2026-08-21T09:01:00Z ; coordinator ; worker ; request ; 0001 ;  ;  ; m\b.md ; Sub-question',
    '0003 ; 2026-08-21T09:02:00Z ; worker ; researcher ; request ; 0002 ;  ;  ; m\c.md ; Sub-sub-question'
  );
  const f = fold(r, SETTINGS);
  assert.deepEqual(awaiting(f, 'researcher').map((o) => o.row.id), ['0003'], 'only the deepest is actionable');
  assert.deepEqual(awaiting(f, 'worker'), []);
  assert.deepEqual(awaiting(f, 'coordinator'), []);
});

/**
 * Answering a request with another request, which deadlocked a live chain.
 *
 * The blockedBy rule above was written for one shape — coordinator owes the operator
 * an answer while its own sub-request is open — and quietly assumed every blocking
 * request is a *descendant* of the row it blocks. An agent that replies to a request
 * with a request breaks that assumption: each side then owes the other, and blocking
 * on an ancestor made both vanish from `awaitingBy` at once.
 *
 * Observed live: `status` showed the thread open with "waiting on coordinator", while
 * `inbox --for coordinator` said "Nothing" and `run` reported quiescent. Two views of
 * the same fold disagreeing is the tell.
 */
const PING_PONG = rows(
  '0006 ; 2026-08-22T02:37:00Z ; coordinator ; worker ; request ;  ;  ;  ; messages\\0006-a.md ; Round-trip acknowledgement test',
  '0008 ; 2026-08-22T02:37:45Z ; worker ; coordinator ; request ; 0006 ;  ;  ; messages\\0008-b.md ; Confirming receipt, now confirm mine'
);

test('a request answered by a request does not deadlock: the responder is dispatchable', () => {
  const f = fold(PING_PONG, SETTINGS);
  const t = f.threads[0]!;

  const r6 = t.outstanding.find((o) => o.row.id === '0006')!;
  const r8 = t.outstanding.find((o) => o.row.id === '0008')!;
  assert.ok(r6 && r8, 'both requests are outstanding');

  // The worker genuinely cannot finish 0006 until 0008 is answered, and 0008 is
  // below 0006 in the chain — so this block is the real one.
  assert.deepEqual(r6.awaiting, ['worker']);
  assert.deepEqual(r6.blockedBy, ['0008']);

  // The coordinator is NOT blocked. Its open row 0006 is 0008's parent, and
  // answering 0008 is exactly what unblocks it — it cannot be a prerequisite.
  assert.deepEqual(r8.awaiting, ['coordinator']);
  assert.deepEqual(r8.blockedBy, [], 'an ancestor must never block');

  assert.deepEqual(
    awaiting(f, 'coordinator').map((o) => o.row.id),
    ['0008'],
    'the chain continues rather than stalling with both sides waiting'
  );
  assert.deepEqual(awaiting(f, 'worker'), [], 'and the worker waits, correctly');
});

test('status and inbox cannot disagree — anything dispatchable is also outstanding', () => {
  // The symptom that exposed the deadlock. Every item reachable through awaitingBy
  // must still be present in its thread's outstanding list.
  for (const fixture of [PING_PONG, CHAIN.slice(0, 2), CHAIN.slice(0, 3)]) {
    const f = fold(fixture, SETTINGS);
    for (const [who, items] of f.awaitingBy) {
      for (const o of items) {
        const t = f.threadOf.get(o.row.id)!;
        assert.ok(
          t.outstanding.some((x) => x.row.id === o.row.id),
          `${o.row.id} is dispatchable for ${who} but missing from its thread's outstanding list`
        );
      }
    }
  }
});

test('an open thread with nobody dispatchable is a deadlock, and these shapes have none', () => {
  for (const fixture of [PING_PONG, CHAIN.slice(0, 2), CHAIN.slice(0, 3)]) {
    const f = fold(fixture, SETTINGS);
    for (const t of f.openThreads) {
      if (t.halted || !t.outstanding.length) continue;
      const dispatchable = t.outstanding.filter((o) => !o.blockedBy.length);
      assert.ok(
        dispatchable.length > 0,
        `thread ${t.rootId} is open with ${t.outstanding.length} outstanding item(s) and every one blocked — the chain would stop while status still shows it open`
      );
    }
  }
});

/**
 * Who pulls the coordinator back to write the summary.
 *
 * The everyday shape is: a human asks the coordinator for something, the coordinator
 * picks whoever is suited and delegates, and when the answer comes back the
 * coordinator reports to the human — what was done, and where the output is.
 *
 * That last hop has no mechanism of its own. It happens because the *operator's*
 * request is still unanswered, and the coordinator becomes actionable on it again the
 * moment its sub-request closes. A `response` closes a request and creates no new
 * obligation, so nothing else would cause it.
 *
 * Which means the same delegation started a different way does not produce a summary
 * at all — see below. The two are pinned together because the difference is invisible
 * from the outside: both chains end, both report success, and only one of them tells
 * the human anything.
 */
const OPERATOR_STARTED = rows(
  '0001 ; 2026-08-22T09:00:00Z ; operator ; coordinator ; request ;  ;  ;  ; messages\\0001-a.md ; Do the thing and tell me where it landed',
  '0002 ; 2026-08-22T09:05:00Z ; coordinator ; worker ; request ; 0001 ;  ;  ; messages\\0002-b.md ; Please do the thing',
  '0003 ; 2026-08-22T09:20:00Z ; worker ; coordinator ; response ; 0002 ;  ; done ; messages\\0003-c.md ; Done, the file is at X'
);

/** The same delegation, but opened by the coordinator itself — no operator row. */
const AGENT_STARTED = rows(
  '0001 ; 2026-08-22T09:00:00Z ; coordinator ; worker ; request ;  ;  ;  ; messages\\0001-a.md ; Please do the thing',
  '0002 ; 2026-08-22T09:20:00Z ; worker ; coordinator ; response ; 0001 ;  ; done ; messages\\0002-b.md ; Done, the file is at X'
);

test('an operator-started chain pulls the coordinator back to summarise', () => {
  const f = fold(OPERATOR_STARTED, SETTINGS);
  assert.deepEqual(
    awaiting(f, 'coordinator').map((o) => o.row.id),
    ['0001'],
    'the operator request is still open, so the coordinator is dispatched again to answer it'
  );
  assert.equal(f.openThreads.length, 1, 'and the thread stays open until it does');
});

/**
 * Fan-out: one coordinator, several agents working in parallel, each side chain
 * resolving on its own before the whole lot is compiled into one answer.
 *
 * Nothing in the ledger models a "chain" as a thing with a shape. A thread is
 * whatever `ReplyTo` happens to connect, so branching is not a feature that had to be
 * added — it is what you get when two rows reply to the same parent. These assert
 * that the *scheduling* holds up under it, which is the part that could plausibly be
 * wrong: the coordinator must wait for every branch, then be invoked once with all of
 * them in front of it.
 */
const FAN_OUT = rows(
  '0001 ; 2026-08-22T09:00:00Z ; operator ; coordinator ; request ;  ;  ;  ; messages\\0001-a.md ; Research the market and draft a post about it',
  '0002 ; 2026-08-22T09:05:00Z ; coordinator ; researcher ; request ; 0001 ;  ;  ; messages\\0002-b.md ; Pull the competitor pricing',
  '0003 ; 2026-08-22T09:05:30Z ; coordinator ; writer ; request ; 0001 ;  ;  ; messages\\0003-c.md ; Draft the opening section',
  '0004 ; 2026-08-22T09:20:00Z ; researcher ; archivist ; request ; 0002 ;  ;  ; messages\\0004-d.md ; Where is last year pricing sheet',
  '0005 ; 2026-08-22T09:25:00Z ; archivist ; researcher ; response ; 0004 ;  ; done ; messages\\0005-e.md ; It is at docs/pricing-2025.md',
  '0006 ; 2026-08-22T09:35:00Z ; researcher ; coordinator ; response ; 0002 ;  ; done ; messages\\0006-f.md ; Competitor pricing summarised',
  '0007 ; 2026-08-22T09:40:00Z ; writer ; coordinator ; response ; 0003 ;  ; done ; messages\\0007-g.md ; Opening section drafted'
);

test('fan-out: two side chains under one request, and a nested one inside a branch', () => {
  // Only the innermost open request is dispatchable. The researcher is waiting on the
  // archivist, and the coordinator is waiting on both of its branches.
  const early = fold(FAN_OUT.slice(0, 4), SETTINGS);
  assert.deepEqual(awaiting(early, 'archivist').map((o) => o.row.id), ['0004']);
  assert.deepEqual(awaiting(early, 'researcher'), [], 'blocked by its own sub-request');
  assert.deepEqual(awaiting(early, 'coordinator'), [], 'blocked by both branches');
  assert.deepEqual(awaiting(early, 'writer').map((o) => o.row.id), ['0003'], 'the other branch runs in parallel');

  // One thread throughout — branching does not split it.
  assert.equal(early.threads.length, 1);
  assert.equal(early.threads[0]!.rootId, '0001');
});

test('fan-out: the coordinator waits for every branch, not just the first', () => {
  // Researcher branch fully resolved, writer branch still open.
  const partial = fold(FAN_OUT.slice(0, 6), SETTINGS);
  assert.deepEqual(
    awaiting(partial, 'coordinator'),
    [],
    'one branch answered is not enough — the other is still outstanding'
  );
  assert.deepEqual(awaiting(partial, 'writer').map((o) => o.row.id), ['0003']);
});

test('fan-out: once every branch is in, the coordinator is invoked once to compile', () => {
  const done = fold(FAN_OUT, SETTINGS);
  const forCoordinator = awaiting(done, 'coordinator');
  assert.deepEqual(
    forCoordinator.map((o) => o.row.id),
    ['0001'],
    'exactly one item — the original request — not one per branch'
  );
  assert.deepEqual(forCoordinator[0]!.blockedBy, [], 'nothing blocks it any more');

  // And it is handed the whole thread, both branches and the nested hop included, so
  // it can compile rather than answer from whichever reply arrived last (D10a).
  const thread = done.threadOf.get('0001')!;
  assert.deepEqual(
    thread.rows.map((r) => r.id),
    ['0001', '0002', '0003', '0004', '0005', '0006', '0007']
  );
});

/**
 * One request, several recipients — the form ledger row 0018 used in practice, and
 * the one the protocol was ambiguous about until v6 was corrected.
 *
 * The question this pins: does the row release on the *first* reply, or on the last?
 * If the first, the requester is handed the thread with replies still in flight and
 * the fan-out mechanism is broken for this shape, so it has to be the last — the same
 * answer as the one-message-per-agent form, which is what makes the two equivalent.
 */
const MULTI_RECIPIENT = rows(
  '0001 ; 2026-08-22T09:00:00Z ; operator ; coordinator ; request ;  ;  ;  ; messages\\0001-a.md ; Position on the pricing change',
  '0002 ; 2026-08-22T09:05:00Z ; coordinator ; researcher+writer+archivist ; request ; 0001 ;  ;  ; messages\\0002-b.md ; Your read on the pricing change'
);

test('one request to several agents is outstanding on every one of them', () => {
  const f = fold(MULTI_RECIPIENT, SETTINGS);
  for (const who of ['researcher', 'writer', 'archivist']) {
    assert.deepEqual(awaiting(f, who).map((o) => o.row.id), ['0002'], `${who} must be invoked`);
  }
  assert.deepEqual(awaiting(f, 'coordinator'), [], 'blocked by the request it wrote');
});

/** The same request with two of the three recipients answered. */
const TWO_ANSWERED = MULTI_RECIPIENT.concat(
  rows(
    '0003 ; 2026-08-22T09:20:00Z ; researcher ; coordinator ; response ; 0002 ;  ; done ; messages\\0003-c.md ; Mine',
    '0004 ; 2026-08-22T09:25:00Z ; writer ; coordinator ; response ; 0002 ;  ; done ; messages\\0004-d.md ; Mine too'
  )
);

test('one request to several agents is released by the last reply, not the first', () => {
  const partial = fold(TWO_ANSWERED, SETTINGS);
  assert.deepEqual(
    awaiting(partial, 'coordinator'),
    [],
    'two of three answered is not enough — the row is still open on the archivist'
  );
  assert.deepEqual(awaiting(partial, 'archivist').map((o) => o.row.id), ['0002']);
  assert.deepEqual(awaiting(partial, 'researcher'), [], 'an agent that answered is not asked twice');

  const done = fold(
    TWO_ANSWERED.concat(
      rows(
        '0005 ; 2026-08-22T09:30:00Z ; archivist ; coordinator ; response ; 0002 ;  ; done ; messages\\0005-e.md ; And mine'
      )
    ),
    SETTINGS
  );
  const forCoordinator = awaiting(done, 'coordinator');
  assert.deepEqual(
    forCoordinator.map((o) => o.row.id),
    ['0001'],
    'the last reply hands the coordinator its own row back, once'
  );
  assert.deepEqual(forCoordinator[0]!.blockedBy, []);
});

test('a report from one recipient does not discharge that recipient', () => {
  // M9 — reports are for the operator, not answers. The distinction matters most on
  // this shape: a report that closed a recipient's share would release the whole row
  // early for everyone still working.
  const f = fold(
    MULTI_RECIPIENT.concat(
      rows(
        '0003 ; 2026-08-22T09:20:00Z ; researcher ; coordinator ; report ; 0002 ;  ;  ; messages\\0003-c.md ; Started on it'
      )
    ),
    SETTINGS
  );
  assert.deepEqual(awaiting(f, 'researcher').map((o) => o.row.id), ['0002'], 'still owed');
});

/**
 * The shape this rule exists for, and it was measured before it was written.
 *
 * On the live ledger: PR asked Research for a survey (row 0041, no `replyTo` — PR
 * opened the thread itself), Research delivered it (0043, `done`). The fold reported
 * nothing outstanding, `dispatch.jsonl` recorded no invocation of PR afterwards, and
 * the survey sat in a closed thread. Nothing failed. The work simply stopped, with
 * the agent that asked for it never told it had arrived.
 *
 * `blockedBy` hid this for as long as it did because the delegation shape works: when
 * the requester is itself answering something, its parent row brings it back. That is
 * the OPERATOR_STARTED fixture above. It only fails when the requester started the
 * thread — which is every request an agent makes on its own initiative.
 */
test('an agent-started chain returns to the requester once it is answered', () => {
  const f = fold(AGENT_STARTED, SETTINGS);

  const back = awaiting(f, 'coordinator');
  assert.deepEqual(back.map((o) => o.row.id), ['0001'], 'the requester is pulled back in');
  assert.equal(back[0]!.reason, 'undelivered-answer');
  assert.deepEqual(back[0]!.answeredBy.map((r) => r.id), ['0002'], 'and is handed the answer');
  assert.deepEqual(awaiting(f, 'worker'), [], 'the worker owes nothing further');
  assert.equal(f.openThreads.length, 1, 'the thread is not over until someone reads the answer');
});

test('any row from the requester discharges it — that is what picking it up means', () => {
  const f = fold(
    AGENT_STARTED.concat(
      rows(
        '0003 ; 2026-08-22T09:30:00Z ; coordinator ; operator ; report ; 0001 ;  ;  ; messages\\0003-c.md ; Filed it, here is where it landed'
      )
    ),
    SETTINGS
  );
  assert.deepEqual(awaiting(f, 'coordinator'), [], 'it has been picked up');
  assert.equal(f.openThreads.length, 0, 'and now the chain is over');
  assert.equal(f.awaitingBy.size, 0, 'with nothing left to dispatch');
});

test('the requester is not invoked twice for one answer it has already read', () => {
  // The discharging row does not have to be addressed to anyone in particular, and
  // does not have to reply to the request. Anything the requester writes into the
  // thread is evidence it saw the answer.
  const f = fold(
    AGENT_STARTED.concat(
      rows(
        '0003 ; 2026-08-22T09:30:00Z ; coordinator ; reviewer ; request ; 0002 ;  ;  ; messages\\0003-c.md ; Check this before I file it'
      )
    ),
    SETTINGS
  );
  assert.deepEqual(
    awaiting(f, 'coordinator'),
    [],
    'the coordinator acted on it; the ball is with the reviewer now'
  );
  assert.deepEqual(awaiting(f, 'reviewer').map((o) => o.row.id), ['0003']);
});

test('an answer to the operator ends the chain — the human is not dispatchable', () => {
  // An item resting on a party that can never be invoked would never be discharged:
  // every finished thread would read as open forever, and L7 would call all of them
  // stale three days later.
  const f = fold(
    rows(
      '0001 ; 2026-08-22T09:00:00Z ; operator ; worker ; request ;  ;  ;  ; messages\\0001-a.md ; Please do the thing',
      '0002 ; 2026-08-22T09:20:00Z ; worker ; operator ; response ; 0001 ;  ; done ; messages\\0002-b.md ; Done, the file is at X'
    ),
    SETTINGS
  );
  assert.equal(f.awaitingBy.size, 0, 'nothing is waiting on anyone');
  assert.equal(f.openThreads.length, 0);
});

/**
 * `information` — a fact handed to an agent for its own notes.
 *
 * The type would be inert without this: dispatch reads `awaitingBy` and nothing
 * else, so a type that never becomes outstanding is never delivered, and the row
 * sits in the ledger unread by the one party it was addressed to.
 */
const INFORMATION = rows(
  '0001 ; 2026-08-21T09:00:00Z ; operator ; worker ; information ;  ;  ;  ; messages\\0001-a.md ; The Q3 source moved to the finance share'
);

test('an information row is delivered to its addressee', () => {
  const f = fold(INFORMATION, SETTINGS);
  const forWorker = awaiting(f, 'worker');
  assert.deepEqual(forWorker.map((o) => o.row.id), ['0001']);
  assert.equal(forWorker[0]!.reason, 'unread-information');
  assert.deepEqual(forWorker[0]!.blockedBy, [], 'nothing to wait for — it can act at once');
  assert.equal(f.openThreads.length, 1);
});

test('any reply from the addressee closes an information row', () => {
  // A report, not a response: there is no outcome to state, because nothing was
  // asked. M1 would refuse an outcome on a report anyway.
  const f = fold(
    INFORMATION.concat(
      rows(
        '0002 ; 2026-08-21T09:40:00Z ; worker ; operator ; report ; 0001 ;  ;  ; messages\\0002-b.md ; Noted in notes.md under sources'
      )
    ),
    SETTINGS
  );
  assert.deepEqual(awaiting(f, 'worker'), [], 'it must not come back a second time');
  assert.equal(f.openThreads.length, 0, 'and the thread is over');
});

test('an information row addressed to several agents waits on each of them separately', () => {
  const f = fold(
    rows(
      '0001 ; 2026-08-21T09:00:00Z ; operator ; worker+coordinator ; information ;  ;  ;  ; messages\\0001-a.md ; The Q3 source moved',
      '0002 ; 2026-08-21T09:40:00Z ; worker ; operator ; report ; 0001 ;  ;  ; messages\\0002-b.md ; Noted'
    ),
    SETTINGS
  );
  assert.deepEqual(awaiting(f, 'worker'), [], 'the one who acknowledged is done');
  assert.deepEqual(awaiting(f, 'coordinator').map((o) => o.row.id), ['0001'], 'the other is not');
});

test('an information row is not a decision and stays out of the digest', () => {
  // Both are facts worth keeping, and the digest goes to everyone. An information
  // row is addressed to someone in particular, so it must not leak into every cold
  // prompt in the system.
  const f = fold(INFORMATION, SETTINGS);
  assert.deepEqual(f.decisions, []);
});
/**
 * `deliverable` and `partial` — the two shapes the return leg exists to carry.
 *
 * A `deliverable` is a response that produced something and says where it is. It has
 * to discharge the request exactly as a response does: a new answering type the fold
 * does not recognise fails in the worst way available — the answer lands, the request
 * stays outstanding, and the agent that already did the work is invoked to do it
 * again. That is why `ANSWERING_TYPES` is derived from the type table rather than
 * spelled out here.
 */
test('a deliverable discharges a request exactly as a response does', () => {
  const f = fold(
    rows(
      '0001 ; 2026-08-22T09:00:00Z ; coordinator ; worker ; request ;  ;  ;  ; messages\\0001-a.md ; Write the survey',
      '0002 ; 2026-08-22T09:20:00Z ; worker ; coordinator ; deliverable ; 0001 ;  ; done ; messages\\0002-b.md ; Survey at C:\\Shared\\survey.md'
    ),
    SETTINGS
  );
  assert.deepEqual(awaiting(f, 'worker'), [], 'the worker is finished');
  const back = awaiting(f, 'coordinator');
  assert.deepEqual(back.map((o) => o.reason), ['undelivered-answer']);
  assert.deepEqual(back[0]!.answeredBy.map((r) => r.type), ['deliverable']);
});

test('a partial answer closes the request and returns it, like any other outcome', () => {
  // `partial` must close. An outcome that reported work-not-done without discharging
  // the row would put the agent that already said it could not finish back in the
  // queue to try again, which is the one thing it just said would not work.
  const f = fold(
    rows(
      '0001 ; 2026-08-22T09:00:00Z ; coordinator ; worker ; request ;  ;  ;  ; messages\\0001-a.md ; Survey fifteen sites',
      '0002 ; 2026-08-22T09:20:00Z ; worker ; coordinator ; deliverable ; 0001 ;  ; partial ; messages\\0002-b.md ; Twelve done, three unreachable'
    ),
    SETTINGS
  );
  assert.deepEqual(awaiting(f, 'worker'), []);
  assert.deepEqual(awaiting(f, 'coordinator').map((o) => o.reason), ['undelivered-answer']);
});

/**
 * M5's ceiling, and the loop it could not previously see.
 *
 * A `request` carries no outcome (M1), so a requester that reads a refusal and asks
 * again produces a round the counter never counted. On the live ledger the counter
 * had never fired once: 43 rows, no `rejected` at all, and two permission walls
 * reported inside `done` bodies.
 */
test('a blocked answer alone is not a rejection round', () => {
  const f = fold(
    rows(
      '0001 ; 2026-08-22T09:00:00Z ; coordinator ; worker ; request ;  ;  ;  ; messages\\0001-a.md ; Fetch the figures',
      '0002 ; 2026-08-22T09:20:00Z ; worker ; coordinator ; response ; 0001 ;  ; blocked ; messages\\0002-b.md ; No web tool in my grants'
    ),
    SETTINGS
  );
  assert.equal(f.threads[0]!.rejectionCount, 0, 'reporting a wall correctly is not a refusal');
  assert.equal(f.threads[0]!.halted, false);
});

test('re-asking the agent that just hit a wall counts towards the ceiling', () => {
  const base = [
    '0001 ; 2026-08-22T09:00:00Z ; coordinator ; worker ; request ;  ;  ;  ; messages\\0001-a.md ; Fetch the figures',
    '0002 ; 2026-08-22T09:20:00Z ; worker ; coordinator ; response ; 0001 ;  ; blocked ; messages\\0002-b.md ; No web tool in my grants',
    '0003 ; 2026-08-22T09:30:00Z ; coordinator ; worker ; request ; 0002 ;  ;  ; messages\\0003-c.md ; Please try again',
  ];
  let f = fold(rows(...base), SETTINGS);
  assert.equal(f.threads[0]!.rejectionCount, 1);
  assert.equal(f.threads[0]!.halted, false, 'one round is not a halt — the grant may have changed');

  f = fold(
    rows(
      ...base,
      '0004 ; 2026-08-22T09:40:00Z ; worker ; coordinator ; response ; 0003 ;  ; blocked ; messages\\0004-d.md ; Still no web tool',
      '0005 ; 2026-08-22T09:50:00Z ; coordinator ; worker ; request ; 0004 ;  ;  ; messages\\0005-e.md ; Try once more'
    ),
    SETTINGS
  );
  assert.equal(f.threads[0]!.rejectionCount, 2);
  assert.equal(f.threads[0]!.halted, true, 'M5 stops it and escalates rather than looping');
  assert.equal(f.awaitingBy.size, 0, 'nothing is dispatched from a halted thread');
});

test('re-routing to a different agent after a wall is not a rejection round', () => {
  // The instruction the requester is given is to re-route, so doing it must not be
  // what trips the ceiling.
  const f = fold(
    rows(
      '0001 ; 2026-08-22T09:00:00Z ; coordinator ; worker ; request ;  ;  ;  ; messages\\0001-a.md ; Fetch the figures',
      '0002 ; 2026-08-22T09:20:00Z ; worker ; coordinator ; response ; 0001 ;  ; blocked ; messages\\0002-b.md ; No web tool in my grants',
      '0003 ; 2026-08-22T09:30:00Z ; coordinator ; researcher ; request ; 0002 ;  ;  ; messages\\0003-c.md ; You have web — can you'
    ),
    SETTINGS
  );
  assert.equal(f.threads[0]!.rejectionCount, 0);
  assert.deepEqual(awaiting(f, 'researcher').map((o) => o.row.id), ['0003']);
});

test('asking again after a partial answer is not a rejection round', () => {
  // The whole point of `partial` is that re-stating the ask differently is the right
  // move. Counting it would halt the thread for doing what it was told to do.
  const f = fold(
    rows(
      '0001 ; 2026-08-22T09:00:00Z ; coordinator ; worker ; request ;  ;  ;  ; messages\\0001-a.md ; Survey fifteen sites',
      '0002 ; 2026-08-22T09:20:00Z ; worker ; coordinator ; deliverable ; 0001 ;  ; partial ; messages\\0002-b.md ; Twelve done, three unreachable',
      '0003 ; 2026-08-22T09:30:00Z ; coordinator ; worker ; request ; 0002 ;  ;  ; messages\\0003-c.md ; Three replacements, blog pages not homepages'
    ),
    SETTINGS
  );
  assert.equal(f.threads[0]!.rejectionCount, 0);
  assert.equal(f.threads[0]!.halted, false);
});
