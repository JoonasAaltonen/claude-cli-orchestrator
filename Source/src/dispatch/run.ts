/**
 * The dispatch loop. D5, D7, and the point where §6's judgement is actually made.
 *
 * D7 — "Serialise by default. One agent at a time. It caps spend and makes ledger
 * ordering trivial." There is no concurrency anywhere in this file, and L2's
 * single-writer model depends on that staying true.
 *
 * C5 — "Manual dispatch before any watcher. A `dispatch <agent>` command run by
 * hand: read pending rows, build the prompt, invoke, sweep, validate, append.
 * Everything observable, nothing able to run away." `dispatchOnce` is that command.
 * `runUntilQuiescent` is the loop over it, and the watcher (watch.ts) only calls the
 * same two functions.
 */
import crypto from 'node:crypto';
import type { Agent, Config } from '../config/load.js';
import { findAgent } from '../config/load.js';
import { fold, awaiting } from '../ledger/fold.js';
import type { Fold, Outstanding } from '../ledger/fold.js';
import { readIndex, appendRow, layout } from '../ledger/store.js';
import { OPERATOR, ORCHESTRATOR } from '../ledger/row.js';
import { buildPrompt } from './prompt.js';
import { invoke, prepareDryRun, rateLimitResetsAt } from './invoke.js';
import type { DryRunPlan } from './invoke.js';
import { sweepOutbox, judge } from './sweep.js';
import { isDispatchable, readDispatchState, recordDispatch } from './state.js';
import { checkGuards, chainSpend, readChainBudgets } from '../guards/budget.js';
import { checkAuth, authBlocker, describeAuth } from '../guards/auth.js';
import type { GuardVerdict } from '../guards/budget.js';
import { appendInvocation, buildLogEntry, readInvocationLog, writePromptLog } from '../log/invocations.js';
import { diffSnapshots, snapshot, describeDiff, diffBody } from '../log/skillsdiff.js';
import type { SkillsDiff } from '../log/skillsdiff.js';
import { nowIso } from '../util/time.js';
import { existsSync } from '../util/fsx.js';

export interface DispatchOutcome {
  agent: string;
  /** Nothing was pending, or a guard refused. No invocation happened. */
  skipped: boolean;
  skipReason?: string;
  guard?: GuardVerdict;
  rowIds: string[];
  verdict?: string;
  verdictWhy?: string;
  costUsd?: number | null;
  wallMs?: number;
  produced: string[];
  rejected: number;
  skillsDiff?: SkillsDiff | null;
  dryRunPlan?: DryRunPlan;
  /** Set when the chain must stop: a guard tripped, or V6 fired. */
  stopChain: boolean;
  stopReason?: string;
  /**
   * Distinguished from other stops because it is the one an operator who walked away
   * most needs to see, and the one that costs nothing to detect up front.
   */
  authFailed?: boolean;
}

export interface DispatchOptions {
  /** C4 — dry-run mode from the first commit. Prints what would be sent, spends nothing. */
  dryRun?: boolean;
  onLog?: (line: string) => void;
  /**
   * Sweep every outbox before looking at what is outstanding.
   *
   * D4 sweeps on process exit, which is exact for anything this application started.
   * It says nothing about a file that arrived some other way — an agent leaving a
   * message during a session a human started, which is the `/ledger-note` path. Those
   * files sit in an outbox with nothing scheduled to notice them.
   *
   * Off by default, because sweeping also adopts anything left over from a run that
   * died between invoking and sweeping. That is usually a wanted recovery and
   * occasionally a surprise, so it is asked for rather than assumed.
   */
  sweepFirst?: boolean;
}

/**
 * D5 — "Batch pending items by recipient before dispatching. Fewer invocations
 * means fewer turns and less duplicated reasoning. *An optimisation, not a
 * load-bearing one — see C7.*"
 *
 * Filtered by D6's per-row dispatch state, so a restart does not replay history and
 * a row that already exhausted its attempts is not carried into a fresh batch.
 */
export async function pendingFor(
  config: Config,
  agent: Agent,
  f: Fold
): Promise<{ batch: Outstanding[]; deferred: { row: string; reason: string }[] }> {
  const states = await readDispatchState(config);
  const batch: Outstanding[] = [];
  const deferred: { row: string; reason: string }[] = [];

  for (const item of awaiting(f, agent.name)) {
    const check = isDispatchable(states, item.row.id, agent.name, config.defaults.maxAttemptsPerRow);
    if (check.ok) batch.push(item);
    else deferred.push({ row: item.row.id, reason: check.reason });
  }
  return { batch, deferred };
}

/** One agent, one invocation, everything observable. This is C5's manual dispatch. */
export async function dispatchOnce(
  config: Config,
  agentName: string,
  opts: DispatchOptions = {}
): Promise<DispatchOutcome> {
  const log = opts.onLog ?? (() => {});
  const agent = findAgent(config, agentName);
  if (!agent) {
    return skip(agentName, `"${agentName}" is not in the roster. Adding an agent is a config entry plus a directory (P1).`);
  }

  // P2 — "An agent whose directory the operator works in interactively must be
  // markable as dispatch-excluded. Rows addressed to it queue for manual relay
  // instead of being dispatched. Starting a second Claude instance in a directory
  // where a human has a live session is a collision with real consequences."
  if (agent.dispatchExcluded) {
    const f = await currentFold(config);
    const items = awaiting(f, agent.name);
    for (const item of items) {
      await recordDispatch(config, {
        rowId: item.row.id,
        agent: agent.name,
        status: 'manual-relay',
        invocationId: null,
        at: nowIso(),
        note: 'agent is dispatch-excluded (P2)',
      });
    }
    return skip(
      agent.name,
      `"${agent.name}" is dispatch-excluded (P2). ${items.length} row(s) queued for manual relay — see \`orchestrator relay\`.`
    );
  }

  const f = await currentFold(config);
  const { batch, deferred } = await pendingFor(config, agent, f);
  for (const d of deferred) log(`  ${d.row}: not dispatched — ${d.reason}`);

  if (!batch.length) {
    return skip(agent.name, 'nothing pending');
  }

  // D5 — one prompt for the whole batch, but the guards are evaluated per chain,
  // and the strictest verdict across the batch decides.
  const budgets = await readChainBudgets(config);
  const invocationLog = await readInvocationLog(config);
  const rootIds = [...new Set(batch.map((b) => f.threadOf.get(b.row.id)?.rootId ?? b.row.id))];

  let worstGuard: GuardVerdict = { allowed: true, escalate: false, reason: 'within budget', code: 'ok' };
  for (const rootId of rootIds) {
    const verdict = await checkGuards(config, { rootId, budgets, log: invocationLog });
    if (!verdict.allowed) {
      worstGuard = verdict;
      break;
    }
  }

  if (!worstGuard.allowed) {
    log(`  guard: ${worstGuard.reason}`);
    if (worstGuard.escalate) {
      // C1/C2 — "at zero the application stops and writes a row rather than asking
      // for more" / "On breach: stop, write a row to the operator, do not
      // self-restart."
      await escalate(config, worstGuard.reason, batch.map((b) => b.row.id), rootIds[0] ?? null);
      for (const item of batch) {
        await recordDispatch(config, {
          rowId: item.row.id,
          agent: agent.name,
          status: 'escalated',
          invocationId: null,
          at: nowIso(),
          note: worstGuard.reason,
        });
      }
    }
    return {
      ...skip(agent.name, worstGuard.reason),
      guard: worstGuard,
      stopChain: true,
      stopReason: worstGuard.reason,
    };
  }

  // Authentication preflight. Before the prompt is even built, because the whole
  // point is to fail here rather than an hour later with an empty ledger.
  if (!opts.dryRun) {
    const auth = await checkAuth(config);
    const blocked = authBlocker(auth);
    if (blocked) {
      for (const line of blocked) log(`  ${line}`);
      return {
        ...skip(agent.name, blocked[0] ?? 'not authenticated'),
        stopChain: true,
        stopReason: blocked.join(' '),
        authFailed: true,
      };
    }
  }

  const spend = chainSpend(config, rootIds[0]!, budgets, invocationLog);
  const invocationId = newInvocationId();

  const prompt = await buildPrompt(config, {
    agent,
    pending: batch,
    fold: f,
    hopsRemaining: spend.hopsRemaining,
    invocationsRemaining: spend.invocationsRemaining,
  });

  // D9 — the constructed prompt is logged per invocation, before it is sent, so a
  // crash mid-invocation still leaves the thing you need to diff.
  const promptFile = await writePromptLog(config, invocationId, agent.name, prompt.text);

  // C4 — dry-run prints what would be sent and spends nothing.
  if (opts.dryRun) {
    const plan = await prepareDryRun({ config, agent, prompt: prompt.text, invocationId, dryRun: true });
    return {
      agent: agent.name,
      skipped: true,
      skipReason: 'dry run — nothing was invoked and nothing was spent',
      rowIds: batch.map((b) => b.row.id),
      produced: [],
      rejected: 0,
      dryRunPlan: plan,
      stopChain: false,
    };
  }

  // D13 — the before half of the mechanical diff.
  const before = await snapshot(agent);

  for (const item of batch) {
    await recordDispatch(config, {
      rowId: item.row.id,
      agent: agent.name,
      status: 'dispatched',
      invocationId,
      at: nowIso(),
    });
  }

  log(`  invoking ${agent.name} (${batch.length} row(s): ${batch.map((b) => b.row.id).join(', ')}, ${prompt.charCount} char prompt)`);

  const result = await invoke({
    config,
    agent,
    prompt: prompt.text,
    invocationId,
    // C3 — "The system must be stoppable without finding the terminal or killing a
    // process." Checked before every dispatch above, and polled during this one, so
    // setting the switch stops work already in flight rather than only the next
    // thing. Synchronous on purpose: it is called from a timer callback once a
    // second, and an existence check is cheaper than the promise machinery.
    shouldAbort: () => existsSync(layout(config).kill),
  });

  // D4 — "Sweep on process exit for the machine path... The application started the
  // agent, so it knows when the invocation finished — no polling, no debounce, no
  // reading a file mid-write."
  const sweep = await sweepOutbox(config, agent);

  const after = await snapshot(agent);
  const skillsDiff = diffSnapshots(before, after);
  if (skillsDiff.any) {
    log(`  D13: ${agent.name} changed its own skills/commands — ${describeDiff(skillsDiff)}`);
    await reportSkillsChange(config, agent, skillsDiff);
  }

  // V1/V2 — the verdict is made from the artefact, by a function that has never
  // seen the status fields.
  const { verdict, why } = judge(result.outcome, sweep);
  log(`  ${verdict}: ${why}`);
  if (result.finalText) log(`  agent said: ${firstLine(result.finalText)}`);

  await recordOutcome(config, agent.name, batch.map((b) => b.row.id), invocationId, verdict, why, config.defaults.maxAttemptsPerRow);

  await appendInvocation(
    config,
    buildLogEntry({
      result,
      rowIds: batch.map((b) => b.row.id),
      threadRootIds: rootIds,
      verdict,
      verdictWhy: why,
      artefacts: sweep.accepted.map((a) => a.messageFile),
      rejected: sweep.rejected.map((r) => ({ preservedAt: r.preservedAt, errors: r.errors })),
      skillsDiff,
      promptFile,
      promptChars: prompt.charCount,
      promptTemplate: prompt.templateVersion,
      dryRun: false,
    })
  );

  // V4 — permission denials are captured and surfaced. A diagnostic, not the test.
  for (const d of result.permissionDenials) {
    log(`  permission denied: ${d.toolName} — ${JSON.stringify(d.toolInput).slice(0, 300)}`);
  }

  // V6 — "On a recognised limit: back off, stop the chain, write a row to the
  // operator. Never retry into it."
  let stopChain = false;
  let stopReason: string | undefined;

  // Keyed on the recognised limit rather than on the verdict, because the two are
  // different questions. V2 says the artefact decides success, so an invocation that
  // wrote a valid message before the limit landed is still `worked` — and it should
  // be. But V6 is about what happens next, and the next dispatch would go straight
  // into the same closed door. Reading the verdict alone costs exactly one wasted
  // invocation every time a limit arrives on a productive run, which is how it
  // arrives most of the time.
  const limitRecognised = result.outcome === 'rate-limited' || verdict === 'rate-limited';
  if (limitRecognised) {
    stopChain = true;
    const resets = rateLimitResetsAt(result.rateLimitEvent ?? result.rateLimitStatus);
    stopReason =
      'A rate limit was recognised (V5). The chain is stopped and will not be retried into (V6).' +
      (resets ? ` The limit resets at ${resets}.` : '');
    await escalate(config, stopReason, batch.map((b) => b.row.id), rootIds[0] ?? null);
  }

  return {
    agent: agent.name,
    skipped: false,
    rowIds: batch.map((b) => b.row.id),
    verdict,
    verdictWhy: why,
    costUsd: result.costUsd,
    wallMs: result.wallMs,
    produced: sweep.accepted.map((a) => a.row.id),
    rejected: sweep.rejected.length,
    skillsDiff,
    stopChain,
    stopReason,
  };
}

/**
 * Drives the chain to a stop. D7 keeps it serial; every iteration re-reads the
 * ledger, because the previous invocation appended to it.
 *
 * §13b acceptance 4: "The chain stops on its own. It does not continue past row 4
 * looking for more to do." That is not a special case here — the loop ends when the
 * fold reports nothing outstanding for any dispatchable agent.
 */
export async function runUntilQuiescent(
  config: Config,
  opts: DispatchOptions & { maxIterations?: number } = {}
): Promise<DispatchOutcome[]> {
  const log = opts.onLog ?? (() => {});
  const outcomes: DispatchOutcome[] = [];
  const maxIterations = opts.maxIterations ?? 25;

  // Checked once, loudly, before the loop. dispatchOnce re-checks, but this is the
  // one an operator sees before they walk away.
  if (!opts.dryRun) {
    const auth = await checkAuth(config);
    log(`auth: ${describeAuth(auth)}`);
    const blocked = authBlocker(auth);
    if (blocked) {
      for (const line of blocked) log(`  ${line}`);
      return [{ ...skip('(none)', blocked[0] ?? 'not authenticated'), stopChain: true, stopReason: blocked.join(' '), authFailed: true }];
    }
  }

  // Before the first fold, never between iterations: a dispatch sweeps its own agent
  // on exit already, and re-sweeping every agent each time round would be work with
  // no new input.
  if (opts.sweepFirst) {
    const adopted = await sweepAll(config, log);
    if (!adopted) log('swept outboxes: nothing waiting that the ledger had not already seen');
  }

  for (let i = 0; i < maxIterations; i++) {
    const f = await currentFold(config);

    // Which agents have work, in ledger order so dispatch follows the chain.
    const targets: string[] = [];
    for (const agent of config.agents) {
      if (agent.dispatchExcluded) continue;
      const { batch } = await pendingFor(config, agent, f);
      if (batch.length) targets.push(agent.name);
    }

    if (!targets.length) {
      log(`quiescent after ${i} dispatch(es) — nothing outstanding for any dispatchable agent`);
      break;
    }

    // D7 — one agent at a time.
    const next = targets[0]!;
    log(`\ndispatch ${i + 1}: ${next}`);
    const outcome = await dispatchOnce(config, next, opts);
    outcomes.push(outcome);

    if (outcome.stopChain) {
      log(`\nchain stopped: ${outcome.stopReason}`);
      break;
    }
    if (outcome.skipped && outcome.skipReason === 'nothing pending') break;
    // C4 — a dry run shows the first dispatch and stops; it cannot loop, because
    // nothing was appended and the next iteration would build the same prompt.
    if (opts.dryRun) break;

    // V3 outcome 2 is the common case, and C6 says failure costs more than success.
    // A batch that produced nothing has already had its attempt counted; looping
    // straight back into it is exactly the runaway C6 warns about, so the loop
    // continues only when the ledger actually moved.
    if (outcome.verdict !== 'worked') {
      log(`\nstopping: last invocation did not produce an artefact (${outcome.verdict}). Nothing was appended, so continuing would repeat it.`);
      break;
    }
  }

  return outcomes;
}

/**
 * Sweeps every agent's outbox and reports what came in. Returns how many rows were
 * adopted, so the caller can say "nothing" rather than printing an empty heading.
 *
 * Dispatch-excluded agents are swept too (P2 is about not *invoking* them, and a
 * human working in that directory is exactly the person likely to leave a note).
 */
async function sweepAll(config: Config, log: (line: string) => void): Promise<number> {
  let adopted = 0;
  for (const agent of config.agents) {
    const r = await sweepOutbox(config, agent);
    for (const a of r.accepted) {
      adopted++;
      log(`swept ${agent.name}: ${a.row.id} → ${a.row.to.join(', ')}  ${a.row.summary}`);
    }
    for (const rej of r.rejected) {
      // M7 — bounced, preserved, and said out loud. A note left by hand is more
      // likely to be malformed than one the MCP tool wrote.
      log(`swept ${agent.name}: REJECTED ${rej.errors[0] ?? 'unknown reason'}`);
      log(`  preserved at ${rej.preservedAt}`);
    }
  }
  return adopted;
}

async function currentFold(config: Config): Promise<Fold> {
  const { rows } = await readIndex(config);
  return fold(rows, {
    staleThreadDays: config.staleThreadDays,
    maxRejectionsPerThread: config.maxRejectionsPerThread,
    decisionsDigestLimit: config.decisionsDigestLimit,
  });
}

/** D6 — per-row, so a batch that partially succeeded records exactly that. */
async function recordOutcome(
  config: Config,
  agent: string,
  rowIds: string[],
  invocationId: string,
  verdict: string,
  why: string,
  maxAttempts: number
): Promise<void> {
  const states = await readDispatchState(config);
  for (const rowId of rowIds) {
    // 'progressed' records that the invocation produced a valid artefact — not that
    // this row is answered. The fold decides that by replay (L1).
    let status: 'progressed' | 'failed' | 'escalated' = 'failed';
    if (verdict === 'worked') status = 'progressed';
    else {
      const s = states.get(`${rowId} ${agent.toLowerCase()}`);
      if ((s?.consecutiveFailures ?? 0) + 1 >= maxAttempts) status = 'escalated';
    }
    await recordDispatch(config, {
      rowId,
      agent,
      status,
      invocationId,
      at: nowIso(),
      note: status === 'progressed' ? undefined : why,
    });
  }
}

/**
 * C1, C2, M5, V6 all end the same way: "stop, write a row to the operator, do not
 * self-restart." M9 — reports to the operator are ledger rows, not files living
 * outside the ledger.
 */
async function escalate(
  config: Config,
  reason: string,
  rowIds: string[],
  rootId: string | null
): Promise<void> {
  const body = [
    reason,
    '',
    rowIds.length ? `Rows involved: ${rowIds.join(', ')}` : '',
    rootId ? `Thread: ${rootId}` : '',
    '',
    'The application has stopped and will not restart itself. Nothing further will be',
    'dispatched for this chain until you act.',
    '',
    'To resume, either raise the ceiling for a new chain, or write a fresh row.',
    `The invocation log is at ${layout(config).invocations}.`,
  ]
    .filter((l) => l !== '')
    .join('\n');

  await appendRow(config, {
    writer: ORCHESTRATOR,
    draft: {
      to: [OPERATOR],
      type: 'report',
      replyTo: null,
      needs: [],
      outcome: null,
      summary: sanitiseSummary(`Chain stopped: ${reason}`),
      body,
    },
  });
}

/** T8 — a self-written skill is reported by the agent and surfaced to the operator. */
async function reportSkillsChange(config: Config, agent: Agent, d: SkillsDiff): Promise<void> {
  await appendRow(config, {
    writer: ORCHESTRATOR,
    draft: {
      to: [OPERATOR],
      type: 'report',
      replyTo: null,
      needs: [],
      outcome: null,
      summary: sanitiseSummary(`${agent.name} changed its own skills or commands: ${describeDiff(d)}`),
      body: diffBody(agent, d),
    },
  });
}

/** M6 — Summary is one line with no delimiter. Applied to text we generate too. */
function sanitiseSummary(s: string): string {
  const one = s.replace(/[\r\n]+/g, ' ').replace(/;/g, ',').trim();
  return one.length > 180 ? one.slice(0, 177) + '...' : one;
}

function firstLine(s: string): string {
  const l = s.split('\n')[0] ?? '';
  return l.length > 160 ? l.slice(0, 157) + '...' : l;
}

function newInvocationId(): string {
  const stamp = nowIso().replace(/[-:TZ]/g, '');
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function skip(agent: string, reason: string): DispatchOutcome {
  return {
    agent,
    skipped: true,
    skipReason: reason,
    rowIds: [],
    produced: [],
    rejected: 0,
    stopChain: false,
  };
}

