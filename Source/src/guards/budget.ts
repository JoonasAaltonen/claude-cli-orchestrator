/**
 * §8 — Budget, and how a chain stops.
 *
 * C1 is the requirement that makes the rest of it coherent: "The budget attaches to
 * the chain, not to its first hop. 'Nothing runs without my invocation' holds for
 * exactly one hop — after that the system self-propagates. A request carries a hop
 * count and an invocation ceiling when created; every dispatch decrements it; at
 * zero the application stops and writes a row rather than asking for more."
 *
 * Consumption is *derived* from the invocation log rather than stored as a running
 * counter, for the same reason L1 makes ledger state derived: a counter and a log
 * can disagree, and when they do the counter is the one that is wrong. Only the
 * ceilings are recorded, once, when the chain is created.
 */
import type { Config } from '../config/load.js';
import { appendJsonl, layout, readJsonl } from '../ledger/store.js';
import type { InvocationLogEntry } from '../log/invocations.js';
import { exists, readTextIfExists } from '../util/fsx.js';

export interface ChainBudget {
  rootId: string;
  hopBudget: number;
  invocationCeiling: number;
  createdAt: string;
  createdBy: string;
}

export interface ChainSpend {
  rootId: string;
  hopBudget: number;
  invocationCeiling: number;
  hopsUsed: number;
  invocationsUsed: number;
  hopsRemaining: number;
  invocationsRemaining: number;
  exhausted: boolean;
}

/** C1 — recorded once, when the chain is created, not renegotiated later. */
export async function recordChainBudget(config: Config, budget: ChainBudget): Promise<void> {
  await appendJsonl(layout(config).chains, budget);
}

export async function readChainBudgets(config: Config): Promise<Map<string, ChainBudget>> {
  const records = await readJsonl<ChainBudget>(layout(config).chains);
  const out = new Map<string, ChainBudget>();
  // First write wins. "At zero the application stops and writes a row rather than
  // asking for more" — so a later record cannot quietly raise the ceiling.
  for (const r of records) {
    if (r?.rootId && !out.has(r.rootId)) out.set(r.rootId, r);
  }
  return out;
}

/**
 * Derives what a chain has spent. `hopsUsed` counts distinct dispatches within the
 * chain; `invocationsUsed` counts every invocation charged to it, successful or not
 * — C6: "Caps must count invocations, not successes."
 */
export function chainSpend(
  config: Config,
  rootId: string,
  budgets: Map<string, ChainBudget>,
  log: InvocationLogEntry[]
): ChainSpend {
  const b = budgets.get(rootId);
  const hopBudget = b?.hopBudget ?? config.defaults.hopBudget;
  const invocationCeiling = b?.invocationCeiling ?? config.defaults.invocationCeiling;

  const mine = log.filter((e) => e.threadRootIds.includes(rootId));
  const invocationsUsed = mine.length;
  const hopsUsed = mine.length;

  const hopsRemaining = Math.max(0, hopBudget - hopsUsed);
  const invocationsRemaining = Math.max(0, invocationCeiling - invocationsUsed);

  return {
    rootId,
    hopBudget,
    invocationCeiling,
    hopsUsed,
    invocationsUsed,
    hopsRemaining,
    invocationsRemaining,
    exhausted: hopsRemaining <= 0 || invocationsRemaining <= 0,
  };
}

export interface GuardVerdict {
  allowed: boolean;
  /** Set when the chain must stop and a row must go to the operator (C1, C2). */
  escalate: boolean;
  reason: string;
  code:
    | 'ok'
    | 'kill-switch'
    | 'hop-budget'
    | 'invocation-ceiling'
    | 'per-hour-cap'
    | 'per-thread-cap'
    | 'rate-limit-cooldown';
}

/**
 * C3 — "A kill-switch file, checked before every dispatch. The system must be
 * stoppable without finding the terminal or killing a process."
 */
export async function killSwitchTripped(config: Config): Promise<string | null> {
  const file = layout(config).kill;
  if (!(await exists(file))) return null;
  const text = (await readTextIfExists(file)) ?? '';
  // First line only. This string reaches a `Summary` field via the escalation row,
  // and M6 says Summary is one line with no delimiter.
  const firstLine = text.split('\n')[0]?.replace(/;/g, ',').trim() ?? '';
  return firstLine || 'no reason given';
}

/**
 * The whole guard stack, evaluated before every dispatch and in this order:
 * kill switch first because it is the operator's override and must not be
 * outranked by anything, then the chain's own budget (C1), then the global caps
 * (C2).
 */
export async function checkGuards(
  config: Config,
  args: {
    rootId: string;
    budgets: Map<string, ChainBudget>;
    log: InvocationLogEntry[];
    now?: Date;
  }
): Promise<GuardVerdict> {
  const kill = await killSwitchTripped(config);
  if (kill !== null) {
    return {
      allowed: false,
      escalate: false, // Deliberate: the operator already knows, they pulled it.
      reason: `Kill switch is set (${layout(config).kill}): ${kill}`,
      code: 'kill-switch',
    };
  }

  const spend = chainSpend(config, args.rootId, args.budgets, args.log);
  if (spend.hopsRemaining <= 0) {
    return {
      allowed: false,
      escalate: true,
      reason: `Chain ${args.rootId} has used its ${spend.hopBudget}-hop budget (C1). Stopping and writing a row rather than asking for more.`,
      code: 'hop-budget',
    };
  }
  if (spend.invocationsRemaining <= 0) {
    return {
      allowed: false,
      escalate: true,
      reason: `Chain ${args.rootId} has reached its ceiling of ${spend.invocationCeiling} invocations (C1).`,
      code: 'invocation-ceiling',
    };
  }

  // C2 — a per-thread invocation cap, on top of whatever the chain itself declared.
  const perThread = args.log.filter((e) => e.threadRootIds.includes(args.rootId)).length;
  if (perThread >= config.caps.perThreadInvocations) {
    return {
      allowed: false,
      escalate: true,
      reason: `Thread ${args.rootId} has used ${perThread} invocations, at the global per-thread cap of ${config.caps.perThreadInvocations} (C2).`,
      code: 'per-thread-cap',
    };
  }

  // C2 — a per-hour global cap. C6: counts invocations, not successes, because a
  // runaway loop of denials is more expensive than a runaway loop of work.
  const now = args.now ?? new Date();
  const cutoff = now.getTime() - 3_600_000;
  const lastHour = args.log.filter((e) => {
    const t = Date.parse(e.startedAt);
    return Number.isFinite(t) && t >= cutoff;
  }).length;
  if (lastHour >= config.caps.perHourInvocations) {
    return {
      allowed: false,
      escalate: true,
      reason: `${lastHour} invocations in the last hour, at the cap of ${config.caps.perHourInvocations} (C2). Stopping; not self-restarting.`,
      code: 'per-hour-cap',
    };
  }

  return { allowed: true, escalate: false, reason: 'within budget', code: 'ok' };
}
