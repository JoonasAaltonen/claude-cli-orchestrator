/**
 * The ledger store. L1 append-only, L2 one writer, L3 one file per message.
 *
 * L1 — "Nothing is ever edited in place. Status, thread state and consensus are
 * derived by replaying rows, never stored. A correction is a new row referencing
 * the old one." There is no update method here and no delete method here. That is
 * the whole enforcement mechanism, and L9 says to hold it harder than convenience
 * will suggest.
 *
 * L2 — "Only the application writes to the ledger index." Every write path in the
 * application funnels through `appendRow` below. Agents produce message files in
 * their own outbox; sweep.ts validates them and calls this. Because the process is
 * single-writer and serial (D7), no file locking exists anywhere in this codebase
 * — which is the point, since the platform offers no usable cross-process lock.
 */
import path from 'node:path';
import type { Config } from '../config/load.js';
import { canonicalName, canonicaliseNames } from '../config/load.js';
import { indexHeaderLine, formatRow, nextId, parseLine, parseLegacyLine } from './row.js';
import type { ParsedLine, Row } from './row.js';
import { renderMessageFile, messageRelPath } from './message.js';
import type { MessageDraft } from './message.js';
import { appendLine, ensureDir, exists, readTextIfExists, writeText } from '../util/fsx.js';
import { canonical, refTo, slug } from '../util/paths.js';
import { nowIso } from '../util/time.js';
import { writeStatusFile } from './status-file.js';

/** The comms root layout. The application owns all of it (T6). */
export function layout(c: Config) {
  const root = canonical(c.commsRoot);
  return {
    root,
    index: path.join(root, 'index.jsonl'),
    /** The pre-NDJSON index, kept only so `migrate-index` can find it. */
    legacyIndex: path.join(root, 'index.txt'),
    messages: path.join(root, 'messages'),
    /** M7 — the rejected file is preserved, not deleted. */
    rejected: path.join(root, 'rejected'),
    state: path.join(root, 'state'),
    /** D6 — dispatch state is persisted per row, not as a high-water cursor. */
    dispatchState: path.join(root, 'state', 'dispatch.jsonl'),
    /** D12 — every invocation is logged. */
    invocations: path.join(root, 'state', 'invocations.jsonl'),
    /** D9 — the constructed prompt is logged per invocation. */
    prompts: path.join(root, 'state', 'prompts'),
    /** D13 — skills/commands snapshots, for the mechanical diff. */
    snapshots: path.join(root, 'state', 'snapshots'),
    /** C1 — chain budgets, recorded once at chain creation. */
    chains: path.join(root, 'state', 'chains.jsonl'),
    /** C3 — a kill-switch file, checked before every dispatch. */
    /** A rendered view of the fold, for agents — they cannot run the CLI (X1). */
    statusFile: path.join(root, 'status.md'),
    kill: path.join(root, 'KILL'),
  };
}

export async function initCommsRoot(c: Config): Promise<void> {
  const l = layout(c);
  await ensureDir(l.root);
  await ensureDir(l.messages);
  await ensureDir(l.rejected);
  await ensureDir(l.state);
  await ensureDir(l.prompts);
  await ensureDir(l.snapshots);
  if (!(await exists(l.index))) {
    await writeText(l.index, indexHeaderLine() + '\n');
  }
}

/**
 * Converts a pre-NDJSON `index.txt` into `index.jsonl`.
 *
 * Deliberately explicit rather than automatic. Silently rewriting a ledger is the
 * one thing an append-only design must not do behind the operator's back, and L1's
 * "nothing is ever edited in place" applies to us: the old file is left exactly
 * where it is, and a new one is written beside it.
 */
export async function migrateIndex(c: Config): Promise<{
  migrated: number;
  skipped: string[];
  from: string;
  to: string;
  alreadyDone: boolean;
}> {
  const l = layout(c);
  const legacy = await readTextIfExists(l.legacyIndex);
  if (legacy === null) {
    return { migrated: 0, skipped: [], from: l.legacyIndex, to: l.index, alreadyDone: true };
  }

  const existing = await readIndex(c);
  if (existing.rows.length) {
    throw new Error(
      `${l.index} already holds ${existing.rows.length} row(s). Refusing to merge two ledgers — move one aside first.`
    );
  }

  await ensureDir(l.root);
  const lines: string[] = [indexHeaderLine()];
  const skipped: string[] = [];
  let migrated = 0;

  for (const raw of legacy.split('\n')) {
    const row = parseLegacyLine(raw);
    if (!row) continue;
    try {
      lines.push(formatRow(row));
      migrated++;
    } catch (err: any) {
      skipped.push(`${raw.trim().slice(0, 80)} — ${err?.message ?? String(err)}`);
    }
  }

  await writeText(l.index, lines.join('\n') + '\n');
  return { migrated, skipped, from: l.legacyIndex, to: l.index, alreadyDone: false };
}

export interface LoadedIndex {
  rows: Row[];
  /** Lines that failed to parse. Surfaced, never silently dropped. */
  bad: ParsedLine[];
}

/** L1 — reading the ledger is replaying it. There is no cached state to go stale. */
export async function readIndex(c: Config): Promise<LoadedIndex> {
  const l = layout(c);
  const text = await readTextIfExists(l.index);
  const rows: Row[] = [];
  const bad: ParsedLine[] = [];
  if (!text) return { rows, bad };

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const parsed = parseLine(raw, i + 1);
    if (parsed.skip) continue;
    if (parsed.ok && parsed.row) rows.push(parsed.row);
    else bad.push(parsed);
  }
  return { rows, bad };
}

export interface AppendResult {
  row: Row;
  messageFile: string;
}

/**
 * The single write path (L2). Assigns ID, Time and Ref; writes the message file;
 * appends the index row.
 *
 * Order matters and is deliberate: the message file is written *before* the index
 * row. L3 makes the row an address label pointing at the file, so a crash between
 * the two leaves an unreferenced file — harmless, and visible — rather than a row
 * pointing at nothing, which every reader downstream would have to handle.
 */
export async function appendRow(
  c: Config,
  input: {
    writer: string;
    draft: MessageDraft;
    /** Overrides the derived time. Only fixtures and tests pass this. */
    time?: string;
  }
): Promise<AppendResult> {
  const l = layout(c);
  await initCommsRoot(c);

  const { rows } = await readIndex(c);
  const id = nextId(rows.map((r) => r.id));
  const rel = messageRelPath(id, input.draft.summary, slug);
  const abs = refTo(c.commsRoot, rel);

  const row: Row = {
    id,
    time: input.time ?? nowIso(),
    // T5 for names: the roster's spelling, so the fold's exact-string matching
    // cannot miss a recipient over a capital letter. Unrecognised names pass
    // through untouched — refusing them is the job of whoever accepted them.
    writer: canonicalName(c, input.writer) ?? input.writer,
    to: canonicaliseNames(c, input.draft.to),
    type: input.draft.type,
    replyTo: input.draft.replyTo,
    needs: canonicaliseNames(c, input.draft.needs),
    outcome: input.draft.outcome,
    ref: rel,
    summary: input.draft.summary,
  };

  // formatRow throws on a malformed row, so nothing invalid can reach the index
  // even by an internal caller's mistake (M7 applies to us too).
  const line = formatRow(row);

  await writeText(abs, renderMessageFile(input.draft));
  await appendLine(l.index, line);

  // The rendered view, refreshed here because this is L2's single writer and so the
  // only place it can be guaranteed current. Agents have no shell and cannot run
  // `orchestrator status`; this is how they read the fold instead of re-deriving it
  // from raw NDJSON. It never throws — the row is the record, this is a view of it.
  await writeStatusFile(c, [...rows, row]);

  return { row, messageFile: abs };
}

export function messagePath(c: Config, row: Row): string | null {
  return row.ref ? refTo(c.commsRoot, row.ref) : null;
}

export async function readMessageBody(c: Config, row: Row): Promise<string | null> {
  const p = messagePath(c, row);
  if (!p) return null;
  const text = await readTextIfExists(p);
  if (text === null) return null;
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  return (m?.[1] ?? text).trim();
}

/** Append-only JSONL state. Same discipline as the index: never edited, only folded. */
export async function appendJsonl(file: string, record: unknown): Promise<void> {
  await appendLine(file, JSON.stringify(record));
}

export async function readJsonl<T>(file: string): Promise<T[]> {
  const text = await readTextIfExists(file);
  if (!text) return [];
  const out: T[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      // A truncated final line after a crash. Skipped, not fatal — appending is
      // the only writer, so at most the last record can be incomplete.
    }
  }
  return out;
}
