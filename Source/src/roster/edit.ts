/**
 * Roster edits, with the rules that make them safe, and no printing.
 *
 * P1 says adding an agent is a config entry plus a directory. That is true of the
 * *entry*; it is not true of the checks around it. `agent add` refuses a home that
 * overlaps the repository (P4), the comms root (L4) or another agent (X4), and each
 * refusal exists because the alternative is a boundary that silently does not hold.
 *
 * Those checks used to live inside the CLI command, interleaved with `console.log`
 * and exit codes. A second front-end could not reuse them, and a second front-end
 * that reimplemented them would eventually disagree — which for a nesting rule means
 * the dashboard cheerfully registering a roster the dispatcher cannot scope. So they
 * are here, returning errors rather than printing them, and both front-ends call
 * this.
 */
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { loadConfig, repoRoot } from '../config/load.js';
import type { Agent, Config } from '../config/load.js';
import { NAME_PATTERN, OPERATOR, ORCHESTRATOR } from '../ledger/row.js';
import { canonical, isWithin, longPathWarning } from '../util/paths.js';
import { exists, readTextIfExists, writeText } from '../util/fsx.js';

/**
 * Built-in tools an operator chooses between, and what each one costs to grant.
 *
 * Deliberately not "every tool the CLI has". Shell, subagents and MCP are governed
 * by their own roster flags because each carries a requirement of its own (X1, X3),
 * and offering them twice — once as a flag, once as a checkbox — is how the two end
 * up disagreeing. `buildPermissionPlan` filters anything a flag denies back out, so
 * a stray tick here cannot widen a boundary; it would just be ignored, which is
 * worse than not offering it.
 */
export interface ToolInfo {
  name: string;
  /** What ticking it lets the agent do. */
  what: string;
  /** Non-null when the grant is worth thinking about before ticking. */
  caution: string | null;
  group: 'read' | 'write' | 'plan' | 'network';
}

/**
 * The headings the tools are offered under. Keyed by the group, so a new group
 * cannot be given to a tool without also being given a name — the alternative is a
 * tool that quietly renders under no heading at all, which is a grant an operator
 * never sees and therefore never makes.
 */
export const TOOL_GROUPS: Readonly<Record<ToolInfo['group'], string>> = {
  read: 'Reading',
  write: 'Writing',
  plan: 'Working',
  network: 'The network',
};

export const TOOL_CATALOGUE: readonly ToolInfo[] = [
  { name: 'Read', what: 'Read files inside its workspace.', caution: null, group: 'read' },
  { name: 'Glob', what: 'Find files by name pattern.', caution: null, group: 'read' },
  { name: 'Grep', what: 'Search file contents.', caution: null, group: 'read' },
  { name: 'Write', what: 'Create files where a path rule allows it.', caution: null, group: 'write' },
  { name: 'Edit', what: 'Change existing files where a path rule allows it.', caution: null, group: 'write' },
  {
    name: 'NotebookEdit',
    what: 'Change Jupyter notebooks.',
    caution: null,
    group: 'write',
  },
  { name: 'TodoWrite', what: 'Keep a task list during the invocation. Costs nothing outside it.', caution: null, group: 'plan' },
  {
    name: 'WebSearch',
    what: 'Search the web and read the results.',
    caution:
      'Reaches the network. Search terms leave this machine, and what comes back is untrusted text the agent will read as input.',
    group: 'network',
  },
  {
    name: 'WebFetch',
    what: 'Fetch a named URL.',
    caution:
      'Reaches the network, and the URL is chosen by the agent. Anything it has read — including file contents — can be put in one.',
    group: 'network',
  },
];

const CATALOGUE_NAMES = new Set(TOOL_CATALOGUE.map((t) => t.name));

/**
 * The boolean grants on an agent, and how each one is offered.
 *
 * Before this existed the same five names were written out by hand in the schema,
 * the patcher, the two HTTP handlers, both dashboard renderers and the CLI's option
 * list — eight copies, and a new flag was only in the dashboard if whoever added it
 * remembered all eight. The type below makes remembering unnecessary: it is keyed by
 * `GrantField`, and `_everyAgentFlagIsOffered` fails to compile if `Agent` grows a
 * boolean this catalogue does not describe. A grant that cannot be added without
 * reaching the operator is the property worth having; a comment asking the next
 * person to keep six lists in step is not.
 *
 * `label` and `hint` live here rather than in the page for the same reason. What a
 * boundary costs is a fact about the boundary, and the dashboard is a view of it.
 */
export interface GrantInfo {
  /** The checkbox label. */
  label: string;
  /** What granting it actually means, in one sentence the operator can act on. */
  hint: string;
  /** Grants that widen what the agent can reach beyond its own files. */
  risky: boolean;
  /** What a newly registered agent gets. */
  fallback: boolean;
  /**
   * Shown as a chip on the roster when the flag is at its *non-default* value —
   * the default is not news, and a chip on every row is a chip nobody reads.
   */
  chip: { label: string; tone: 'bad' | 'warn' | 'plain' };
  /** How it reads on the command line. Derived flags would be a rename away from silent breakage. */
  cli: { flag: string; help: string };
}

export type GrantField =
  | 'dispatchExcluded'
  | 'shellAllowed'
  | 'allowMcp'
  | 'allowSubagents'
  | 'homeWritable';

export const GRANT_CATALOGUE: Readonly<Record<GrantField, GrantInfo>> = {
  homeWritable: {
    label: 'Anywhere in its own home directory',
    hint:
      'On by default. Off means it can write only into outbox/ — it cannot save the document it was asked to produce beside its own files, or keep its own notes. Other agents’ homes stay out of reach either way, and the settings files it could use to grant itself more stay denied.',
    risky: false,
    fallback: true,
    chip: { label: 'outbox only', tone: 'plain' },
    cli: { flag: '--no-home-writable', help: 'confine its writing to outbox/ — by default it may write anywhere in its own home' },
  },
  shellAllowed: {
    label: 'Allow a shell (Bash)',
    hint:
      'A shell reaches every path this account can reach, so every path rule above becomes advisory. It also stops the agent writing its own skills, because those two together are a way for it to escalate.',
    risky: true,
    fallback: false,
    chip: { label: 'shell', tone: 'bad' },
    cli: { flag: '--shell-allowed', help: 'X2 — makes its file boundaries advisory, and denies skill-write (X3a)' },
  },
  allowSubagents: {
    label: 'Allow subagents (Task)',
    hint: 'Subagent definitions carry their own tool grants, which this application cannot see into or restrict.',
    risky: true,
    fallback: false,
    chip: { label: 'subagents', tone: 'bad' },
    cli: { flag: '--allow-subagents', help: 'X3 — subagent definitions carry their own tool grants' },
  },
  allowMcp: {
    label: 'Allow its own MCP servers',
    hint: 'Entries in its .mcp.json start processes, with nothing asking first in a non-interactive run.',
    risky: true,
    fallback: false,
    chip: { label: 'mcp', tone: 'bad' },
    cli: { flag: '--allow-mcp', help: 'X3 — .mcp.json entries start processes without an approval step' },
  },
  dispatchExcluded: {
    label: 'Never dispatch this agent',
    hint:
      'For an agent whose directory you work in yourself. Rows addressed to it wait for you to relay them by hand instead of being dispatched.',
    risky: false,
    fallback: false,
    chip: { label: 'dispatch excluded', tone: 'warn' },
    cli: { flag: '--dispatch-excluded', help: 'P2 — set this for any directory you work in interactively' },
  },
};

/** Menu order, and the order the checkboxes appear in. */
export const GRANT_FIELDS = Object.keys(GRANT_CATALOGUE) as GrantField[];

/**
 * Every boolean on an `Agent` must be a described grant. If this stops compiling,
 * a flag was added to the config schema and nowhere else — add it to the catalogue
 * above and it appears in the dashboard, the CLI and the patcher at once.
 */
type BooleanAgentKeys = {
  [K in keyof Agent]-?: Agent[K] extends boolean ? K : never;
}[keyof Agent];
const _everyAgentFlagIsOffered: Readonly<Record<BooleanAgentKeys, GrantInfo>> = GRANT_CATALOGUE;
void _everyAgentFlagIsOffered;


export interface AgentPathInput {
  path: string;
  read?: boolean;
  write?: boolean;
}

/** Fields an operator may change on an existing entry. Name and home are not among them. */
export interface AgentPatch {
  description?: string;
  /** Empty string clears the override and falls back to `defaults.model`. */
  model?: string;
  dispatchExcluded?: boolean;
  shellAllowed?: boolean;
  allowMcp?: boolean;
  allowSubagents?: boolean;
  homeWritable?: boolean;
  paths?: AgentPathInput[];
  tools?: string[];
  silenceTimeoutMs?: number | null;
  wallClockTimeoutMs?: number | null;
  maxBudgetUsd?: number | null;
}

export interface NewAgent extends AgentPatch {
  name: string;
  home: string;
}

/** Raised for anything the operator can fix by typing something different. */
export class RosterError extends Error {
  constructor(message: string, readonly details: string[] = []) {
    super(message);
    this.name = 'RosterError';
  }
}

/** Rewrites the config file in place, preserving anything this module does not own. */
async function mutateConfig(configFile: string, fn: (raw: any) => void): Promise<void> {
  const text = await readTextIfExists(configFile);
  if (text === null) {
    throw new RosterError(`No configuration at ${configFile}.`, ['Run `orchestrator init` first.']);
  }
  const raw = JSON.parse(text);
  raw.agents = raw.agents ?? [];
  fn(raw);
  await writeText(configFile, JSON.stringify(raw, null, 2) + '\n');
}

export function checkName(config: Config, name: string): string[] {
  const errors: string[] = [];
  const trimmed = name.trim();
  if (!trimmed) return ['A name is required.'];
  if (!NAME_PATTERN.test(trimmed)) {
    errors.push(`"${trimmed}" is not a usable name. Names are alphanumeric with . _ - and no spaces.`);
  }
  if (trimmed.toLowerCase() === OPERATOR) errors.push(`"${OPERATOR}" is reserved for the human.`);
  if (trimmed.toLowerCase() === ORCHESTRATOR) errors.push(`"${ORCHESTRATOR}" is reserved for the application.`);
  for (const other of config.agents) {
    if (other.name.toLowerCase() === trimmed.toLowerCase()) {
      errors.push(`An agent named "${other.name}" is already in the roster.`);
    }
  }
  return errors;
}

/**
 * The four ways a home directory can be wrong, all of which are boundary failures
 * rather than typos.
 *
 * The nesting rule (X4) is the one worth stating plainly: write scoping is per agent
 * and is enforced by keeping every other agent's home out of the workspace. Two
 * agents whose homes nest cannot both be scoped, so the second registration is
 * refused rather than accepted into a roster where L5 quietly means nothing.
 */
export async function checkHome(config: Config, home: string, ignoreName?: string): Promise<string[]> {
  const errors: string[] = [];
  const abs = canonical(home);
  const repo = repoRoot();

  if (isWithin(repo, abs) || isWithin(abs, repo)) {
    errors.push(`${abs} overlaps the orchestrator's own directory, so it cannot also be an agent home.`);
  }
  if (isWithin(abs, config.commsRoot) || isWithin(config.commsRoot, abs)) {
    errors.push(`${abs} overlaps the comms root. The ledger is the channel between agents, not one of them.`);
  }
  for (const other of config.agents) {
    if (ignoreName && other.name.toLowerCase() === ignoreName.toLowerCase()) continue;
    if (isWithin(other.home, abs) || isWithin(abs, other.home)) {
      errors.push(
        `${abs} sits inside "${other.name}" (${other.home}), or contains it. Each agent is confined to its own directory, and two that nest cannot both be confined.`
      );
    }
  }

  if (!(await exists(abs))) {
    errors.push(
      `No such directory: ${abs}. This tool registers agent directories that already exist; it does not create them.`
    );
  } else if (!(await fsp.stat(abs)).isDirectory()) {
    errors.push(`Not a directory: ${abs}`);
  }

  return errors;
}

/** Non-fatal things worth saying at the moment of registration. */
export async function homeWarnings(home: string): Promise<string[]> {
  const abs = canonical(home);
  const notes: string[] = [];
  const lp = longPathWarning(abs, 60);
  if (lp) notes.push(lp);
  // X5 — each agent *is* its instruction file. Registering a directory without one
  // is allowed but is almost certainly a mistake.
  if ((await readTextIfExists(path.join(abs, 'CLAUDE.md'))) === null) {
    notes.push('No CLAUDE.md here. Without one, this agent is a general-purpose assistant wearing its name.');
  }
  return notes;
}

/**
 * Path entries, canonicalised and deduplicated.
 *
 * Canonicalising here rather than trusting the form is what makes the typed field
 * behave like the picker: a trailing slash, a forward slash on Windows, a quoted
 * path pasted from a title bar and a relative fragment all land on the same absolute
 * string. The picker never sends anything else; the text box frequently does.
 */
function cleanPaths(values: readonly AgentPathInput[]): { path: string; read: boolean; write: boolean }[] {
  const out = new Map<string, { path: string; read: boolean; write: boolean }>();
  for (const v of values) {
    const raw = String(v?.path ?? '').trim().replace(/^["']|["']$/g, '');
    if (!raw) continue;
    const abs = canonical(raw);
    const read = v.read !== false;
    const write = v.write === true;
    if (!read && !write) continue;
    const prev = out.get(abs.toLowerCase());
    out.set(abs.toLowerCase(), {
      path: abs,
      read: read || prev?.read || false,
      write: write || prev?.write || false,
    });
  }
  return [...out.values()];
}

/**
 * Things worth saying about a granted path, none of which stop the grant.
 *
 * A write grant that reaches the comms root or another agent's home does real damage
 * to the model this application rests on — the ledger stops being something only the
 * application writes, and per-agent confinement stops being per-agent. It is still
 * the operator's call. Somebody determined to hand an agent all of C:\ will not be
 * saved by a refusal here, and a refusal would also block the legitimate case of two
 * agents sharing a working directory on purpose.
 *
 * So it is said, once, at the moment of granting, and then got out of the way.
 */
export function pathWarnings(config: Config, entries: readonly { path: string; write: boolean }[], self?: string): string[] {
  const notes: string[] = [];
  for (const e of entries) {
    if (!e.write) continue;
    if (isWithin(e.path, config.commsRoot) || isWithin(config.commsRoot, e.path)) {
      notes.push(
        `${e.path} contains the ledger. An agent that can write there can write rows as anybody, and nothing downstream would know.`
      );
    }
    if (isWithin(e.path, repoRoot()) || isWithin(repoRoot(), e.path)) {
      notes.push(`${e.path} contains the orchestrator itself, including the code that decides what agents may do.`);
    }
    for (const other of config.agents) {
      if (self && other.name.toLowerCase() === self.toLowerCase()) continue;
      if (isWithin(e.path, other.home) || isWithin(other.home, e.path)) {
        notes.push(
          `${e.path} reaches into "${other.name}" (${other.home}). Each agent is otherwise confined to its own directory; this is the exception you are making.`
        );
      }
    }
  }
  return notes;
}

/**
 * Tools, filtered to the ones actually on offer.
 *
 * An unknown name is dropped rather than refused. `--tools` takes a fixed built-in
 * set, so a typo would not fail loudly — it would produce an agent missing a tool it
 * appears to have been granted, which is the X4 failure shape again.
 */
function cleanTools(values: readonly string[]): string[] {
  return TOOL_CATALOGUE.map((t) => t.name).filter((n) => values.includes(n) && CATALOGUE_NAMES.has(n));
}

/** Applies a patch onto a raw config entry, leaving untouched anything not in it. */
function applyPatch(raw: any, patch: AgentPatch): void {
  if (patch.description !== undefined) raw.description = String(patch.description);
  if (patch.model !== undefined) {
    const m = String(patch.model).trim();
    if (m) raw.model = m;
    else delete raw.model;
  }
  for (const flag of GRANT_FIELDS) {
    if (patch[flag] !== undefined) raw[flag] = !!patch[flag];
  }
  if (patch.paths !== undefined) {
    raw.paths = cleanPaths(patch.paths);
    // The legacy key would otherwise be merged back in on load, resurrecting a path
    // the operator has just removed.
    delete raw.readPaths;
  }
  if (patch.tools !== undefined) raw.tools = cleanTools(patch.tools);
  for (const num of ['silenceTimeoutMs', 'wallClockTimeoutMs', 'maxBudgetUsd'] as const) {
    const v = patch[num];
    if (v === undefined) continue;
    if (v === null) delete raw[num];
    else raw[num] = v;
  }
}

export interface RosterChange {
  /** Reloaded from disk, so it carries every derived field and every cross-check. */
  config: Config;
  agent: Agent;
  warnings: string[];
}

export async function addAgent(config: Config, input: NewAgent): Promise<RosterChange> {
  const name = input.name.trim();
  const errors = [...checkName(config, name), ...(await checkHome(config, input.home))];
  if (errors.length) throw new RosterError(`Cannot add "${name || '(unnamed)'}".`, errors);

  const home = canonical(input.home);
  await mutateConfig(config.configFile, (raw) => {
    const entry: any = {
      name,
      home,
      description: input.description ?? '',
      hasPermissionHooks: null,
      hooksAuditedAt: null,
      paths: [],
    };
    for (const flag of GRANT_FIELDS) entry[flag] = GRANT_CATALOGUE[flag].fallback;
    applyPatch(entry, input);
    raw.agents.push(entry);
  });

  const updated = await reload(config);
  const agent = updated.agents.find((a) => a.name === name);
  if (!agent) throw new RosterError(`"${name}" was written but did not load back. The config file may have been edited concurrently.`);
  return {
    config: updated,
    agent,
    warnings: [...(await homeWarnings(home)), ...pathWarnings(updated, agent.paths, name)],
  };
}

export async function updateAgent(config: Config, name: string, patch: AgentPatch): Promise<RosterChange> {
  const existing = config.agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!existing) throw new RosterError(`"${name}" is not in the roster.`);

  await mutateConfig(config.configFile, (raw) => {
    const entry = raw.agents.find((a: any) => String(a.name).toLowerCase() === name.toLowerCase());
    if (!entry) throw new RosterError(`"${name}" is not in ${config.configFile}.`);
    applyPatch(entry, patch);
  });

  const updated = await reload(config);
  const agent = updated.agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!agent) throw new RosterError(`"${name}" did not load back after the edit.`);
  return { config: updated, agent, warnings: pathWarnings(updated, agent.paths, name) };
}

export async function removeAgent(config: Config, name: string): Promise<{ config: Config; removed: Agent }> {
  const existing = config.agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!existing) throw new RosterError(`"${name}" is not in the roster.`);

  await mutateConfig(config.configFile, (raw) => {
    raw.agents = raw.agents.filter((a: any) => String(a.name).toLowerCase() !== name.toLowerCase());
  });

  return { config: await reload(config), removed: existing };
}

/**
 * Reloading after a write, rather than patching the in-memory object.
 *
 * `loadConfig` is where the cross-checks live and where derived fields like `outbox`
 * are computed. Editing the object in place would skip both, and the first symptom
 * would be a dispatch scoped against a stale path.
 */
async function reload(config: Config): Promise<Config> {
  return loadConfig(config.configFile);
}
