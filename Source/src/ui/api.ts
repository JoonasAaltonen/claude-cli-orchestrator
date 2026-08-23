/**
 * What the dashboard is served.
 *
 * Every payload here is built from the same functions the CLI calls — `fold`,
 * `readIndex`, `protocolStatus` — and none of them print. That separation is what
 * makes a second front-end cheap: the dashboard is another *view*, not another
 * implementation, and a rule that holds in `orchestrator status` cannot disagree
 * with the same rule on screen because there is only one of it.
 *
 * Nothing in this file writes. Read-only endpoints are the whole of the first
 * slice, so a mistake here cannot spend anything or move the ledger.
 */
import { fold } from '../ledger/fold.js';
import type { Fold, Thread } from '../ledger/fold.js';
import { readIndex, readMessageBody } from '../ledger/store.js';
import type { Row } from '../ledger/row.js';
import { OPERATOR } from '../ledger/row.js';
import type { Config } from '../config/load.js';
import { protocolStatus } from '../cli/protocol.js';
import { skillStatus } from '../cli/skills.js';
import { readInvocationLog } from '../log/invocations.js';
import { buildPermissionPlan } from '../dispatch/permissions.js';
import { TOOL_CATALOGUE, TOOL_GROUPS, GRANT_CATALOGUE, GRANT_FIELDS } from '../roster/edit.js';
import { MESSAGE_TYPES, MESSAGE_TYPE_INFO, OUTCOMES, OUTCOME_INFO } from '../ledger/row.js';
import { INVOCATION_VERDICTS, VERDICT_INFO } from '../dispatch/sweep.js';
import type { InvocationLogEntry } from '../log/invocations.js';
import { exists } from '../util/fsx.js';
import { layout } from '../ledger/store.js';

export async function foldNow(config: Config): Promise<{ f: Fold; bad: number }> {
  const { rows, bad } = await readIndex(config);
  return {
    f: fold(rows, {
      staleThreadDays: config.staleThreadDays,
      maxRejectionsPerThread: config.maxRejectionsPerThread,
      decisionsDigestLimit: config.decisionsDigestLimit,
    }),
    bad: bad.length,
  };
}

/** One thread, flattened for the list. `blockedBy` is what tells idle from stuck. */
function threadSummary(t: Thread) {
  const movable = t.outstanding.filter((o) => o.blockedBy.length === 0);
  return {
    rootId: t.rootId,
    summary: t.rows[0]?.summary ?? '',
    open: t.open,
    stale: t.stale,
    halted: t.halted,
    rejectionCount: t.rejectionCount,
    participants: t.participants,
    lastTime: t.lastRow.time,
    lastId: t.lastRow.id,
    rowCount: t.rows.length,
    outstanding: t.outstanding.map((o) => ({
      id: o.row.id,
      awaiting: o.awaiting,
      reason: o.reason,
      blockedBy: o.blockedBy,
      summary: o.row.summary,
    })),
    /** L6's real question: can anything move without a human. */
    canMoveNow: movable.length > 0,
  };
}

/**
 * What the CLI last told us about the quota.
 *
 * Reported, never enforced. V5 forbids predicting availability from our own
 * accounting, and nothing here is our own accounting — it is the server-sent status
 * field echoed back unchanged. It exists so the operator can decline to start a long
 * chain at 89%, which is a judgement the application must not make for them.
 *
 * Read from the last invocation that carried one, so it survives a restart: the
 * figure ages, and `at` is shown next to it for exactly that reason.
 */
export interface QuotaView {
  status: string;
  utilization: number | null;
  resetsAt: string | null;
  limitType: string | null;
  at: string;
}

function quotaFrom(entries: readonly InvocationLogEntry[]): QuotaView | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e) continue;
    const info = (e.rateLimitStatus as { rate_limit_info?: Record<string, unknown> } | null)?.rate_limit_info;
    if (!info || typeof info.status !== 'string') continue;
    return {
      status: info.status,
      utilization: typeof info.utilization === 'number' ? info.utilization : null,
      resetsAt:
        typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000).toISOString() : null,
      limitType: typeof info.rateLimitType === 'string' ? info.rateLimitType : null,
      at: e.startedAt,
    };
  }
  return null;
}

/** A row with the file behind it, which is where L3 says the substance lives. */
async function rowWithBody(config: Config, r: Row) {
  return {
    id: r.id,
    time: r.time,
    writer: r.writer,
    to: r.to,
    type: r.type,
    outcome: r.outcome,
    summary: r.summary,
    body: await readMessageBody(config, r),
  };
}

export async function statusPayload(config: Config) {
  const { f, bad } = await foldNow(config);
  const l = layout(config);
  const killed = await exists(l.kill);

  // A thread that finished without the operator ever being written to is the
  // failure `status.md` exists to surface: work happened, nobody was told.
  const unreported = f.threads.filter(
    (t) => !t.open && t.rows.some((r) => r.type === 'request') && !t.rows.some((r) => r.to.includes('operator'))
  );

  // The last thing written, with its body. Most of the time this is the report the
  // operator was waiting for, and reading it here saves going to find the file or
  // asking the agent what it did. When the run stopped mid-chain it is whatever was
  // written last instead, which is still the most useful single row on the page.
  const rows = f.rows;
  const last = rows.length ? rows[rows.length - 1]! : null;
  let answer: Row | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.to.includes(OPERATOR)) { answer = r; break; }
  }

  return {
    rowCount: f.rows.length,
    badLines: bad,
    killed,
    quota: quotaFrom(await readInvocationLog(config)),
    latest: last ? await rowWithBody(config, last) : null,
    // Only when it is not already the latest, so the panel never shows one row twice.
    answer: answer && answer.id !== last?.id ? await rowWithBody(config, answer) : null,
    open: f.openThreads.map(threadSummary),
    stale: f.staleThreads.map(threadSummary),
    halted: f.haltedThreads.map(threadSummary),
    unreported: unreported.map(threadSummary),
    decisions: f.decisions,
    participants: f.participants,
    awaiting: [...f.awaitingBy.entries()].map(([who, items]) => ({
      who,
      count: items.length,
      movable: items.filter((o) => o.blockedBy.length === 0).length,
    })),
  };
}

export async function ledgerPayload(config: Config) {
  const { rows, bad } = await readIndex(config);
  return {
    rows: rows.map((r: Row) => ({
      id: r.id,
      time: r.time,
      writer: r.writer,
      to: r.to,
      type: r.type,
      replyTo: r.replyTo,
      outcome: r.outcome,
      needs: r.needs,
      summary: r.summary,
      hasBody: r.ref !== null,
    })),
    bad: bad.length,
  };
}

/**
 * One thread, root-first, with bodies.
 *
 * The operator sees every body — `mayReadBody` gates what an *agent* is shown, and
 * the person running the dashboard is the one the ledger is being kept for.
 */
export async function threadPayload(config: Config, id: string) {
  const { f } = await foldNow(config);
  const thread = f.threadOf.get(id);
  if (!thread) return null;

  const rows = [];
  for (const r of thread.rows) {
    rows.push({
      id: r.id,
      time: r.time,
      writer: r.writer,
      to: r.to,
      type: r.type,
      replyTo: r.replyTo,
      outcome: r.outcome,
      needs: r.needs,
      summary: r.summary,
      body: await readMessageBody(config, r),
    });
  }
  return { ...threadSummary(thread), rows };
}

export async function agentsPayload(config: Config) {
  const out = [];
  for (const a of config.agents) {
    const p = await protocolStatus(a, config.commsRoot);
    const s = await skillStatus(a);
    out.push({
      name: a.name,
      home: a.home,
      description: a.description,
      model: a.model ?? config.defaults.model,
      // Every described grant, whatever they come to be. Listing them by hand here
      // is how the dashboard ends up not knowing about one.
      ...Object.fromEntries(GRANT_FIELDS.map((f) => [f, a[f]])),
      paths: a.paths,
      tools: a.tools,
      // Derived, not a flag. The recipient menu greys out anyone a row would only
      // queue for manual relay (P2), and *why* that is true is the dispatcher's
      // business — the page should not be re-deriving it from a boolean it happens
      // to know the meaning of.
      dispatchable: !a.dispatchExcluded,
      outbox: a.outbox,
      silenceTimeoutMs: a.silenceTimeoutMs ?? null,
      wallClockTimeoutMs: a.wallClockTimeoutMs ?? null,
      maxBudgetUsd: a.maxBudgetUsd ?? null,
      // What the flags above actually add up to, in the dispatcher's own words. The
      // plan is pure and cheap to build, and showing it beside the checkboxes is the
      // only way an operator can tell a granted boundary from an intended one.
      //
      // `what` only. Each boundary also carries the internal requirement it came
      // from, which is a cross-reference for whoever maintains this application and
      // noise to everyone else — so it stops at this boundary rather than being
      // rendered and then apologised for.
      rationale: buildPermissionPlan(config, a).rationale.map((r) => r.what),
      hooksAudited: a.hasPermissionHooks !== null,
      hasPermissionHooks: a.hasPermissionHooks,
      protocolOk: p.ok,
      protocolVersion: p.fileVersion,
      skillsOk: s.ok,
      otherSkills: s.otherSkills,
    });
  }
  return {
    agents: out,
    commsRoot: config.commsRoot,
    configFile: config.configFile,
    repoRoot: config.repoRoot,
    defaultModel: config.defaults.model,
  };
}

/**
 * The vocabulary the page renders its controls from.
 *
 * Fetched once at load, before anything else. Every list in it is derived from the
 * constant that defines the thing — message types from `row.ts`, grants and tools
 * from `roster/edit.ts`, verdicts from `sweep.ts` — so the dashboard cannot offer a
 * stale menu. A hardcoded `<option>` list in the page was how `information` came to
 * exist everywhere except the one place an operator could pick it.
 */
export function metaPayload() {
  return {
    messageTypes: MESSAGE_TYPES.map((name) => ({ name, ...MESSAGE_TYPE_INFO[name] })),
    outcomes: OUTCOMES.map((name) => ({ name, what: OUTCOME_INFO[name] })),
    grants: GRANT_FIELDS.map((field) => ({ field, ...GRANT_CATALOGUE[field] })),
    tools: TOOL_CATALOGUE,
    toolGroups: Object.entries(TOOL_GROUPS).map(([group, label]) => ({ group, label })),
    verdicts: INVOCATION_VERDICTS.map((name) => ({ name, ...VERDICT_INFO[name] })),
  };
}

/**
 * The invocation log, projected.
 *
 * Deliberately not the raw entries: those carry `argv`, `stderr` and the agent's
 * final text, which is both heavy for a table and more than a dashboard row needs.
 * V4's point — that a denial records the exact attempted input — is served by the
 * CLI's `log` command, which prints the whole record.
 */
export async function logPayload(config: Config) {
  const entries = await readInvocationLog(config);
  return {
    total: entries.length,
    entries: entries
      .slice(-200)
      .reverse()
      .map((e) => ({
        invocationId: e.invocationId,
        agent: e.agent,
        rowIds: e.rowIds,
        startedAt: e.startedAt,
        wallMs: e.wallMs,
        costUsd: e.costUsd,
        verdict: e.verdict,
        verdictWhy: e.verdictWhy,
        dryRun: e.dryRun,
        denials: e.permissionDenials.map((d) => d.toolName),
        artefacts: e.artefacts.length,
      })),
  };
}
