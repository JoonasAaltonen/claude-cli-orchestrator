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
import { OPERATOR, ORCHESTRATOR } from './row.js';
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

export interface Outstanding {
  row: Row;
  /** Who the ball is with. */
  awaiting: string[];
  reason: 'unanswered-request' | 'awaiting-signoff';
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

const CLOSING_OUTCOMES = new Set(['done', 'deferred', 'rejected', 'blocked']);

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

    const rejectionCount = group.filter((r) => r.outcome === 'rejected').length;
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
 * non-blank `Needs` is outstanding until each named agent signs off. Everything
 * else is report-and-act — one row, no counter-signature.
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
        out.push({ row: r, awaiting: missing, reason: 'awaiting-signoff', blockedBy: [] });
        continue;
      }
    }

    if (r.type !== 'request') continue;

    // A request is answered when each addressee has replied to it with a response
    // or a signoff carrying an outcome. A `report` replying to a request does not
    // close it — reports are for the operator (M9), not answers.
    const answered = new Set(
      replies
        .filter(
          (x) =>
            (x.type === 'response' || x.type === 'signoff') &&
            x.outcome &&
            CLOSING_OUTCOMES.has(x.outcome)
        )
        .map((x) => x.writer)
    );
    const missing = r.to.filter((t) => !answered.has(t));
    if (missing.length) out.push({ row: r, awaiting: missing, reason: 'unanswered-request', blockedBy: [] });
  }

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

/** Every row in the ledger the given participant is waiting to act on. */
export function awaiting(f: Fold, who: string): Outstanding[] {
  return f.awaitingBy.get(who) ?? [];
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
