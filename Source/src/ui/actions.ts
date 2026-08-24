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
import type { Agent, Config } from '../config/load.js';
import { unknownNames } from '../config/load.js';
import { addAgent, removeAgent, updateAgent, RosterError } from '../roster/edit.js';
import type { AgentPatch, AgentPathInput } from '../roster/edit.js';
import { GRANT_FIELDS } from '../roster/edit.js';
import { writeAgentSettings } from '../dispatch/invoke.js';
import { installProtocol } from '../cli/protocol.js';
import { installSkills } from '../cli/skills.js';
import { ensureDir } from '../util/fsx.js';
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

/**
 * Roster edits from the dashboard.
 *
 * Thin on purpose. Every rule that decides whether an edit is allowed lives in
 * `roster/edit.ts` alongside the one the CLI uses, so the two front-ends cannot
 * come to different conclusions about a nesting rule; what is left here is turning
 * loose JSON into the shapes that module expects, and turning its refusals into a
 * 400 the operator can read.
 *
 * These change configuration, not the ledger, so they take no writer lock. The
 * guard that matters is a different one and it lives in the server: a roster edit
 * during a run would change the scoping of an agent already dispatched.
 */

function bool(v: unknown): boolean | undefined {
  if (v === undefined) return undefined;
  return v === true || v === 'true' || v === 'on' || v === 1;
}

function optionalNumber(v: unknown, field: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new BadRequest(`${field} must be a positive number, or blank to use the default.`);
  return n;
}

/**
 * The path rows from the form.
 *
 * Accepts the objects the picker produces and also a plain newline-separated string,
 * which is what the field degrades to if somebody pastes a list. Read defaults on:
 * an entry with neither box ticked grants nothing and is dropped in cleanPaths, and
 * silently dropping a directory somebody just added would look like the form losing
 * it.
 */
function pathList(v: unknown): AgentPathInput[] {
  if (typeof v === 'string') {
    return v
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((path) => ({ path, read: true, write: false }));
  }
  if (!Array.isArray(v)) throw new BadRequest('paths must be a list of directories.');
  return v.map((row) => {
    if (typeof row === 'string') return { path: row, read: true, write: false };
    const r = row as Record<string, unknown>;
    return { path: String(r.path ?? ''), read: r.read !== false, write: r.write === true };
  });
}

function stringList(v: unknown, field: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') {
    return v
      .split(/[\r\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  throw new BadRequest(`${field} must be a list.`);
}

/** The editable half of a roster entry, read out of a form body. */
export function agentPatchFrom(body: Record<string, unknown>): AgentPatch {
  const patch: AgentPatch = {};
  if (body.description !== undefined) patch.description = String(body.description);
  if (body.model !== undefined) patch.model = String(body.model);
  for (const flag of GRANT_FIELDS) {
    const v = bool(body[flag]);
    if (v !== undefined) patch[flag] = v;
  }
  if (body.paths !== undefined) patch.paths = pathList(body.paths);
  const tools = stringList(body.tools, 'tools');
  if (tools) patch.tools = tools;

  const silence = optionalNumber(body.silenceTimeoutMs, 'silenceTimeoutMs');
  if (silence !== undefined) patch.silenceTimeoutMs = silence;
  const wall = optionalNumber(body.wallClockTimeoutMs, 'wallClockTimeoutMs');
  if (wall !== undefined) patch.wallClockTimeoutMs = wall;
  const budget = optionalNumber(body.maxBudgetUsd, 'maxBudgetUsd');
  if (budget !== undefined) patch.maxBudgetUsd = budget;

  return patch;
}

/**
 * A refusal from the roster rules, flattened into one message.
 *
 * `RosterError` carries the reason *and* the requirement behind it — "nesting makes
 * write scoping unenforceable (X4)" — and losing the details to a generic 400 would
 * leave the operator with a rule and no argument for it.
 */
function asBadRequest(err: unknown): never {
  if (err instanceof RosterError) {
    throw new BadRequest([err.message, ...err.details].join(' '));
  }
  throw err;
}

export async function addRosterAgent(config: Config, body: Record<string, unknown>) {
  const name = String(body.name ?? '').trim();
  const home = String(body.home ?? '').trim();
  if (!home) throw new BadRequest('A home directory is required. This tool registers directories that already exist.');

  let change;
  try {
    change = await addAgent(config, { name, home, ...agentPatchFrom(body) });
  } catch (err) {
    asBadRequest(err);
  }

  // The two things this application owns inside an agent's home, written at
  // registration exactly as `orchestrator agent add` writes them (L5, X6).
  await ensureDir(change.agent.outbox);
  await writeAgentSettings(change.config, change.agent);

  const installed = bool(body.installProtocol)
    ? await installAgentContract(change.config, change.agent)
    : null;

  return { ...change, installed };
}

export async function updateRosterAgent(config: Config, body: Record<string, unknown>) {
  const name = String(body.name ?? '').trim();
  if (!name) throw new BadRequest('Which agent?');

  let change;
  try {
    change = await updateAgent(config, name, agentPatchFrom(body));
  } catch (err) {
    asBadRequest(err);
  }

  // Regenerated immediately rather than at the next dispatch. Dispatch rewrites this
  // file anyway, but an operator who ticks a box and then reads the settings file
  // should not be shown the answer from before they ticked it.
  await writeAgentSettings(change.config, change.agent);
  return change;
}

export async function removeRosterAgent(config: Config, body: Record<string, unknown>) {
  const name = String(body.name ?? '').trim();
  if (!name) throw new BadRequest('Which agent?');
  try {
    return await removeAgent(config, name);
  } catch (err) {
    asBadRequest(err);
  }
}

/**
 * The agent-side half of the contract: the protocol file, the CLAUDE.md pointer and
 * the ledger skills.
 *
 * One action rather than three, for the reason `agent add --write-protocol` gives:
 * they are installed together or one of them ends up not installed at all.
 */
export async function installAgentContract(config: Config, agent: Agent) {
  const protocol = await installProtocol(agent, config);
  const skills = await installSkills(agent);
  return {
    protocol: {
      wroteFile: protocol.wroteFile,
      wrotePointer: protocol.wrotePointer,
      removedLegacy: protocol.removedLegacy,
      claudeMdMissing: protocol.claudeMdMissing,
      notes: protocol.notes,
    },
    skills: skills.map((s) => ({ name: s.name, wrote: s.wrote, updated: s.updated })),
  };
}

export async function installContractFor(config: Config, body: Record<string, unknown>) {
  const name = String(body.name ?? '').trim();
  const agent = config.agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!agent) throw new BadRequest(`"${name}" is not in the roster.`);
  return installAgentContract(config, agent);
}
