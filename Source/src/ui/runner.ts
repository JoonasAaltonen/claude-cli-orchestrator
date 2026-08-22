/**
 * A run, driven from the dashboard and watched while it happens.
 *
 * A run is the one operation here that takes minutes and spends money, so the
 * page cannot simply wait for a response — the operator needs to see it moving,
 * and needs the kill switch to be reachable while it does.
 *
 * The shape is deliberately small: **one run at a time, in memory, on this
 * server.** The writer lock already guarantees one across processes, so a second
 * structure to arbitrate would be a second source of truth. Nothing here is
 * persisted, because nothing here is authoritative — the ledger is. If the server
 * dies mid-run, the rows already appended are the record, exactly as they would be
 * had the CLI been killed.
 */
import { randomUUID } from 'node:crypto';
import type { Config } from '../config/load.js';
import type { DispatchOutcome } from '../dispatch/run.js';
import { runUntilQuiescent } from '../dispatch/run.js';
import { acquireWriterLock, WriterLockHeld } from '../ledger/lock.js';
import type { HeldLock } from '../ledger/lock.js';

export interface RunEvent {
  type: 'log' | 'done' | 'error';
  text?: string;
  outcomes?: RunOutcomeSummary[];
  costUsd?: number;
  error?: string;
}

export interface RunOutcomeSummary {
  agent: string;
  rowIds: string[];
  /** No invocation happened: nothing pending, or a guard refused. */
  skipped: boolean;
  skipReason: string | null;
  verdict: string | null;
  verdictWhy: string | null;
  costUsd: number | null;
  wallMs: number | null;
  /** Artefact count, not contents — the ledger tab is where rows are read. */
  produced: number;
  rejected: number;
  /** The chain stopped here rather than running out of work. */
  stopChain: boolean;
  stopReason: string | null;
  authFailed: boolean;
}

export interface RunSession {
  id: string;
  who: string;
  startedAt: string;
  /** Everything emitted so far, so a late subscriber sees the whole run. */
  lines: string[];
  done: boolean;
  error: string | null;
  outcomes: RunOutcomeSummary[] | null;
  costUsd: number;
  listeners: Set<(ev: RunEvent) => void>;
}

let active: RunSession | null = null;

export function currentRun(): RunSession | null {
  return active;
}

/** What the page needs to render the console, minus the listener set. */
export function runSnapshot(s: RunSession | null) {
  if (!s) return null;
  return {
    id: s.id,
    who: s.who,
    startedAt: s.startedAt,
    lines: s.lines,
    done: s.done,
    error: s.error,
    outcomes: s.outcomes,
    costUsd: s.costUsd,
  };
}

export function subscribe(session: RunSession, fn: (ev: RunEvent) => void): () => void {
  session.listeners.add(fn);
  return () => session.listeners.delete(fn);
}

function emit(session: RunSession, ev: RunEvent): void {
  if (ev.type === 'log' && ev.text) session.lines.push(ev.text);
  for (const fn of session.listeners) {
    try {
      fn(ev);
    } catch {
      /* a dead subscriber must not stop the run */
    }
  }
}

function summarise(o: DispatchOutcome): RunOutcomeSummary {
  return {
    agent: o.agent,
    rowIds: o.rowIds,
    skipped: o.skipped,
    skipReason: o.skipReason ?? null,
    verdict: o.verdict ?? null,
    verdictWhy: o.verdictWhy ?? null,
    costUsd: o.costUsd ?? null,
    wallMs: o.wallMs ?? null,
    produced: o.produced.length,
    rejected: o.rejected,
    stopChain: o.stopChain,
    stopReason: o.stopReason ?? null,
    authFailed: !!o.authFailed,
  };
}

export interface StartRunOptions {
  sweepFirst: boolean;
  maxIterations?: number;
}

/**
 * Starts a run and returns immediately with the session.
 *
 * The lock is taken **before** returning, so a refusal reaches the operator as a
 * failed button press rather than as an error inside a console they have to go
 * looking at. It is released in a `finally`, whatever the run does.
 */
export async function startRun(config: Config, opts: StartRunOptions): Promise<RunSession> {
  if (active && !active.done) {
    throw new Error(`A run is already in progress here (${active.who}, started ${active.startedAt}).`);
  }

  let lock: HeldLock;
  try {
    lock = await acquireWriterLock(config, opts.sweepFirst ? 'ui: run --sweep' : 'ui: run');
  } catch (err) {
    // Surfaced verbatim: the message names the holder and how to clear it.
    if (err instanceof WriterLockHeld) throw err;
    throw err;
  }

  const session: RunSession = {
    id: randomUUID(),
    who: opts.sweepFirst ? 'Pick up pending work' : 'Start with instructions',
    startedAt: new Date().toISOString(),
    lines: [],
    done: false,
    error: null,
    outcomes: null,
    costUsd: 0,
    listeners: new Set(),
  };
  active = session;

  void (async () => {
    try {
      const outcomes = await runUntilQuiescent(config, {
        dryRun: false,
        sweepFirst: opts.sweepFirst,
        maxIterations: opts.maxIterations ?? 25,
        onLog: (l: string) => emit(session, { type: 'log', text: l }),
      });
      session.outcomes = outcomes.map(summarise);
      session.costUsd = outcomes.reduce((n, o) => n + (o.costUsd ?? 0), 0);
      session.done = true;
      emit(session, {
        type: 'done',
        outcomes: session.outcomes,
        costUsd: session.costUsd,
      });
    } catch (err: unknown) {
      session.error = err instanceof Error ? err.message : String(err);
      session.done = true;
      emit(session, { type: 'error', error: session.error });
    } finally {
      await lock.release();
    }
  })();

  return session;
}
