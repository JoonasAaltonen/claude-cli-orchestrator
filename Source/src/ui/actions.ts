/**
 * The things the dashboard can do that change something.
 *
 * Each one mirrors the CLI command of the same name — same functions, same guards,
 * same order — so the two front-ends cannot drift into disagreeing about what
 * `write` means. Where the CLI parses flags and prints, this parses JSON and
 * returns; the middle is shared.
 *
 * Everything that appends takes the writer lock. `run` is the exception only in
 * that it takes the lock in `runner.ts` and holds it across the whole loop rather
 * than one append.
 */
import type { Config } from '../config/load.js';
import { unknownNames } from '../config/load.js';
import { appendRow, initCommsRoot, layout } from '../ledger/store.js';
import { MESSAGE_TYPES, OPERATOR, OUTCOMES } from '../ledger/row.js';
import type { MessageType, Outcome } from '../ledger/row.js';
import { withWriterLock } from '../ledger/lock.js';
import { recordChainBudget, readChainBudgets } from '../guards/budget.js';
import { dispatchOnce } from '../dispatch/run.js';
import type { DispatchOutcome } from '../dispatch/run.js';
import { writeText } from '../util/fsx.js';
import { promises as fsp } from 'node:fs';
import { nowIso } from '../util/time.js';

/** A message the operator can act on, rather than a stack trace. */
export class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequest';
  }
}

export interface WriteInput {
  to?: unknown;
  type?: unknown;
  summary?: unknown;
  body?: unknown;
  replyTo?: unknown;
  needs?: unknown;
  outcome?: unknown;
  hopBudget?: unknown;
  invocationCeiling?: unknown;
}

function names(value: unknown, field: string): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/[+,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (value == null) return [];
  throw new BadRequest(`${field} must be a list of names.`);
}

/**
 * `orchestrator write`, as an operator row.
 *
 * Validation is deliberately up front and specific. A form that accepts a bad
 * `replyTo` and fails inside `appendRow` gives the operator a parser's complaint;
 * this gives them the field that is wrong.
 */
export async function writeRow(config: Config, input: WriteInput) {
  await initCommsRoot(config);

  const to = names(input.to, 'to');
  if (!to.length) throw new BadRequest('Name at least one recipient.');

  // A recipient nobody answers to appends a valid row that never dispatches. The
  // thread simply sits open. Catching it here is the difference between a typo and
  // a silent no-op discovered days later.
  const roster = config.agents.map((a) => a.name).join(', ') || '(the roster is empty)';
  const strangers = unknownNames(config, to);
  if (strangers.length) {
    throw new BadRequest(
      `No agent named ${strangers.join(', ')}. On the roster: ${roster}.`
    );
  }
  const needsStrangers = unknownNames(config, names(input.needs, 'needs'));
  if (needsStrangers.length) {
    throw new BadRequest(`No agent named ${needsStrangers.join(', ')}. On the roster: ${roster}.`);
  }

  const summary = String(input.summary ?? '').trim();
  if (!summary) throw new BadRequest('A summary is required — it is the line every agent sees first.');

  const type = String(input.type ?? 'request') as MessageType;
  if (!MESSAGE_TYPES.includes(type)) {
    throw new BadRequest(`type must be one of: ${MESSAGE_TYPES.join(', ')}`);
  }

  const outcome = input.outcome ? (String(input.outcome) as Outcome) : null;
  if (outcome && !OUTCOMES.includes(outcome)) {
    throw new BadRequest(`outcome must be one of: ${OUTCOMES.join(', ')}`);
  }

  // L3 — the row is an address label; the substance lives in the file. An empty
  // body would make the file say nothing the index does not already.
  const body = String(input.body ?? '').trim() || summary;
  const replyTo = input.replyTo ? String(input.replyTo).padStart(4, '0') : null;

  return withWriterLock(config, 'ui: write', async () => {
    const { row, messageFile } = await appendRow(config, {
      writer: OPERATOR,
      draft: {
        to,
        type,
        replyTo,
        needs: names(input.needs, 'needs'),
        outcome,
        summary,
        body,
      },
    });

    // C1 — a new chain records its ceiling once, at creation.
    let budget = null;
    if (!row.replyTo) {
      await recordChainBudget(config, {
        rootId: row.id,
        hopBudget: input.hopBudget ? Number(input.hopBudget) : config.defaults.hopBudget,
        invocationCeiling: input.invocationCeiling
          ? Number(input.invocationCeiling)
          : config.defaults.invocationCeiling,
        createdAt: nowIso(),
        createdBy: OPERATOR,
      });
      budget = (await readChainBudgets(config)).get(row.id) ?? null;
    }

    return { row, messageFile, budget };
  });
}

/**
 * One agent, one dispatch — the "Preview dispatch" button and its live twin.
 *
 * A dry run spends nothing and needs no lock in principle, but takes one anyway:
 * it reads the same fold a real run would, and letting it interleave with a live
 * run would show a plan that was never true.
 */
export async function dispatchAgent(
  config: Config,
  agent: string,
  dryRun: boolean
): Promise<DispatchOutcome> {
  return withWriterLock(config, `ui: dispatch ${agent}${dryRun ? ' (dry run)' : ''}`, () =>
    dispatchOnce(config, agent, { dryRun, onLog: () => {} })
  );
}

/** C3 — the kill switch. Checked before every dispatch and polled during one. */
export async function setKillSwitch(config: Config, reason: string): Promise<string> {
  await initCommsRoot(config);
  const file = layout(config).kill;
  await writeText(file, `${reason || 'stopped by the operator'}\n${nowIso()}\n`);
  return file;
}

export async function clearKillSwitch(config: Config): Promise<string> {
  const file = layout(config).kill;
  await fsp.rm(file, { force: true });
  return file;
}
