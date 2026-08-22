/**
 * D12 — "Every invocation is logged with: agent, row IDs, wall time, cost figure,
 * and outcome classification. Trivial to record at the time and impossible to
 * reconstruct afterwards."
 *
 * D9 — "The constructed prompt is logged per invocation." Same reason as D8: when
 * the template is wrong every agent misbehaves identically, and diagnosing that
 * means diffing what was sent against what the author thinks is sent. So the prompt
 * is written verbatim to its own file, not summarised into the log line.
 *
 * C8 — "The worst outcome of an overrun is not a spent window; it is a spent window
 * *plus* a ledger left in a state nobody can resume from. C2, D6 and D12 prevent the
 * second half. They are bookkeeping rather than guardrails, and they are what makes
 * finding out the hard way learnable instead of merely expensive."
 */
import path from 'node:path';
import type { Config } from '../config/load.js';
import { appendJsonl, layout, readJsonl } from '../ledger/store.js';
import type { InvocationResult, PermissionDenial } from '../dispatch/invoke.js';
import type { InvocationVerdict } from '../dispatch/sweep.js';
import type { SkillsDiff } from './skillsdiff.js';
import { writeText } from '../util/fsx.js';

export interface InvocationLogEntry {
  invocationId: string;
  agent: string;
  /** D12 — row IDs. The batch this invocation was dispatched for (D5). */
  rowIds: string[];
  threadRootIds: string[];
  startedAt: string;
  endedAt: string;
  /** D12 — wall time. */
  wallMs: number;
  /** D12 — cost figure. §14: a client-side estimate, not an accounting record. */
  costUsd: number | null;
  numTurns: number | null;

  /** D12 — outcome classification. V3's three outcomes, plus the guard cases. */
  verdict: InvocationVerdict;
  verdictWhy: string;

  /**
   * The CLI's own status fields, recorded because they are evidence, and kept in a
   * nested object because V1 says none of them may decide whether the run worked:
   * "a run that achieved nothing reported exit code 0, is_error: false, subtype:
   * success". Keeping them here rather than at the top level makes it visible in a
   * diff if anyone ever starts reading them as the verdict.
   */
  cliReported: {
    exitCode: number | null;
    signal: string | null;
    resultSubtype: string | null;
    isError: boolean | null;
    processOutcome: string;
  };

  /** V4 — captured and surfaced, with the full input the agent attempted. */
  permissionDenials: PermissionDenial[];
  /** D11 — the one-line confirmation. A free health check. */
  finalText: string | null;
  /** V5 — the raw event, kept so the detector can be refined against real data. */
  rateLimitEvent: unknown | null;
  /** The last rate-limit *status* event, which arrives on ordinary successful runs. */
  rateLimitStatus: unknown | null;

  /** V2 — what actually appeared in the outbox. The success criterion. */
  artefacts: string[];
  rejected: { preservedAt: string; errors: string[] }[];

  /** D13 — what changed in the agent's skills/ and commands/ across this invocation. */
  skillsDiff: SkillsDiff | null;

  /** D9 — where the constructed prompt was written. */
  promptFile: string;
  promptChars: number;
  promptTemplate: string;

  eventCounts: Record<string, number>;
  argv: string[];
  cwd: string;
  stderr: string;
  dryRun: boolean;
}

export async function appendInvocation(config: Config, entry: InvocationLogEntry): Promise<void> {
  await appendJsonl(layout(config).invocations, entry);
}

export async function readInvocationLog(config: Config): Promise<InvocationLogEntry[]> {
  return readJsonl<InvocationLogEntry>(layout(config).invocations);
}

/** D9 — the prompt, verbatim, one file per invocation. */
export async function writePromptLog(
  config: Config,
  invocationId: string,
  agent: string,
  prompt: string
): Promise<string> {
  const file = path.join(layout(config).prompts, `${invocationId}-${agent}.md`);
  await writeText(file, prompt);
  return file;
}

/** Assembles the log entry from the pieces the run loop holds. */
export function buildLogEntry(args: {
  result: InvocationResult;
  rowIds: string[];
  threadRootIds: string[];
  verdict: InvocationVerdict;
  verdictWhy: string;
  artefacts: string[];
  rejected: { preservedAt: string; errors: string[] }[];
  skillsDiff: SkillsDiff | null;
  promptFile: string;
  promptChars: number;
  promptTemplate: string;
  dryRun: boolean;
}): InvocationLogEntry {
  const r = args.result;
  return {
    invocationId: r.invocationId,
    agent: r.agent,
    rowIds: args.rowIds,
    threadRootIds: args.threadRootIds,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    wallMs: r.wallMs,
    costUsd: r.costUsd,
    numTurns: r.numTurns,
    verdict: args.verdict,
    verdictWhy: args.verdictWhy,
    cliReported: {
      exitCode: r.exitCode,
      signal: r.signal,
      resultSubtype: r.resultSubtype,
      isError: r.isError,
      processOutcome: r.outcome,
    },
    permissionDenials: r.permissionDenials,
    finalText: r.finalText,
    rateLimitEvent: r.rateLimitEvent,
    rateLimitStatus: r.rateLimitStatus,
    artefacts: args.artefacts,
    rejected: args.rejected,
    skillsDiff: args.skillsDiff,
    promptFile: args.promptFile,
    promptChars: args.promptChars,
    promptTemplate: args.promptTemplate,
    eventCounts: r.eventCounts,
    argv: r.argv,
    cwd: r.cwd,
    stderr: r.stderr,
    dryRun: args.dryRun,
  };
}
