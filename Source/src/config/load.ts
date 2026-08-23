/**
 * Loading, normalising and cross-checking configuration.
 *
 * Every path is canonicalised here, on ingest, exactly once — T5's second
 * consequence ("two spellings of one directory silently become two agents") is
 * prevented at this boundary and assumed everywhere downstream.
 *
 * The cross-field checks below are the ones the schema cannot express: T1, T2, P4
 * and L4 are all statements about how two configured paths relate to each other.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSchema } from './schema.js';
import type { ConfigInput } from './schema.js';
import { canonical, isWithin, longPathWarning, pathKey, samePath } from '../util/paths.js';
import { readTextIfExists } from '../util/fsx.js';
import { OPERATOR, ORCHESTRATOR } from '../ledger/row.js';

export interface AgentPath {
  path: string;
  read: boolean;
  write: boolean;
}

export interface Agent {
  name: string;
  home: string;
  outbox: string;
  description: string;
  model: string | undefined;
  dispatchExcluded: boolean;
  hasPermissionHooks: boolean | null;
  hooksAuditedAt: string | null;
  shellAllowed: boolean;
  allowMcp: boolean;
  allowSubagents: boolean;
  /** Directories outside its home that it may reach, and what it may do there. */
  paths: AgentPath[];
  /** May write anywhere in its own home, not only its outbox. */
  homeWritable: boolean;
  tools: string[];
  silenceTimeoutMs: number | undefined;
  wallClockTimeoutMs: number | undefined;
  maxBudgetUsd: number | undefined;
}

export interface Config {
  configFile: string;
  repoRoot: string;
  commsRoot: string;
  claudeBin: string;
  promptTemplate: string;
  auth: { mode: 'subscription' | 'api-key'; apiKeyEnvVar: string };
  defaults: {
    model: string;
    hopBudget: number;
    invocationCeiling: number;
    silenceTimeoutMs: number;
    wallClockTimeoutMs: number;
    maxBudgetUsd: number;
    maxAttemptsPerRow: number;
    permissionMode: string;
  };
  /** How the message contract reaches the agent — see schema.ts for why both exist. */
  contract: { mcp: boolean; skill: boolean };
  caps: { perHourInvocations: number; perThreadInvocations: number };
  staleThreadDays: number;
  maxRejectionsPerThread: number;
  decisionsDigestLimit: number;
  ports: { bindAddress: string; mcp: number; operatorView: number };
  agents: Agent[];
  /** Non-fatal findings surfaced by `doctor` and by every command that loads config. */
  warnings: string[];
}

export const DEFAULT_CONFIG_FILENAME = 'orchestrator.config.json';

/**
 * Where the code and its templates live: the `Source` directory of a checkout.
 *
 * Resolved from this module rather than from `process.cwd()` so it is the same
 * whether the CLI was started from a checkout, from `npm run orchestrator`, or by
 * the MCP server the CLI spawns with an agent's home as its working directory.
 * `src/config/load.ts` and `dist/config/load.js` are both two levels down, so one
 * expression covers the dev run and the built one.
 */
export function appRoot(): string {
  // Source/src/config/load.ts -> Source/src/config -> Source/src -> Source
  return canonical(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
}

/**
 * The checkout: README, docs, and this installation's configuration file.
 *
 * Distinct from `appRoot()` because the node project sits one level down, and it is
 * this wider boundary the guards care about. T2 and P4 are statements about the
 * application as a whole — a comms root in `<checkout>/docs`, or an agent rooted at
 * the checkout, are exactly what they exist to refuse, and a check against `Source`
 * alone would wave both through.
 */
export function repoRoot(): string {
  return canonical(path.join(appRoot(), '..'));
}

export function defaultConfigPath(): string {
  return process.env.ORCHESTRATOR_CONFIG
    ? canonical(process.env.ORCHESTRATOR_CONFIG)
    : path.join(repoRoot(), DEFAULT_CONFIG_FILENAME);
}

export class ConfigError extends Error {
  constructor(message: string, readonly details: string[] = []) {
    super(message);
    this.name = 'ConfigError';
  }
}

export async function loadConfig(configFile?: string): Promise<Config> {
  const file = configFile ? canonical(configFile) : defaultConfigPath();
  const text = await readTextIfExists(file);
  if (text === null) {
    throw new ConfigError(`No configuration at ${file}`, [
      'Run `orchestrator init` to create a comms root and write this file, then `orchestrator agent add <name> --home <dir>` for each agent directory you already have.',
      'Or set ORCHESTRATOR_CONFIG to point at an existing one.',
    ]);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err: any) {
    // T5, first consequence: JSON is one of the two places backslashes need
    // escaping. This is the error that shows up when they were not.
    throw new ConfigError(`${file} is not valid JSON: ${err?.message ?? String(err)}`, [
      'Windows paths in JSON need doubled backslashes: "C:\\\\YourDirectory\\\\agents\\\\worker" (T5).',
    ]);
  }

  const parsed = configSchema.safeParse(raw as ConfigInput);
  if (!parsed.success) {
    throw new ConfigError(
      `${file} does not match the configuration schema`,
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    );
  }
  return normalise(parsed.data, file);
}

/**
 * One list of directories from the two the schema accepts.
 *
 * `readPaths` is the older spelling and means read-without-write, so it folds in as
 * exactly that. Both are canonicalised here for T5's second consequence — two
 * spellings of one directory would otherwise become two entries whose flags could
 * disagree, and the one that lost the race would be the one enforced.
 */
function mergePaths(
  paths: readonly { path: string; read: boolean; write: boolean }[],
  readPaths: readonly string[],
  base: string
): AgentPath[] {
  const byKey = new Map<string, AgentPath>();
  const add = (p: string, read: boolean, write: boolean): void => {
    const abs = canonical(p, base);
    const existing = byKey.get(pathKey(abs));
    // Two entries for one directory are merged permissively rather than one winning.
    // The alternative is an operator ticking write on a path that is also in the
    // legacy list and watching the tick do nothing.
    byKey.set(pathKey(abs), {
      path: abs,
      read: read || existing?.read || false,
      write: write || existing?.write || false,
    });
  };
  for (const p of readPaths) add(p, true, false);
  for (const p of paths) add(p.path, p.read, p.write);
  // An entry granting neither is not a boundary, it is a line in a config file.
  return [...byKey.values()].filter((p) => p.read || p.write);
}

function normalise(c: ReturnType<typeof configSchema.parse>, file: string): Config {
  const warnings: string[] = [];
  const root = repoRoot();
  const base = path.dirname(file);
  const commsRoot = canonical(c.commsRoot, base);

  const agents: Agent[] = c.agents.map((a) => {
    const home = canonical(a.home, base);
    return {
      name: a.name,
      home,
      outbox: path.join(home, 'outbox'), // L5 — one outbox, inside the agent's own home
      description: a.description,
      model: a.model,
      dispatchExcluded: a.dispatchExcluded,
      hasPermissionHooks: a.hasPermissionHooks,
      hooksAuditedAt: a.hooksAuditedAt,
      shellAllowed: a.shellAllowed,
      allowMcp: a.allowMcp,
      allowSubagents: a.allowSubagents,
      paths: mergePaths(a.paths, a.readPaths, base),
      homeWritable: a.homeWritable,
      tools: a.tools,
      silenceTimeoutMs: a.silenceTimeoutMs,
      wallClockTimeoutMs: a.wallClockTimeoutMs,
      maxBudgetUsd: a.maxBudgetUsd,
    };
  });

  const config: Config = {
    configFile: file,
    repoRoot: root,
    commsRoot,
    claudeBin: c.claudeBin,
    promptTemplate: canonical(c.promptTemplate, appRoot()),
    auth: c.auth,
    defaults: c.defaults,
    contract: c.contract,
    caps: c.caps,
    staleThreadDays: c.staleThreadDays,
    maxRejectionsPerThread: c.maxRejectionsPerThread,
    decisionsDigestLimit: c.decisionsDigestLimit,
    ports: c.ports,
    agents,
    warnings,
  };

  const fatal = crossCheck(config, warnings);
  if (fatal.length) {
    throw new ConfigError(`Configuration in ${file} is not usable`, fatal);
  }
  return config;
}

/**
 * The relationships between configured paths. Returns fatal errors; pushes
 * non-fatal findings onto `warnings`.
 */
function crossCheck(c: Config, warnings: string[]): string[] {
  const fatal: string[] = [];
  const seenNames = new Map<string, string>();
  const seenHomes = new Map<string, string>();

  // T2 — the repository is not the comms root and is not nested in any of the
  // directories it orchestrates. Nested, "clone it and configure your paths" stops
  // working because code and data are tangled.
  if (samePath(c.commsRoot, c.repoRoot)) {
    fatal.push(`commsRoot is the application repository (${c.repoRoot}). T2: the comms root is an installation's data; the application is a generic repository kept elsewhere.`);
  } else if (isWithin(c.repoRoot, c.commsRoot)) {
    fatal.push(`commsRoot (${c.commsRoot}) is inside the application repository. T2 requires them separate.`);
  } else if (isWithin(c.commsRoot, c.repoRoot)) {
    fatal.push(`The application repository is inside commsRoot (${c.commsRoot}). T2 requires them separate.`);
  }

  const lp = longPathWarning(c.commsRoot, 100);
  if (lp) warnings.push(`commsRoot: ${lp}`);

  for (const a of c.agents) {
    const nameKey = a.name.toLowerCase();
    const prevName = seenNames.get(nameKey);
    if (prevName) {
      fatal.push(`Two agents are named "${a.name}". Roster names are unique and case-insensitive.`);
    }
    seenNames.set(nameKey, a.name);

    // T5, second consequence, made enforceable.
    const homeKey = pathKey(a.home);
    const prevHome = seenHomes.get(homeKey);
    if (prevHome) {
      fatal.push(`Agents "${prevHome}" and "${a.name}" resolve to the same directory (${a.home}). On Windows two spellings of one path are one directory.`);
    }
    seenHomes.set(homeKey, a.name);

    // P4 — the orchestrator's own working directory is never a dispatch target.
    if (samePath(a.home, c.repoRoot) || isWithin(a.home, c.repoRoot)) {
      fatal.push(`Agent "${a.name}" is rooted at or above the orchestrator's own directory (${a.home}). P4: it is not an agent and must not be in the roster.`);
    }
    if (isWithin(c.repoRoot, a.home)) {
      fatal.push(`Agent "${a.name}" lives inside the orchestrator repository (${a.home}). P4 and T2 both forbid it.`);
    }

    // L4 — the comms root is a channel, not a document collection, and it sits
    // outside every agent's home. T6 — agents never write into the comms root.
    if (isWithin(a.home, c.commsRoot)) {
      fatal.push(`commsRoot (${c.commsRoot}) is inside agent "${a.name}"'s home. L4: the comms root is its own directory, outside every agent's home.`);
    }
    if (isWithin(c.commsRoot, a.home)) {
      fatal.push(`Agent "${a.name}"'s home is inside commsRoot. L4 and T6 both forbid it.`);
    }

    // An agent whose home contains another agent's home makes X4's write scoping
    // unenforceable: a rule scoped to the outer home grants the inner one.
    for (const b of c.agents) {
      if (b === a) continue;
      if (isWithin(a.home, b.home)) {
        fatal.push(`Agent "${b.name}"'s home is inside agent "${a.name}"'s home. X4 scopes writes per agent, which nesting makes unenforceable.`);
      }
    }

    // P3 — recorded, and its absence is itself a finding (X7).
    if (a.hasPermissionHooks === null) {
      warnings.push(`Agent "${a.name}": permission hooks have never been audited (P3). Run \`orchestrator doctor\` before dispatching to it.`);
    } else if (a.hasPermissionHooks) {
      warnings.push(`Agent "${a.name}": directory contains permission-granting hooks (P3/X7). The orchestrator's permission model is only as strong as the hooks in the target directory.`);
    }

    // X2 — recorded explicitly rather than pretending the path rules hold.
    if (a.shellAllowed) {
      warnings.push(`Agent "${a.name}": shell is allowed (X2), so its file boundaries are advisory and must be enforced somewhere else. X3a: skill-write is therefore denied for this agent.`);
    }

    const alp = longPathWarning(a.home, 60);
    if (alp) warnings.push(`Agent "${a.name}": ${alp}`);

    if (!a.tools.length) {
      warnings.push(`Agent "${a.name}" has an empty tool list and can do nothing but talk.`);
    }
  }

  if (c.agents.length === 0) {
    warnings.push('The roster is empty. Add agents to `agents` in the config file (P1: a config entry plus a directory).');
  }

  // N1, restated as a guard rather than a comment, so it fails if someone edits it.
  if (c.ports.bindAddress !== '127.0.0.1' && c.ports.bindAddress !== '::1') {
    fatal.push(`ports.bindAddress must be loopback (N1). Got "${c.ports.bindAddress}".`);
  }

  return fatal;
}

/** Roster lookup, case-insensitive on name. */
/**
 * The roster's spelling of a name, or null if nobody answers to it.
 *
 * T5's second consequence is about paths — "two spellings of one directory
 * silently become two agents" — and names have exactly the same problem with a
 * worse failure. `To: Coordinator` against a roster holding `coordinator` appends
 * a perfectly valid row that no dispatch will ever pick up, because the fold keys
 * outstanding work by the string in `To` and asks for it by the roster's spelling.
 * The thread sits open forever and nothing reports an error.
 *
 * So names are canonicalised on the way in, in the one place every row goes
 * through, and the fold keeps comparing exact strings.
 */
export function canonicalName(c: Config, name: string): string | null {
  const key = name.trim().toLowerCase();
  if (key === OPERATOR || key === ORCHESTRATOR) return key;
  return c.agents.find((a) => a.name.toLowerCase() === key)?.name ?? null;
}

/** Canonicalises what it recognises and leaves the rest alone, for callers that report separately. */
export function canonicaliseNames(c: Config, names: string[]): string[] {
  return names.map((n) => canonicalName(c, n) ?? n.trim());
}

/** Names nobody on the roster answers to. */
export function unknownNames(c: Config, names: string[]): string[] {
  return names.filter((n) => canonicalName(c, n) === null);
}

export function findAgent(c: Config, name: string): Agent | undefined {
  const key = name.trim().toLowerCase();
  return c.agents.find((a) => a.name.toLowerCase() === key);
}

/** The roster lookup for a path, keyed per T5's case rule. */
export function agentForPath(c: Config, p: string): Agent | undefined {
  const key = pathKey(p);
  return c.agents.find((a) => pathKey(a.home) === key);
}

export function isReservedName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === OPERATOR || n === ORCHESTRATOR;
}

/** Participants that are not agents and are never dispatch targets. */
export function isDispatchable(c: Config, name: string): boolean {
  if (isReservedName(name)) return false;
  const a = findAgent(c, name);
  return !!a && !a.dispatchExcluded;
}
