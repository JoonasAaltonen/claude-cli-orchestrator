/**
 * `<commsRoot>/status.md` — the fold, rendered as a file agents can read.
 *
 * Agents have no shell (X1), so they cannot run `orchestrator status`. They *can*
 * read the comms root — it is on `--add-dir` with `Read` allowed and every write
 * denied (T6) — but the index is raw NDJSON, and working out what is unresolved from
 * it means walking `ReplyTo`, matching responses to requests, and deciding what is
 * blocked versus merely waiting. That is `fold.ts`, reimplemented in prose.
 *
 * Reimplementing it is not a theoretical risk: that logic has been wrong twice in
 * this repository, both times in ways that made a chain stop while every status field
 * reported success, and both times subtle enough to need a regression test to pin. An
 * agent re-deriving it from scratch each invocation will get it wrong differently
 * every time, and confidently.
 *
 * So the application renders its own answer and the agent reads facts instead.
 *
 * Written from `appendRow`, which L2 makes the only path into the index. That is the
 * point: freshness is guaranteed by construction rather than by remembering to call
 * this from every command that might have changed something. A file that is silently
 * stale is worse than no file, because it reads exactly like a current one.
 */
import path from 'node:path';
import type { Config } from '../config/load.js';
import type { Row } from './row.js';
import { OPERATOR } from './row.js';
import { fold } from './fold.js';
import type { Fold, Thread } from './fold.js';
import { writeText } from '../util/fsx.js';

/** Marks the file as generated, and carries the version of this renderer. */
export const STATUS_MARKER = 'orchestrator-status';
export const STATUS_VERSION = 'v1';

export function statusFilePath(commsRoot: string): string {
  return path.join(commsRoot, 'status.md');
}

/** How many finished threads are listed before the section is truncated. */
const RECENT_CLOSED = 15;

export interface StatusFileOptions {
  staleThreadDays: number;
  maxRejectionsPerThread: number;
  decisionsDigestLimit: number;
  now?: Date;
}

export function renderStatusFile(rows: Row[], opts: StatusFileOptions): string {
  const f = fold(rows, opts);
  const now = opts.now ?? new Date();
  const out: string[] = [];

  out.push(`<!-- ${STATUS_MARKER}:${STATUS_VERSION} — generated. Overwritten on every ledger write; do not edit. -->`);
  out.push('# Ledger status');
  out.push('');
  out.push(`Generated ${now.toISOString()} from **${rows.length} row(s)**.`);
  out.push('');
  out.push(
    '> **Check this is current before you rely on it.** `index.jsonl` has one line per row plus a'
  );
  out.push(
    `> schema header on the first line, so it should have **${rows.length + 1} line(s)**. If it has more,`
  );
  out.push('> this file was written before the newest rows and you are reading a stale picture —');
  out.push('> say so rather than acting on it.');
  out.push('');
  out.push('You cannot write here. The application owns the comms root entirely (T6).');
  out.push('');

  // ---- what is still moving -------------------------------------------------
  const open = f.openThreads.filter((t) => !t.halted);
  out.push('---');
  out.push('');
  if (!open.length) {
    out.push('## Nothing is outstanding');
    out.push('');
    out.push('Every thread has been answered. No agent is waiting on another.');
  } else {
    out.push(`## Open threads (${open.length})`);
    out.push('');
    out.push('An item with nothing in **Blocked by** can be acted on now. One that is blocked is');
    out.push('waiting on a row further down the same thread, not on a person.');
    for (const t of open) out.push(...renderThread(t, now, opts.staleThreadDays));
  }
  out.push('');

  // ---- what will not move on its own ---------------------------------------
  const stuck = f.threads.filter((t) => t.halted || (t.stale && t.open));
  out.push('---');
  out.push('');
  if (!stuck.length) {
    out.push('## Nothing is stuck');
    out.push('');
    out.push('No thread has gone stale or hit the rejection ceiling.');
  } else {
    out.push(`## Needs a decision (${stuck.length})`);
    out.push('');
    out.push('These do not resume by themselves.');
    out.push('');
    for (const t of stuck) {
      const why = t.halted
        ? `halted after ${t.rejectionCount} rejection(s) — M5 stops a thread rather than letting it loop`
        : `no activity for over ${opts.staleThreadDays} day(s) — flagged, never auto-closed (L7)`;
      out.push(`- **${t.rootId}** — ${why}`);
      out.push(`  > ${t.rows[0]!.summary}`);
      out.push(`  Last movement: ${t.lastRow.id} from ${t.lastRow.writer}, ${age(t.lastTime, now)}.`);
    }
  }
  out.push('');

  // ---- finished, but nobody told the human ---------------------------------
  //
  // The case this section exists for: an agent delegates from a session a person
  // started, the work is done, the chain closes — and nothing in it is addressed to
  // the operator, so the person who set it off is never told. Correct behaviour, and
  // easy to miss, which is exactly what makes it worth listing.
  //
  // A thread only counts if something was actually *asked* in it. A lone `report` —
  // an M7 bounce, or a heads-up left with `/ledger-note` — is a notification, not a
  // piece of work someone is waiting on the result of, and listing those buries the
  // real cases under noise. Measured on a live ledger: without this the section was
  // two-thirds bounce rows.
  const closed = f.threads.filter((t) => !t.open && !t.halted);
  const unreported = closed.filter(
    (t) => t.rows.some((r) => r.type === 'request') && !t.rows.some((r) => r.to.includes(OPERATOR))
  );
  out.push('---');
  out.push('');
  if (!unreported.length) {
    out.push('## Everything finished has been reported');
    out.push('');
    out.push(`No closed thread is missing a message addressed to \`${OPERATOR}\`.`);
  } else {
    out.push(`## Finished without reporting to ${OPERATOR} (${unreported.length})`);
    out.push('');
    out.push('These completed and nothing in them is addressed to the human. That is correct for');
    out.push('an agent-to-agent side chain, and wrong if someone is waiting to hear the result.');
    out.push('');
    for (const t of unreported.slice(-RECENT_CLOSED).reverse()) {
      out.push(`- **${t.rootId}** — ${t.rows.length} row(s), started by ${t.rows[0]!.writer}, finished ${age(t.lastTime, now)}`);
      out.push(`  > ${t.rows[0]!.summary}`);
      out.push(`  Last word: ${t.lastRow.id} from ${t.lastRow.writer} — ${t.lastRow.summary}`);
    }
    if (unreported.length > RECENT_CLOSED) {
      out.push('');
      out.push(`_${unreported.length - RECENT_CLOSED} older one(s) not listed._`);
    }
  }
  out.push('');

  // ---- L6's second output ---------------------------------------------------
  out.push('---');
  out.push('');
  out.push('## Decisions on record');
  out.push('');
  if (!f.decisions.length) {
    out.push('_None. A `decision` row records something future work should not re-open._');
  } else {
    for (const d of f.decisions) {
      out.push(`- **${d.id}** (${d.writer}, ${d.time.slice(0, 10)}) ${d.summary}`);
    }
  }
  out.push('');

  out.push('---');
  out.push('');
  out.push('## Participants');
  out.push('');
  out.push(f.participants.join(' · '));
  out.push('');

  return out.join('\n');
}

function renderThread(t: Thread, now: Date, staleDays: number): string[] {
  const out: string[] = [''];
  out.push(`### Thread ${t.rootId} — ${t.rows.length} row(s), last moved ${age(t.lastTime, now)}`);
  out.push('');
  out.push(`> ${t.rows[0]!.summary}`);
  out.push('');
  out.push(`Participants: ${t.participants.join(', ')}`);
  if (t.stale) out.push(`\n**Stale** — nothing has moved for over ${staleDays} day(s).`);
  out.push('');
  out.push('| Row | From | Waiting on | Why | Blocked by |');
  out.push('|---|---|---|---|---|');
  for (const o of t.outstanding) {
    const why =
      o.reason === 'awaiting-signoff'
        ? 'sign-off required'
        : o.reason === 'unread-information'
          ? 'information unacknowledged'
          : 'unanswered request';
    out.push(
      `| ${o.row.id} | ${o.row.writer} | ${o.awaiting.join(', ')} | ${why} | ${o.blockedBy.join(', ') || '—'} |`
    );
  }
  out.push('');

  const actionable = t.outstanding.filter((o) => !o.blockedBy.length);
  if (actionable.length) {
    const who = [...new Set(actionable.flatMap((o) => o.awaiting))];
    out.push(
      `**Can move now:** ${who.join(', ')} — on ${actionable.map((o) => o.row.id).join(', ')}.`
    );
  } else {
    // Should not happen: every outstanding item blocked means the chain has stopped
    // while the thread still reads as open. Said plainly rather than left to be
    // inferred, because it is the shape of a real bug this repository has had.
    out.push('**Nobody can move.** Every outstanding item is blocked, so this thread will not');
    out.push('progress on its own. That is a defect worth reporting to the operator.');
  }
  return out;
}

function age(then: Date | null, now: Date): string {
  if (!then) return 'at an unknown time';
  const ms = now.getTime() - then.getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute(s) ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} hour(s) ago`;
  return `${Math.floor(hours / 24)} day(s) ago`;
}

/**
 * Renders and writes the file. Called from `appendRow`, so it cannot drift from the
 * index it describes.
 *
 * A failure here must never fail the append. The row is the record; this is a
 * convenience view of it, and losing the view is recoverable while losing the row is
 * not — L1 has no way to put it back.
 */
export async function writeStatusFile(config: Config, rows: Row[]): Promise<void> {
  try {
    const text = renderStatusFile(rows, {
      staleThreadDays: config.staleThreadDays,
      maxRejectionsPerThread: config.maxRejectionsPerThread,
      decisionsDigestLimit: config.decisionsDigestLimit,
    });
    await writeText(statusFilePath(config.commsRoot), text);
  } catch {
    // Deliberately silent. The next append rewrites it, and `doctor` reports a file
    // that has fallen behind the index.
  }
}

/** Exposed so `doctor` can say how far behind the file is, if at all. */
export function statusRowCount(text: string): number | null {
  const m = /from \*\*(\d+) row\(s\)\*\*/.exec(text);
  return m ? Number(m[1]) : null;
}

export type { Fold };
