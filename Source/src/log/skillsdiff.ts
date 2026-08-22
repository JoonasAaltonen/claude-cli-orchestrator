/**
 * D13 — "The application diffs each agent's `skills/` and `commands/` across every
 * invocation and records what changed."
 *
 * The reasoning is worth keeping next to the code, because the obvious reading of
 * this feature is the wrong one:
 *
 *   "X3 permits an agent to write its own skills, which is a durable behaviour
 *   change persisting into every future invocation — and unlike an instruction-file
 *   change it goes through no proposal step and leaves no ledger row. **The risk is
 *   drift and invisibility, not escalation.** A filesystem diff is mechanical, costs
 *   nothing, and does not depend on the agent reporting the change — which per V1 is
 *   the one thing known not to rely on."
 *
 * And T8: "D13's mechanical diff stays anyway, and not because an agent might lie —
 * it is V1 applied consistently: an agent's own account of what it did is unreliable
 * *even when it is trying*. Never ask an agent whether something happened when the
 * filesystem can be inspected instead."
 */
import path from 'node:path';
import type { Agent } from '../config/load.js';
import { sha256File, walkRelative } from '../util/fsx.js';

/** The two directories X3's table marks writable in the agent's own home. */
const WATCHED = ['.claude/skills', '.claude/commands'] as const;

export type Snapshot = Record<string, string>;

export interface SkillsDiff {
  added: string[];
  removed: string[];
  changed: string[];
  /** True when anything at all moved. Cheap for callers to branch on. */
  any: boolean;
}

export async function snapshot(agent: Agent): Promise<Snapshot> {
  const out: Snapshot = {};
  for (const rel of WATCHED) {
    const dir = path.join(agent.home, ...rel.split('/'));
    const files = await walkRelative(dir);
    for (const f of files) {
      try {
        out[`${rel}/${f}`] = await sha256File(path.join(dir, ...f.split('/')));
      } catch {
        // A file that vanished between the walk and the hash is a change in itself;
        // recording it as absent lets the diff report it as removed.
      }
    }
  }
  return out;
}

export function diffSnapshots(before: Snapshot, after: Snapshot): SkillsDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [file, hash] of Object.entries(after)) {
    const prev = before[file];
    if (prev === undefined) added.push(file);
    else if (prev !== hash) changed.push(file);
  }
  for (const file of Object.keys(before)) {
    if (after[file] === undefined) removed.push(file);
  }

  added.sort();
  removed.sort();
  changed.sort();
  return { added, removed, changed, any: added.length + removed.length + changed.length > 0 };
}

/** A one-line rendering for the operator report a change triggers (T8). */
export function describeDiff(d: SkillsDiff): string {
  const parts: string[] = [];
  if (d.added.length) parts.push(`${d.added.length} added`);
  if (d.changed.length) parts.push(`${d.changed.length} changed`);
  if (d.removed.length) parts.push(`${d.removed.length} removed`);
  return parts.join(', ') || 'no change';
}

export function diffBody(agent: Agent, d: SkillsDiff): string {
  const lines = [
    `\`${agent.name}\` changed its own skills or commands during an invocation.`,
    '',
    'This is permitted (X3, T8) and is not on its own a problem. It is reported because',
    'a self-written skill is a durable behaviour change that persists into every future',
    'invocation, goes through no proposal step, and leaves no ledger row of its own.',
    'The risk D13 names is drift and invisibility, not escalation.',
    '',
    `Directory: ${agent.home}`,
    '',
  ];
  const section = (title: string, files: string[]) => {
    if (!files.length) return;
    lines.push(`**${title}**`, '');
    for (const f of files) lines.push(`- \`${f}\``);
    lines.push('');
  };
  section('Added', d.added);
  section('Changed', d.changed);
  section('Removed', d.removed);
  lines.push(
    'This diff is mechanical and does not depend on the agent having reported the change.'
  );
  return lines.join('\n');
}
