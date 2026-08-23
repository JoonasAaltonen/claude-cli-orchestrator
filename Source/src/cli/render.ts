/**
 * Terminal rendering. Kept apart from every module that decides anything, so
 * formatting can never accidentally become logic.
 *
 * M9 — "A rendered digest for reading is fine and is not a second source of truth,
 * because it is derived." Everything here is derived from the fold, on demand.
 */
import type { Config } from '../config/load.js';
import type { Fold, Thread, Outstanding } from '../ledger/fold.js';
import type { Row } from '../ledger/row.js';
import { formatDuration } from '../util/time.js';

const isTTY = process.stdout.isTTY === true;
const NO_COLOR = process.env.NO_COLOR !== undefined;

function c(code: string, s: string): string {
  return isTTY && !NO_COLOR ? `[${code}m${s}[0m` : s;
}
export const dim = (s: string) => c('2', s);
export const bold = (s: string) => c('1', s);
export const red = (s: string) => c('31', s);
export const green = (s: string) => c('32', s);
export const yellow = (s: string) => c('33', s);
export const blue = (s: string) => c('36', s);

export function heading(s: string): string {
  return `\n${bold(s)}\n${dim('─'.repeat(Math.min(s.length, 72)))}`;
}

export function rowLine(r: Row): string {
  const bits = [
    bold(r.id),
    dim(r.time.slice(0, 16).replace('T', ' ')),
    `${r.writer} → ${r.to.join('+')}`,
    typeBadge(r.type),
  ];
  if (r.replyTo) bits.push(dim(`re ${r.replyTo}`));
  if (r.outcome) bits.push(outcomeBadge(r.outcome));
  if (r.needs.length) bits.push(yellow(`needs ${r.needs.join('+')}`));
  return `${bits.join('  ')}\n     ${r.summary}`;
}

export function typeBadge(t: string): string {
  switch (t) {
    case 'request': return blue('request');
    case 'response': return green('response');
    case 'report': return dim('report');
    case 'signoff': return green('signoff');
    case 'decision': return yellow('decision');
    case 'information': return dim('information');
    default: return t;
  }
}

export function outcomeBadge(o: string): string {
  switch (o) {
    case 'done': return green('done');
    case 'rejected': return red('rejected');
    case 'blocked': return red('blocked');
    case 'deferred': return yellow('deferred');
    default: return o;
  }
}

export function verdictBadge(v: string): string {
  switch (v) {
    case 'worked': return green('worked');
    case 'ran-nothing': return yellow('ran but produced nothing');
    case 'produced-invalid': return yellow('produced invalid output');
    case 'process-failed': return red('process failed');
    case 'rate-limited': return red('rate limited');
    case 'timed-out': return red('timed out');
    case 'killed': return red('killed');
    default: return v;
  }
}

/** L6 output 1 — open-thread status: what is outstanding, and on whom. */
export function renderStatus(config: Config, f: Fold): string {
  const out: string[] = [];

  out.push(heading('Open threads'));
  if (!f.openThreads.length) {
    out.push(dim('  Nothing outstanding.'));
  } else {
    for (const t of f.openThreads) {
      out.push(`  ${threadLine(t)}`);
      for (const o of t.outstanding) {
        out.push(`    ${dim('waiting on')} ${bold(o.awaiting.join(', '))}  ${dim('·')}  ${o.row.id} ${o.row.summary}`);
      }
    }
  }

  // L7 — "Derived state flags stale threads; it does not close them. A thread older
  // than N days is surfaced to a human. Chasing is supervision and must not be
  // automated into a status field."
  if (f.staleThreads.length) {
    out.push(heading(`Stale — no movement in over ${config.staleThreadDays} day(s)`));
    out.push(dim('  Flagged for you, not closed. Chasing these is supervision (L7).'));
    for (const t of f.staleThreads) out.push(`  ${threadLine(t)}`);
  }

  // M5 — two rejections, then it stops and escalates to the operator.
  if (f.haltedThreads.length) {
    out.push(heading('Halted — two rejections, escalated to you (M5)'));
    for (const t of f.haltedThreads) out.push(`  ${threadLine(t)}`);
  }

  out.push(heading('Recent decisions'));
  if (!f.decisions.length) {
    out.push(dim('  None recorded. `decision` rows are injected into every cold agent prompt (L6).'));
  } else {
    for (const d of f.decisions) {
      out.push(`  ${bold(d.id)} ${dim(d.time.slice(0, 10))} ${d.writer}  ${d.summary}`);
    }
  }

  out.push(heading('Participants'));
  out.push(`  ${f.participants.join(' · ') || dim('none yet')}   ${dim('(derived from the index, never stored — T4)')}`);

  return out.join('\n');
}

function threadLine(t: Thread): string {
  const flags: string[] = [];
  if (t.stale) flags.push(yellow('stale'));
  if (t.halted) flags.push(red('halted'));
  if (t.rejectionCount) flags.push(red(`${t.rejectionCount} rejection(s)`));
  return `${bold(t.rootId)} ${dim(`${t.rows.length} row(s)`)} ${flags.join(' ')}\n     ${t.rows[0]!.summary}`;
}

/** J2 — "The operator needs a filtered view of what is waiting on them." */
export function renderInbox(who: string, items: Outstanding[], f: Fold): string {
  const out: string[] = [];
  out.push(heading(`Waiting on ${who}`));
  if (!items.length) {
    out.push(dim('  Nothing.'));
    return out.join('\n');
  }
  for (const o of items) {
    const t = f.threadOf.get(o.row.id);
    out.push(`  ${bold(o.row.id)} ${typeBadge(o.row.type)} ${dim('from')} ${o.row.writer}`);
    out.push(`     ${o.row.summary}`);
    const why =
      o.reason === 'awaiting-signoff'
        ? 'your sign-off is required'
        : o.reason === 'unread-information'
          ? 'information to note, unacknowledged'
          : 'unanswered request';
    out.push(`     ${dim(why)}${t ? dim(`  ·  thread ${t.rootId}, ${t.rows.length} row(s)`) : ''}`);
    if (o.row.ref) out.push(`     ${dim(o.row.ref)}`);
    out.push('');
  }
  return out.join('\n').trimEnd();
}

export function renderThread(t: Thread): string {
  const out = [heading(`Thread ${t.rootId}`)];
  for (const r of t.rows) out.push('  ' + rowLine(r).replace(/\n/g, '\n  '));
  return out.join('\n');
}

export function renderCost(costUsd: number | null | undefined): string {
  if (costUsd == null) return dim('cost unknown');
  // §14 — "The cost figure in the payload is a client-side estimate and can differ
  // from an actual bill... log the total, do not reason about the breakdown."
  return `${dim('~')}$${costUsd.toFixed(4)}`;
}

export function renderWall(ms: number | undefined): string {
  return ms == null ? '' : dim(formatDuration(ms));
}
