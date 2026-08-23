/**
 * Where errors go.
 *
 * The dashboard used to swallow them. A failed action printed one line of
 * `err.message` beside the button that caused it and nothing else happened
 * anywhere: not in the terminal `orchestrator ui` was started in, not in a file, not
 * even a stack in the browser unless the operator had devtools open at the moment it
 * happened. A `TypeError` in the page — reading `.value` of a control that was not
 * there — was indistinguishable, from the operator's seat, from the server refusing
 * the request. Both are "red text next to the button".
 *
 * So both halves report here. Server-side failures are logged where they happen;
 * the page posts its own uncaught errors to `/api/client-error`, which logs them the
 * same way and marks them `browser`. One place to look, and it is the terminal the
 * operator already has open.
 *
 * Two sinks, always both:
 *
 *   - **stderr**, because the console the application was started in is where
 *     someone is already looking, and an error that requires opening a file first is
 *     an error that gets ignored.
 *   - **`state/problems.jsonl`**, because the console scrolls, and the interesting
 *     question is usually "what happened while I was away".
 *
 * Appended, never rewritten, one JSON object per line — the same shape as every
 * other record this application keeps, for the same reason (T6, M8).
 *
 * Nothing here may throw into the path that called it. A logger that can fail a
 * request is worse than no logger: it turns a visible error into a different,
 * more confusing one.
 */
import path from 'node:path';
import process from 'node:process';
import type { Config } from '../config/load.js';
import { appendJsonl, layout, readJsonl } from '../ledger/store.js';
import { red, yellow, dim } from '../cli/render.js';

export interface Problem {
  /** Which side of the wire it happened on. */
  source: 'server' | 'browser';
  /** One line. The message, not the stack. */
  what: string;
  /** The request, or the page location — whatever names the place. */
  where?: string | null;
  /** HTTP status, when the failure produced a response. */
  status?: number | null;
  /** A stack, a body, a payload. Truncated, because a log is not a heap dump. */
  detail?: string | null;
}

export interface RecordedProblem extends Problem {
  at: string;
}

/** Long enough for a real stack, short enough that a loop cannot fill a disk. */
const MAX_DETAIL = 4000;

interface Sink {
  file: string | null;
  /** Appends are chained rather than fired in parallel, so lines cannot interleave. */
  tail: Promise<void>;
}

const sink: Sink = { file: null, tail: Promise.resolve() };

export function problemLogPath(config: Config): string {
  return path.join(layout(config).state, 'problems.jsonl');
}

/**
 * Point the file sink somewhere and say so once, at startup.
 *
 * Until this is called only stderr is written, which is the right behaviour for a
 * one-shot CLI command: it has a console, and it does not need to create a log file
 * to complain about a typo.
 */
export function startProblemLog(config: Config, override?: string | null): string {
  sink.file = override && override.trim() ? path.resolve(override.trim()) : problemLogPath(config);
  return sink.file;
}

/** For tests, and for a process that wants stderr only. */
export function stopProblemLog(): void {
  sink.file = null;
}

export function logProblem(p: Problem): void {
  const record: RecordedProblem = {
    at: new Date().toISOString(),
    source: p.source,
    what: oneLine(p.what),
    where: p.where ?? null,
    status: p.status ?? null,
    detail: p.detail ? clip(p.detail) : null,
  };

  // stderr first: it is the sink that cannot fail, and the one someone is watching.
  const tag = record.status && record.status < 500 ? yellow('problem') : red('ERROR');
  const at = record.at.slice(11, 19);
  const site = [record.source, record.where, record.status].filter(Boolean).join(' ');
  process.stderr.write(`${tag} ${dim(at)} ${site ? dim(site) + '  ' : ''}${record.what}\n`);
  if (record.detail) {
    for (const line of record.detail.split('\n')) process.stderr.write(dim('        ' + line) + '\n');
  }

  if (!sink.file) return;
  const file = sink.file;
  sink.tail = sink.tail
    .then(() => appendJsonl(file, record))
    .catch((err: unknown) => {
      // The log failing is itself worth one line, and only one — reporting it
      // through this function would recurse straight back into the same write.
      process.stderr.write(
        dim(`        [could not append to ${file}: ${err instanceof Error ? err.message : String(err)}]\n`)
      );
    });
}

/**
 * Everything recorded, oldest first. For `orchestrator problems` and the dashboard.
 *
 * `file` because the sink can be pointed elsewhere with `--log-file`, and a reader
 * that always looks in the default place would report "none" about a log that is
 * filling up — the most misleading answer available.
 */
export async function readProblems(config: Config, file?: string | null): Promise<RecordedProblem[]> {
  return readJsonl<RecordedProblem>(file && file.trim() ? path.resolve(file.trim()) : problemLogPath(config));
}

/** Waits for pending appends. Tests need it; nothing in the request path should. */
export async function flushProblemLog(): Promise<void> {
  await sink.tail;
}

function oneLine(s: string): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 300 ? t.slice(0, 299) + '…' : t || '(no message)';
}

function clip(s: string): string {
  const t = String(s);
  return t.length > MAX_DETAIL ? t.slice(0, MAX_DETAIL) + '\n[truncated]' : t;
}
