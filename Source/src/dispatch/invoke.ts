/**
 * Invoking the CLI. §5 dispatch, §6 judging success, §10 forward compatibility.
 *
 * V1 is the rule this module is built around: "Nothing about 'did this work' may be
 * decided from the CLI's status fields. Measured directly: a run that achieved
 * nothing reported exit code 0, is_error: false, subtype: success, terminal_reason:
 * completed, stop_reason: end_turn. Every status field reported success."
 *
 * So nothing here returns a boolean called `success`. It returns an
 * `InvocationResult` describing what the *process* did, and sweep.ts decides what
 * happened by looking for the artefact (V2). The two are deliberately in different
 * files so the status fields are never in scope where the judgement is made.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import process from 'node:process';
import type { Agent, Config } from '../config/load.js';
import { buildPermissionPlan, settingsPathFor } from './permissions.js';
import type { PermissionPlan } from './permissions.js';
import { mcpConfigPathFor, writeMcpConfig } from '../mcp/config.js';
import { writeText } from '../util/fsx.js';
import { nowIso } from '../util/time.js';

/** V3 — every invocation resolves to one of three outcomes, not two. */
export type ProcessOutcome =
  /** Clean exit. Whether it *worked* is not decided here — see V2 and sweep.ts. */
  | 'exited'
  /** V5 — a recognised rate limit. */
  | 'rate-limited'
  /** V7 — the documented unrecoverable hang: no output, no tool calls, no return. */
  | 'silence-timeout'
  | 'wall-timeout'
  /** V3 outcome 3 — a CLI-level fault. */
  | 'process-failed'
  /** C3 — the kill switch tripped mid-run, or the operator interrupted. */
  | 'killed';

export interface PermissionDenial {
  toolName: string;
  toolUseId: string;
  /** V4 — "the full input the agent attempted — the exact path and exact content". */
  toolInput: unknown;
}

export interface InvocationResult {
  invocationId: string;
  agent: string;
  outcome: ProcessOutcome;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  /** §14: a client-side estimate, mixed-model within one invocation. Log the total. */
  costUsd: number | null;
  numTurns: number | null;
  /** The CLI's own verdict. Recorded for the log, never consulted for a decision (V1). */
  resultSubtype: string | null;
  isError: boolean | null;
  /** V4 — captured and surfaced. A diagnostic, not the success test. */
  permissionDenials: PermissionDenial[];
  /** D11 — the one-line confirmation, which is the free health check. */
  finalText: string | null;
  /** V5 — the raw event that triggered rate-limit recognition, kept for refinement. */
  rateLimitEvent: unknown | null;
  /**
   * The most recent `rate_limit_event` from the stream, which is a *status* event,
   * not an error — it arrives on ordinary successful runs (measured: 3 of them on a
   * 24-second run that worked). §14 suggests reaching the reset times through a
   * status-line script, calling it "an awkward channel, but the documented one".
   * This is the same information arriving in the stream we already consume, so V6's
   * back-off can be a number rather than a guess without the second mechanism.
   *
   * It is recorded and never acted on automatically, because V5 forbids using our
   * own quota accounting to predict availability.
   */
  rateLimitStatus: unknown | null;
  stderr: string;
  /** Everything the stream carried, for the invocation log. */
  eventCounts: Record<string, number>;
  /**
   * Names of the tools the agent actually called, in first-use order. A diagnostic
   * only — V1 forbids deciding success from anything the CLI reports, and this is
   * no exception. It exists so a probe can distinguish "the mechanism did not fire"
   * from "the mechanism fired and produced nothing".
   */
  toolsUsed: string[];
  argv: string[];
  cwd: string;
}

export interface InvokeOptions {
  config: Config;
  agent: Agent;
  prompt: string;
  invocationId: string;
  /** C4 — dry-run mode from the first commit. Prints what would be sent, spends nothing. */
  dryRun?: boolean;
  /** C3 — polled during the run so the kill switch stops work already in flight. */
  shouldAbort?: () => boolean;
  onEvent?: (event: any) => void;
  /**
   * Widens `--tools` for this one invocation only. It cannot reach past a denial:
   * anything in `disallowedTools` is filtered back out, so X1 and X3 hold whatever
   * is asked for here.
   *
   * This exists for the slash-command probe, which has to establish whether a
   * mechanism fails because it is genuinely unavailable or because layer 3 removed
   * the tool that drives it. Those are different findings with different fixes, and
   * telling them apart needs the same run with one variable changed.
   */
  extraTools?: string[];
}

export interface DryRunPlan {
  argv: string[];
  cwd: string;
  prompt: string;
  settingsFile: string;
  permissions: PermissionPlan;
  env: Record<string, string>;
}

/**
 * F2 — "The application pins invocation behaviour with explicit flags rather than
 * relying on defaults. There is a mode that strips instruction files, MCP
 * configuration and subscription authentication simultaneously — all three things
 * this design rests on — and it is documented both as the recommended mode for
 * scripted calls and as the announced future default for the non-interactive flag."
 *
 * On the installed CLI (2.1.237) that mode is `--bare`. X5: it must never be used.
 * This list is the guard — if any of these ever appears in the argv this module
 * builds, `buildArgv` throws rather than dispatching.
 */
export const FORBIDDEN_FLAGS = [
  '--bare',            // X5/F2 — skips CLAUDE.md auto-discovery, hooks, and OAuth
  '--safe-mode',       // disables CLAUDE.md, skills, hooks — same failure, different door
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
] as const;

export function buildArgv(config: Config, agent: Agent, plan: PermissionPlan): string[] {
  const argv: string[] = [];

  // D1 — every invocation is cold. No session resume, and no session left behind
  // for a later run to resume by accident.
  argv.push('--print');
  argv.push('--no-session-persistence');

  // §14 — "Consume streaming JSON output. It carries a retry event with a typed
  // error enumeration including a rate-limit category — mechanical recognition for
  // V5 with no string matching."
  argv.push('--output-format', 'stream-json');
  argv.push('--verbose'); // stream-json with --print requires it
  // V7 — silence detection needs a heartbeat finer than one event per completed
  // message, or a single long turn looks identical to the documented hang.
  argv.push('--include-partial-messages');

  argv.push('--model', agent.model ?? config.defaults.model);

  // X5 — "The mode that skips loading CLAUDE.md must never be used. Each agent *is*
  // its instruction file." F2 — state the requirement explicitly rather than
  // inheriting it, so a change of default does not silently produce generic
  // assistants wearing the agents' names.
  argv.push('--setting-sources', 'user,project,local');

  argv.push('--permission-mode', config.defaults.permissionMode);

  // X6 — permissions are declared where the agent lives.
  argv.push('--settings', settingsPathFor(agent));

  // X1 and X3, on argv as well as in settings. Layer 3 of the three in
  // permissions.ts: a tool absent from --tools cannot be reached even by a hook
  // that returns an allow decision (X7).
  if (plan.tools.length) argv.push('--tools', plan.tools.join(','));
  if (plan.disallowedTools.length) argv.push('--disallowed-tools', plan.disallowedTools.join(','));
  if (plan.allowedTools.length) argv.push('--allowed-tools', plan.allowedTools.join(','));

  // X4 — reads scoped to the ledger and whatever document store the agent needs.
  for (const d of plan.addDirs) argv.push('--add-dir', d);

  // X3 — .mcp.json entries start processes, connected without approval in
  // non-interactive mode, and the agent's own directory is never trusted.
  //
  // --strict-mcp-config restricts the connection to what --mcp-config names. With no
  // --mcp-config that is nothing at all; with ours it is exactly one server, which we
  // wrote and whose config lives beside the generated settings (X6). So the flag does
  // the same job in both cases — the difference is whether the whitelist is empty.
  if (config.contract.mcp) argv.push('--mcp-config', mcpConfigPathFor(agent));
  if (!agent.allowMcp) argv.push('--strict-mcp-config');

  // C1/C2 belt-and-braces: a ceiling the CLI enforces underneath our own caps, so a
  // runaway is bounded even if our accounting is wrong.
  argv.push('--max-budget-usd', String(agent.maxBudgetUsd ?? config.defaults.maxBudgetUsd));

  // The prompt itself goes on stdin, not argv. Two reasons and both are real: a
  // thread rendered under D10a comfortably exceeds the 32767-character Windows
  // command line, and T5's "directory names containing spaces must be quoted"
  // problem does not arise for text that never touches a command line.

  const forbidden = argv.filter((a) => (FORBIDDEN_FLAGS as readonly string[]).includes(a));
  if (forbidden.length) {
    throw new Error(`X5/F2: refusing to invoke with ${forbidden.join(', ')} — that mode strips the instruction files this design rests on.`);
  }
  return argv;
}

/** F1 — authentication mode is configuration, not architecture. */
function buildEnv(config: Config): Record<string, string> {
  const env: Record<string, string> = {};
  if (config.auth.mode === 'api-key') {
    const key = process.env[config.auth.apiKeyEnvVar];
    if (!key) {
      throw new Error(`auth.mode is "api-key" but ${config.auth.apiKeyEnvVar} is not set in the environment.`);
    }
    env[config.auth.apiKeyEnvVar] = key;
  }
  // §14, console encoding: "Observed: a shell redirect produced UTF-16LE." We read
  // the pipe directly and never route through a shell, but the child's own writes
  // still honour this on Windows.
  env['PYTHONIOENCODING'] = 'utf-8';
  return env;
}

export async function prepareDryRun(opts: InvokeOptions): Promise<DryRunPlan> {
  const { config, agent, prompt } = opts;
  const plan = buildPermissionPlan(config, agent);
  return {
    argv: buildArgv(config, agent, plan),
    cwd: agent.home,
    prompt,
    settingsFile: settingsPathFor(agent),
    permissions: plan,
    env: buildEnv(config),
  };
}

/** X6 — written into the agent's own directory, refreshed before every dispatch. */
export async function writeAgentSettings(config: Config, agent: Agent): Promise<string> {
  const plan = buildPermissionPlan(config, agent);
  const file = settingsPathFor(agent);
  // T5, first consequence: "JSON is not [safe] — C:\Users must be written
  // C:\\Users". JSON.stringify does that escaping, which is why nothing here builds
  // JSON by string concatenation.
  await writeText(file, JSON.stringify(plan.settings, null, 2) + '\n');
  return file;
}

export async function invoke(opts: InvokeOptions): Promise<InvocationResult> {
  const { config, agent, prompt, invocationId } = opts;
  const plan = buildPermissionPlan(config, agent);

  // A widened tool set is still filtered through the denials, so this can only ever
  // add something the boundaries already permitted. X1's shell cannot come back in
  // through here.
  if (opts.extraTools?.length) {
    const denied = new Set(plan.disallowedTools);
    for (const t of opts.extraTools) {
      if (!denied.has(t) && !plan.tools.includes(t)) plan.tools.push(t);
    }
  }

  const argv = buildArgv(config, agent, plan);
  const env = buildEnv(config);
  const startedAt = nowIso();
  const t0 = Date.now();

  await writeAgentSettings(config, agent);
  // Refreshed before every dispatch for the same reason the settings are: the paths
  // in it are absolute, and a config edit between two runs must not leave a stale
  // one behind pointing at a directory that moved.
  if (config.contract.mcp) await writeMcpConfig(config, agent, config.configFile);

  const silenceMs = agent.silenceTimeoutMs ?? config.defaults.silenceTimeoutMs;
  const wallMs = agent.wallClockTimeoutMs ?? config.defaults.wallClockTimeoutMs;

  // D2 — "An agent is invoked with its own directory as the working directory, so
  // it loads its own CLAUDE.md and its own project settings. This is the mechanism
  // the entire design rests on."
  //
  // shell: false is not incidental. §14 flags the Windows shim as the known trap on
  // this path, and T5 warns that directory names containing spaces must be quoted
  // everywhere a path is handed to a spawned process. Passing argv directly removes
  // the quoting problem rather than solving it, and reading the pipe directly avoids
  // the UTF-16LE redirect §14 observed.
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(config.claudeBin, argv, {
      cwd: agent.home,
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
  } catch (err: any) {
    return failed(err?.message ?? String(err));
  }

  const state = {
    outcome: 'exited' as ProcessOutcome,
    costUsd: null as number | null,
    numTurns: null as number | null,
    resultSubtype: null as string | null,
    isError: null as boolean | null,
    permissionDenials: [] as PermissionDenial[],
    finalText: null as string | null,
    rateLimitEvent: null as unknown,
    rateLimitStatus: null as unknown,
    stderr: '',
    eventCounts: {} as Record<string, number>,
    toolsUsed: [] as string[],
  };

  let lastActivity = Date.now();
  let settled = false;
  // Held on an object rather than in a `let`, because it is only ever assigned from
  // inside the timer callbacks below and control-flow analysis would otherwise
  // narrow it to null at the point it is read.
  const kills: { reason: ProcessOutcome | null } = { reason: null };

  // V8 — "The application must hold the process handle and be able to kill it.
  // Every published runaway account is an interactive session where nobody held the
  // handle. An external orchestrator is structurally better placed — but only if it
  // actually keeps the handle and uses it."
  const kill = (reason: ProcessOutcome) => {
    if (settled || kills.reason) return;
    kills.reason = reason;
    killTree(child);
  };

  const silenceTimer = setInterval(() => {
    // V7 — "Silence detection rather than elapsed time, so a legitimately long run
    // is not killed." Any byte on either pipe counts as life.
    if (Date.now() - lastActivity > silenceMs) kill('silence-timeout');
    if (opts.shouldAbort?.()) kill('killed'); // C3, mid-run
  }, 1000);
  const wallTimer = setTimeout(() => kill('wall-timeout'), wallMs);

  const stdoutLines = lineReader((line) => {
    lastActivity = Date.now();
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return; // Not every line of a stream is JSON; non-JSON noise is not an event.
    }
    const type = typeof event?.type === 'string' ? event.type : 'unknown';
    state.eventCounts[type] = (state.eventCounts[type] ?? 0) + 1;
    opts.onEvent?.(event);
    absorb(event, state);
    if (detectRateLimit(event)) {
      state.rateLimitEvent = event;
      // V6 — "On a recognised limit: back off, stop the chain... Never retry into
      // it." Stopping the process is the back-off; the chain stop is the caller's.
      kill('rate-limited');
    }
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    lastActivity = Date.now();
    stdoutLines(chunk);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    lastActivity = Date.now();
    state.stderr += chunk;
    if (state.stderr.length > 64_000) state.stderr = state.stderr.slice(-64_000);
  });

  // The prompt goes in on stdin, then the pipe closes so the CLI knows the input
  // is complete.
  child.stdin.setDefaultEncoding('utf8');
  child.stdin.write(prompt, 'utf8');
  child.stdin.end();

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(
    (resolve) => {
      child.on('error', (error) => resolve({ code: null, signal: null, error }));
      child.on('close', (code, signal) => resolve({ code, signal }));
    }
  );

  settled = true;
  clearInterval(silenceTimer);
  clearTimeout(wallTimer);

  const endedAt = nowIso();
  const wall = Date.now() - t0;

  let outcome: ProcessOutcome = kills.reason ?? 'exited';
  if (!kills.reason) {
    if (exit.error) outcome = 'process-failed';
    // V3 outcome 3 is a *CLI-level fault*, which is a non-zero exit or a spawn
    // error. A clean exit is outcome "exited" and says nothing about whether the
    // work happened — that is V1's whole point, and sweep.ts decides it.
    else if (exit.code !== 0) outcome = 'process-failed';
  }
  // V5 — treated as a possible response to *any* invocation, including one that
  // exited cleanly before the timer noticed.
  if (state.rateLimitEvent && outcome !== 'killed') outcome = 'rate-limited';

  return {
    invocationId,
    agent: agent.name,
    outcome,
    exitCode: exit.code,
    signal: exit.signal,
    startedAt,
    endedAt,
    wallMs: wall,
    costUsd: state.costUsd,
    numTurns: state.numTurns,
    resultSubtype: state.resultSubtype,
    isError: state.isError,
    permissionDenials: state.permissionDenials,
    finalText: state.finalText,
    rateLimitEvent: state.rateLimitEvent ?? null,
    rateLimitStatus: state.rateLimitStatus ?? null,
    stderr: state.stderr.trim(),
    eventCounts: state.eventCounts,
    toolsUsed: state.toolsUsed,
    argv,
    cwd: agent.home,
  };

  function failed(message: string): InvocationResult {
    return {
      invocationId,
      agent: agent.name,
      outcome: 'process-failed',
      exitCode: null,
      signal: null,
      startedAt,
      endedAt: nowIso(),
      wallMs: Date.now() - t0,
      costUsd: null,
      numTurns: null,
      resultSubtype: null,
      isError: true,
      permissionDenials: [],
      finalText: null,
      rateLimitEvent: null,
      rateLimitStatus: null,
      stderr: message,
      eventCounts: {},
      toolsUsed: [],
      argv,
      cwd: agent.home,
    };
  }
}

/** Pulls the fields we log out of a stream event. None of them decides success (V1). */
function absorb(event: any, state: any): void {
  // A status event, not an error. Recorded so V6's back-off can be informed by it.
  if (event?.type === 'rate_limit_event' || event?.type === 'rate_limit_status') {
    state.rateLimitStatus = event;
  }

  if (event?.type === 'result') {
    if (typeof event.total_cost_usd === 'number') state.costUsd = event.total_cost_usd;
    if (typeof event.num_turns === 'number') state.numTurns = event.num_turns;
    if (typeof event.subtype === 'string') state.resultSubtype = event.subtype;
    if (typeof event.is_error === 'boolean') state.isError = event.is_error;
    if (typeof event.result === 'string') state.finalText = event.result.trim();

    // V4 — "The result payload carries a machine-readable array naming the tool,
    // the tool-use id, and the full input the agent attempted — the exact path and
    // exact content. That turns allowlist debugging from guesswork into reading a
    // field."
    const denials = event.permission_denials;
    if (Array.isArray(denials)) {
      for (const d of denials) {
        state.permissionDenials.push({
          toolName: d?.tool_name ?? d?.toolName ?? 'unknown',
          toolUseId: d?.tool_use_id ?? d?.toolUseId ?? '',
          toolInput: d?.tool_input ?? d?.toolInput ?? null,
        });
      }
    }
  }

  // D11 — the one-line confirmation. In non-interactive mode the model's final text
  // *is* the process's return value, so it is captured even when `result` is absent.
  if (event?.type === 'assistant' && Array.isArray(event?.message?.content)) {
    for (const block of event.message.content) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        if (!state.toolsUsed.includes(block.name)) state.toolsUsed.push(block.name);
      }
    }
    const text = event.message.content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('')
      .trim();
    if (text) state.finalText = text;
  }
}

/**
 * V5 — "A rate limit must be recognised mechanically, not by matching a string, and
 * treated as a possible response to *any* invocation."
 *
 * So this reads typed fields only. Every check below is an equality test against an
 * enumeration value in a named field; none of them searches free text for a phrase.
 * That matters because the message wording is not a contract and the field is.
 *
 * The application must not use its own quota accounting to predict availability
 * (V5, second half) — there are reports of limit errors at 0–3% of weekly usage on
 * exactly this configuration. Nothing here consults a counter; it reads what the
 * stream said.
 */
const RATE_LIMIT_VALUES = new Set([
  'rate_limit_error',
  'rate_limited',
  'rate_limit',
  'usage_limit_reached',
  'overloaded_error',
  'error_rate_limit',
]);

export function detectRateLimit(event: any): boolean {
  if (!event || typeof event !== 'object') return false;

  // The CLI announces its own limits in a `rate_limit_event` carrying a typed
  // status, which is the signal that actually arrives in practice — none of the
  // error-shaped fields below are present when a session limit is refused.
  //
  // Only `rejected` is a limit. The same event reports headroom as `allowed` and
  // `allowed_warning`, and treating those as a limit would stop every chain at the
  // first warning. The sibling `overageStatus` is deliberately NOT consulted: it
  // reads `rejected` whenever overage billing is simply switched off, which is true
  // of accounts nowhere near a limit.
  const limitStatus = event.rate_limit_info?.status ?? event.rate_limit?.status;
  if (limitStatus === 'rejected' || limitStatus === 'blocked') return true;

  const typed = [
    event.error?.type,
    event.error?.code,
    event.retry?.reason,
    event.retry?.error_type,
    event.reason,
    event.subtype === 'retry' ? event.error_type : undefined,
    event.result_error_type,
  ];
  for (const v of typed) {
    if (typeof v === 'string' && RATE_LIMIT_VALUES.has(v)) return true;
  }

  // HTTP 429, also a typed field rather than a phrase.
  const status = event.error?.status ?? event.status_code ?? event.http_status;
  if (status === 429) return true;

  if (event.type === 'result' && typeof event.subtype === 'string') {
    if (RATE_LIMIT_VALUES.has(event.subtype)) return true;
  }
  return false;
}

/**
 * When the limit lifts, if the stream said so.
 *
 * V6 stops the chain; this is what turns that stop into something the operator can
 * act on. `resetsAt` is unix seconds on the same typed event the detector reads, so
 * it costs nothing extra and is not a guess about our own usage (V5).
 */
export function rateLimitResetsAt(event: any): string | null {
  const secs = event?.rate_limit_info?.resetsAt ?? event?.rate_limit?.resetsAt;
  if (typeof secs !== 'number' || !Number.isFinite(secs)) return null;
  return new Date(secs * 1000).toISOString();
}

/**
 * §14 — "SIGTERM is a clean kill path: it aborts the turn, kills the shell process
 * tree, runs session-end hooks and exits with code 143."
 *
 * On Windows, Node maps SIGTERM to TerminateProcess, which does not run handlers and
 * does not reach grandchildren. `taskkill /T` does both, so the platform gets the
 * mechanism that actually satisfies V8 rather than the one named in the source.
 */
function killTree(child: ChildProcessWithoutNullStreams): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    }).on('error', () => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    });
    return;
  }
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 5000).unref();
}

/** Splits a chunked stream into whole lines. NDJSON arrives split at arbitrary points. */
function lineReader(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line.trim()) onLine(line);
    }
    // A pathological line with no newline must not grow without bound.
    if (buffer.length > 8_000_000) buffer = '';
  };
}
