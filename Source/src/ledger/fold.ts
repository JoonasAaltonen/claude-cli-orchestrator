/**
 * The fold: derived state, produced by replaying rows (L1). Nothing here is stored.
 *
 * L6 requires two outputs, not one:
 *   - open-thread status — what is outstanding, and on whom
 *   - a recent-decisions digest, built from `decision` rows, injected into every
 *     cold agent's prompt
 *
 * The second matters more than it looks: cold invocation (D1) means an agent knows
 * nothing that was settled since its instructions were written.
 *
 * This module is pure. It takes rows and a small settings object and returns
 * structures. §11 step 1 says the fold is testable against hand-written fixture rows
 * with nothing else built, and that is only true if it touches no filesystem.
 */
import type { Row } from './row.js';
import { OPERATOR, ORCHESTRATOR, ANSWERING_TYPES, CLOSING_OUTCOMES } from './row.js';
import { parseIso, daysBetween } from '../util/time.js';

export interface FoldSettings {
  staleThreadDays: number;
  /** M5 — two rejections on a thread, then it stops and escalates to the operator. */
  maxRejectionsPerThread: number;
  decisionsDigestLimit: number;
  now?: Date;
}

export interface Thread {
  /** The ID of the row that started the thread — the one with no ReplyTo. */
  rootId: string;
  rows: Row[];
  lastRow: Row;
  lastTime: Date | null;
  /** L7 — flagged, not closed. */
  stale: boolean;
  /** M5 — reached the rejection ceiling; halted and escalated, never auto-continued. */
  rejectionCount: number;
  halted: boolean;
  /** Rows still awaiting an answer, and from whom. */
  outstanding: Outstanding[];
  open: boolean;
  participants: string[];
}

/**
 * Why an item is outstanding, and what each surface says about it.
 *
 * A `Record` keyed by the reason, for the same purpose `MESSAGE_TYPE_INFO` serves in
 * row.ts: three separate `switch`es over this union already existed — the operator's
 * inbox, the generated status file and the dispatch prompt — and a fourth reason
 * added without a matching arm falls through to whichever branch happens to be last,
 * telling an agent the wrong thing about why it was invoked. Adding a reason here
 * without saying what it means does not compile.
 */
export const OUTSTANDING_REASONS = [
  'unanswered-request',
  'awaiting-signoff',
  'unread-information',
  'undelivered-answer',
] as const;
export type OutstandingReason = (typeof OUTSTANDING_REASONS)[number];

export interface ReasonInfo {
  /** Third person, short. The operator's inbox and the status file table. */
  short: string;
  /** Second person, addressed to the agent being dispatched. */
  onYou: string;
}

export const REASON_INFO: Readonly<Record<OutstandingReason, ReasonInfo>> = {
  'unanswered-request': {
    short: 'unanswered request',
    onYou: 'you have not answered this request',
  },
  'awaiting-signoff': {
    short: 'sign-off required',
    onYou: 'your sign-off is required (`needs`)',
  },
  'unread-information': {
    short: 'information unacknowledged',
    onYou: 'this was sent to you to keep, and you have not acknowledged it',
  },
  'undelivered-answer': {
    short: 'answered, requester has not picked it up',
    onYou: 'you asked for this and it has been answered — nobody has done anything with the answer yet',
  },
};

export interface Outstanding {
  row: Row;
  /** Who the ball is with. */
  awaiting: string[];
  reason: OutstandingReason;
  /**
   * For `undelivered-answer`: the rows that answered, oldest first.
   *
   * Carried on the item rather than looked up by the renderers, because the thing the
   * requester needs to see is the answer, while the row the item hangs off — and the
   * row dispatch state is keyed by — is the request. Empty for every other reason.
   */
  answeredBy: Row[];
  /**
   * Rows the awaiting party is itself still waiting on before it can act — its own
   * unanswered requests, further down the same thread.
   *
   * This is what makes D10a's two-invocation shape work. In the §13b chain the
   * coordinator is dispatched for row 1, delegates by writing row 2, and row 1 is
   * *still* outstanding on the coordinator — correctly, because it has not been
   * answered. But the coordinator cannot progress it until the worker replies, and
   * re-dispatching it immediately would just make it delegate again.
   *
   * Derived, never stored. The alternative — marking row 1 "handled" in dispatch
   * state because the invocation produced *an* artefact — conflates "this invocation
   * produced something" with "this row is answered", and is exactly the mutable
   * derived state L1 and L9 forbid. It also silently ends the chain one hop short.
   */
  blockedBy: string[];
}

export interface DecisionEntry {
  id: string;
  time: string;
  writer: string;
  summary: string;
  ref: string | null;
}

export interface Fold {
  rows: Row[];
  byId: Map<string, Row>;
  threads: Thread[];
  threadOf: Map<string, Thread>;
  /** L6 output 1. */
  openThreads: Thread[];
  staleThreads: Thread[];
  haltedThreads: Thread[];
  /** L6 output 2. */
  decisions: DecisionEntry[];
  /** T4 — "If agents need to know who exists, derive a participant list from the index." */
  participants: string[];
  /** Every outstanding item, keyed by who it is waiting on. */
  awaitingBy: Map<string, Outstanding[]>;
}

export function fold(rows: Row[], settings: FoldSettings): Fold {
  const now = settings.now ?? new Date();
  const byId = new Map<string, Row>();
  for (const r of rows) byId.set(r.id, r);

  const rootFor = (row: Row): string => walkToRoot(row, byId).rootId;

  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const root = rootFor(r);
    const list = groups.get(root);
    if (list) list.push(r);
    else groups.set(root, [r]);
  }

  const threads: Thread[] = [];
  const threadOf = new Map<string, Thread>();

  for (const [rootId, group] of groups) {
    // Rows are appended in ID order and IDs are a zero-padded sequence, so string
    // sort is chronological. Not relying on Time, which an operator may hand-write.
    group.sort((a, b) => a.id.localeCompare(b.id));
    const lastRow = group[group.length - 1]!;
    const lastTime = parseIso(lastRow.time);

    const rejectionCount = rejectionRounds(group);
    const halted = rejectionCount >= settings.maxRejectionsPerThread;

    const outstanding = outstandingIn(group);
    const open = outstanding.length > 0 && !halted;

    const participants = uniq(group.flatMap((r) => [r.writer, ...r.to]));

    const thread: Thread = {
      rootId,
      rows: group,
      lastRow,
      lastTime,
      // L7 — a thread older than N days is surfaced to a human. Only open threads
      // can be stale; a finished thread being old is not a finding.
      stale: open && !!lastTime && daysBetween(lastTime, now) > settings.staleThreadDays,
      rejectionCount,
      halted,
      outstanding,
      open,
      participants,
    };
    threads.push(thread);
    for (const r of group) threadOf.set(r.id, thread);
  }

  threads.sort((a, b) => a.rootId.localeCompare(b.rootId));

  // L6 output 2 — the recent-decisions digest, most recent last so a cold agent
  // reads it in the order things were settled.
  const decisions: DecisionEntry[] = rows
    .filter((r) => r.type === 'decision')
    .slice(-settings.decisionsDigestLimit)
    .map((r) => ({ id: r.id, time: r.time, writer: r.writer, summary: r.summary, ref: r.ref }));

  // What each party can act on *now*. A blocked item is still outstanding — it stays
  // in the thread and in the status view — but it is not dispatchable, because the
  // agent it is on is waiting for someone else.
  const awaitingBy = new Map<string, Outstanding[]>();
  for (const t of threads) {
    if (t.halted) continue;
    for (const o of t.outstanding) {
      if (o.blockedBy.length) continue;
      for (const who of o.awaiting) {
        const list = awaitingBy.get(who);
        if (list) list.push(o);
        else awaitingBy.set(who, [o]);
      }
    }
  }

  return {
    rows,
    byId,
    threads,
    threadOf,
    openThreads: threads.filter((t) => t.open),
    staleThreads: threads.filter((t) => t.stale),
    haltedThreads: threads.filter((t) => t.halted),
    decisions,
    participants: uniq(rows.flatMap((r) => [r.writer, ...r.to])).sort(),
    awaitingBy,
  };
}

/**
 * D10a — "The thread, not the triggering row, is the unit handed to an agent."
 *
 * Walks back through ReplyTo to the row that started the thread, returning the
 * chain root-first. This is the requirement §13b calls "the one most likely to be
 * discovered late and expensively", because a single-hop test passes without it.
 *
 * A ReplyTo pointing at a missing ID, or a cycle, terminates the walk rather than
 * throwing: a broken link must degrade to a shorter thread, never to a crash that
 * stops the chain.
 */
export function walkToRoot(
  row: Row,
  byId: Map<string, Row>
): { rootId: string; chain: Row[]; broken: string | null } {
  const chain: Row[] = [row];
  const seen = new Set<string>([row.id]);
  let cur = row;
  let broken: string | null = null;

  while (cur.replyTo) {
    const parent = byId.get(cur.replyTo);
    if (!parent) {
      broken = cur.replyTo;
      break;
    }
    if (seen.has(parent.id)) {
      broken = parent.id;
      break;
    }
    seen.add(parent.id);
    chain.push(parent);
    cur = parent;
  }
  chain.reverse();
  return { rootId: chain[0]!.id, chain, broken };
}

/**
 * The rows in a thread an agent is a party to, root-first.
 *
 * L8 — "public index, addressed bodies". Every agent may read the index, so every
 * row of the thread is returned. Which *bodies* the agent may read is decided by
 * `mayReadBody` below, at the point the prompt is built.
 */
export function threadRows(f: Fold, rowId: string): Row[] {
  const t = f.threadOf.get(rowId);
  if (!t) {
    const r = f.byId.get(rowId);
    return r ? [r] : [];
  }
  return t.rows;
}

/**
 * L8 — "Message files are readable by the parties to that thread." A party is
 * anyone who wrote a row in the thread or was addressed by one. The operator and
 * the orchestrator read everything; they are the audit position.
 */
export function mayReadBody(thread: Thread, who: string): boolean {
  if (who === OPERATOR || who === ORCHESTRATOR) return true;
  return thread.participants.includes(who);
}

/**
 * What is still outstanding in a thread, and on whom.
 *
 * M3 — who closes a thread: "if done is observable, the doer closes; if done is a
 * judgement, the requester closes." That distinction is a human judgement about the
 * work, not something derivable from a row, so the fold does not attempt it. What
 * the fold does instead is mechanical and matches M2's default: a `request` is
 * outstanding until the agent it was addressed to answers it, and a row carrying a
 * non-blank `Needs` is outstanding until each named agent signs off. An
 * `information` row joins them, on the weakest terms of the three — outstanding
 * until its addressee has replied anything at all, because the point of the type is
 * that the fact reaches a party who can write it into their own notes, and being
 * dispatched is the only way anything reaches an agent. Everything else is
 * report-and-act — one row, no counter-signature.
 */
function outstandingIn(group: Row[]): Outstanding[] {
  const out: Outstanding[] = [];

  // Index replies by the row they answer.
  const repliesTo = new Map<string, Row[]>();
  for (const r of group) {
    if (!r.replyTo) continue;
    const list = repliesTo.get(r.replyTo);
    if (list) list.push(r);
    else repliesTo.set(r.replyTo, [r]);
  }

  for (const r of group) {
    const replies = repliesTo.get(r.id) ?? [];

    // M2 — Needs is blank by default, and when it is not, sign-off is the gate.
    if (r.needs.length) {
      const signedOff = new Set(
        replies
          .filter((x) => x.type === 'signoff' && x.outcome && CLOSING_OUTCOMES.has(x.outcome))
          .map((x) => x.writer)
      );
      const missing = r.needs.filter((n) => !signedOff.has(n));
      if (missing.length) {
        out.push({ row: r, awaiting: missing, reason: 'awaiting-signoff', answeredBy: [], blockedBy: [] });
        continue;
      }
    }

    // An `information` row is addressed to someone so that they can keep the fact,
    // which means it has to reach them: nothing else in this application invokes an
    // agent, so a type that never becomes outstanding is a type that is never read.
    // Any reply from the addressee closes it — a one-line report that it was noted is
    // the expected answer, and there is nothing here for an outcome to describe, so
    // no particular type or outcome is demanded.
    if (r.type === 'information') {
      const acked = new Set(replies.map((x) => x.writer));
      const unread = r.to.filter((t) => !acked.has(t));
      if (unread.length) out.push({ row: r, awaiting: unread, reason: 'unread-information', answeredBy: [], blockedBy: [] });
      continue;
    }

    if (r.type !== 'request') continue;

    // A request is answered when each addressee has replied to it with one of the
    // answering types carrying a closing outcome. A `report` replying to a request
    // does not close it — reports are for the operator (M9), not answers.
    const answered = new Set(
      replies
        .filter((x) => ANSWERING_TYPES.has(x.type) && x.outcome && CLOSING_OUTCOMES.has(x.outcome))
        .map((x) => x.writer)
    );
    const missing = r.to.filter((t) => !answered.has(t));
    if (missing.length) out.push({ row: r, awaiting: missing, reason: 'unanswered-request', answeredBy: [], blockedBy: [] });
  }

  out.push(...undeliveredAnswers(group, repliesTo, out));

  // Second pass: an agent that owes an answer, but is itself waiting on a request it
  // wrote, cannot act yet. Needs every outstanding item to exist first, hence a pass
  // of its own rather than a branch above.
  const unansweredRequestsBy = new Map<string, string[]>();
  for (const o of out) {
    if (o.reason !== 'unanswered-request') continue;
    const list = unansweredRequestsBy.get(o.row.writer);
    if (list) list.push(o.row.id);
    else unansweredRequestsBy.set(o.row.writer, [o.row.id]);
  }

  const parent = new Map<string, string>();
  for (const r of group) if (r.replyTo) parent.set(r.id, r.replyTo);

  /** Is `id` somewhere below `maybeAncestor` in the ReplyTo chain? */
  const descendsFrom = (id: string, maybeAncestor: string): boolean => {
    const seen = new Set<string>();
    let cur = parent.get(id);
    while (cur && !seen.has(cur)) {
      if (cur === maybeAncestor) return true;
      seen.add(cur);
      cur = parent.get(cur);
    }
    return false;
  };

  for (const o of out) {
    for (const who of o.awaiting) {
      for (const id of unansweredRequestsBy.get(who) ?? []) {
        // A row never blocks itself.
        if (id === o.row.id) continue;

        // Only a *descendant* blocks. The case this rule exists for is coordinator
        // owing the operator an answer on row 1 while its own row 2 to the worker is
        // still open: row 2 descends from row 1, and its answer is the input to row
        // 1's answer, so row 1 genuinely cannot move.
        //
        // An ancestor must not block, and getting this wrong deadlocks the chain.
        // Measured live: the worker answered a request with another request, so
        // coordinator owed worker an answer on row 8 while its own row 6 — row 8's
        // *parent* — was still open. Blocking on the ancestor made each side wait for
        // the other, both vanished from `awaitingBy`, and the run reported quiescent
        // with the thread visibly open in `status`. Answering row 8 is precisely what
        // unblocks row 6; it cannot require row 6 first.
        if (!descendsFrom(id, o.row.id)) continue;

        if (!o.blockedBy.includes(id)) o.blockedBy.push(id);
      }
    }
  }

  return out;
}

/**
 * The return leg: an answer that reached nobody.
 *
 * Everything else in `outstandingIn` puts the ball on a *recipient*. Nothing put it
 * back on the agent that asked, and the consequence is not that a thread stalls —
 * it is that the thread closes, correctly and permanently, with the work done and
 * nobody informed. Measured live: PR asked Research for a survey, Research delivered
 * it, the fold recorded "nothing is outstanding", and PR — cold, and with no row left
 * addressed to it — was never invoked again. The deliverable sat in a closed thread.
 *
 * D10a's `blockedBy` already covers the case where the requester was itself answering
 * something: its parent row stays outstanding and brings it back. That is why this
 * was invisible for so long — the delegation shape works. It only fails when the
 * requester started the thread, which is every request an agent makes on its own
 * initiative rather than because it was told to.
 *
 * Three conditions, and each one is load-bearing:
 *
 *   - **Nothing else outstanding for that agent in this thread.** If there is, that
 *     item brings them back with the whole thread anyway (D10a), and two items would
 *     be two reasons for one invocation.
 *   - **They have written nothing since the newest answer.** Any row from them
 *     discharges it — a report saying what they did with it, a decision, a follow-up
 *     request. That is what "picked it up" means, and it is derived from the ledger
 *     rather than recorded anywhere (L1).
 *   - **Never the operator or the orchestrator.** Neither is dispatchable, so an item
 *     resting on them would never be discharged: every finished thread would read as
 *     open forever, and L7 would call all of them stale three days later. The human
 *     already has this view — it is the "finished without reporting to operator"
 *     section of the status file.
 */
function undeliveredAnswers(
  group: Row[],
  repliesTo: Map<string, Row[]>,
  existing: Outstanding[]
): Outstanding[] {
  const out: Outstanding[] = [];
  const stillOutstanding = new Set(existing.map((o) => o.row.id));
  const busy = new Set(existing.flatMap((o) => o.awaiting));

  for (const r of group) {
    // Only a row that asked for something can be answered. An `information` row is
    // excluded by that: its acknowledgement is a one-line report, and waking its
    // sender to be told the note was filed is an invocation that buys nothing.
    if (r.type !== 'request' && !r.needs.length) continue;
    if (stillOutstanding.has(r.id)) continue;

    const who = r.writer;
    if (who === OPERATOR || who === ORCHESTRATOR) continue;
    if (busy.has(who)) continue;

    const answers = (repliesTo.get(r.id) ?? []).filter(
      (x) => ANSWERING_TYPES.has(x.type) && x.outcome && CLOSING_OUTCOMES.has(x.outcome)
    );
    if (!answers.length) continue;

    // IDs are a zero-padded sequence but not a fixed width forever, so this compares
    // numerically rather than by string order.
    const newest = Math.max(...answers.map((a) => Number(a.id)));
    if (group.some((x) => x.writer === who && Number(x.id) > newest)) continue;

    out.push({ row: r, awaiting: [who], reason: 'undelivered-answer', answeredBy: answers, blockedBy: [] });
  }
  return out;
}

/** Every row in the ledger the given participant is waiting to act on. */
export function awaiting(f: Fold, who: string): Outstanding[] {
  return f.awaitingBy.get(who) ?? [];
}

/**
 * M5's counter — "two rejections on a thread, then it stops and escalates".
 *
 * An explicit `outcome: rejected` is one round. So is sending the same agent the same
 * work again after they answered `blocked` or `rejected`, which is the same event
 * wearing a different type: a `request` carries no outcome (M1), so a requester that
 * reads a refusal and asks again produces a loop the ceiling never sees. Measured on
 * the live ledger: 43 rows, 18 `done`, one `blocked`, no `rejected` at all, with two
 * permission walls reported inside `done` bodies. The ceiling was counting an event
 * that had never once occurred.
 *
 * The countable event is the *refusal*, not the re-ask — a rejection and the request
 * that follows it are one round between them, and counting both halts a thread at
 * three rows of ordinary back-and-forth. So a `rejected` answer counts on its own,
 * and a `blocked` answer counts only once someone has sent it back to the same agent.
 *
 * `blocked` needs that second condition and `rejected` does not, because the two mean
 * different things when nothing follows them. An unanswered rejection is still a
 * refusal of work that was asked for. An unanswered `blocked` is frequently the honest
 * end of a thread — the agent hit a wall and said so — and counting it on its own
 * would halt a thread for reporting a fact correctly.
 *
 * Narrow on purpose. It counts only a re-ask aimed back at the agent that hit the
 * wall — not after `partial`, where asking again in different words is exactly the
 * wanted behaviour, and not after `done`, where a follow-up is ordinary work. And it
 * is a ceiling rather than a refusal, because the operator may have granted the
 * missing permission in between, which makes the second ask the right move.
 */
export function rejectionRounds(group: Row[]): number {
  const reAskedAgainst = new Set<string>();
  for (const r of group) {
    if (r.type !== 'request' || !r.replyTo) continue;
    const answered = group.find((x) => x.id === r.replyTo);
    if (!answered || !ANSWERING_TYPES.has(answered.type)) continue;
    if (r.to.includes(answered.writer)) reAskedAgainst.add(answered.id);
  }

  let rounds = 0;
  for (const r of group) {
    if (!ANSWERING_TYPES.has(r.type)) continue;
    if (r.outcome === 'rejected') rounds += 1;
    else if (r.outcome === 'blocked' && reAskedAgainst.has(r.id)) rounds += 1;
  }
  return rounds;
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
