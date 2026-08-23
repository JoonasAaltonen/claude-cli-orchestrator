/**
 * Configuration, and with it the roster.
 *
 * P1 — "The agent roster is configuration, not code. Adding an agent is a config
 * entry plus a directory — no code change, no per-agent branch anywhere in the
 * application." There is no per-agent branch below this line, anywhere.
 *
 * T4 — the roster lives in the application's own configuration, not in the comms
 * root. It holds installation-specific absolute paths and the P3 security flag,
 * none of which agents need. Agents that need to know who exists get a participant
 * list derived from the index instead (see fold.ts).
 */
import { z } from 'zod';
import { NAME_PATTERN, OPERATOR, ORCHESTRATOR } from '../ledger/row.js';

/**
 * The built-in tool set an orchestrator-dispatched agent gets. Note what is absent
 * and, more importantly, what is *denied* rather than absent — see X1 and
 * denyList() in dispatch/permissions.ts. Omission shapes the easy path; only a
 * deny rule is a boundary.
 */
export const DEFAULT_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite'] as const;

export const agentSchema = z.object({
  /** Roster key. Also the `Writer` value in every row this agent produces. */
  name: z
    .string()
    .regex(NAME_PATTERN, 'Agent names are alphanumeric with . _ -')
    .refine((n) => n.toLowerCase() !== OPERATOR, `"${OPERATOR}" is reserved for the human`)
    .refine((n) => n.toLowerCase() !== ORCHESTRATOR, `"${ORCHESTRATOR}" is reserved for the application`),

  /** D2 — the working directory the CLI is invoked in, so it loads this CLAUDE.md. */
  home: z.string().min(1),

  description: z.string().default(''),

  /** Model alias or full name. Per-agent so a cheap agent stays cheap (C6). */
  model: z.string().optional(),

  /**
   * P2 — an agent whose directory the operator works in interactively must be
   * markable as dispatch-excluded. Rows addressed to it queue for manual relay
   * (J3) instead of being dispatched.
   */
  dispatchExcluded: z.boolean().default(false),

  /**
   * P3 — does this agent's directory run permission-granting hooks? X7 explains
   * why: convenience hooks that auto-approve on a filter or a magic prefix are
   * common and are holes under orchestration. `orchestrator doctor` sets this by
   * inspection; a null means it has never been audited, which doctor reports as a
   * finding rather than assuming either answer.
   */
  hasPermissionHooks: z.boolean().nullable().default(null),
  hooksAuditedAt: z.string().nullable().default(null),

  /**
   * X2 — if an agent's job genuinely requires a shell, its file boundaries are
   * advisory and must be enforced somewhere else. Recorded explicitly rather than
   * pretending the path rules hold. Setting this true also re-opens X3a: skill-write
   * stops being safe, so permissions.ts denies skill writes for this agent.
   */
  shellAllowed: z.boolean().default(false),

  /** X3 — .mcp.json entries start processes, connected without approval in -p mode. */
  allowMcp: z.boolean().default(false),

  /**
   * X3 — subagent definitions carry tool grants, and published reports show
   * subagents executing tools absent from the project allowlist with no permission
   * check. The Task tool is denied unless this is set.
   */
  allowSubagents: z.boolean().default(false),

  /**
   * Directories outside this agent's home that it may reach, and what it may do
   * there.
   *
   * One entry per directory with two flags, rather than a read list and a write
   * list, because a directory an agent both reads and writes would otherwise have to
   * be typed twice and kept in step by hand. The two lists could disagree; one entry
   * with two checkboxes cannot.
   */
  paths: z
    .array(
      z.object({
        path: z.string().min(1),
        read: z.boolean().default(true),
        write: z.boolean().default(false),
      })
    )
    .default([]),

  /**
   * The shape this used to be: read-only document stores, one string each.
   *
   * Still accepted, and folded into `paths` on load as read-without-write, which is
   * exactly what it meant. Kept rather than migrated because a configuration file is
   * the operator's, and a tool that silently rewrites one is a tool you cannot leave
   * a comment in.
   */
  readPaths: z.array(z.string()).default([]),

  /**
   * May this agent write anywhere in its own home, or only into its outbox?
   *
   * L5 gives every agent exactly one outbox and that is where the *message* goes.
   * It says nothing about the agent's ordinary work, and the default here — outbox
   * only — turned out to mean an agent could not save the document it was asked to
   * produce into the directory it lives in. That failure is invisible from the
   * prompt: the agent tries, is denied, and writes an apology into its message.
   *
   * So it is on by default. The argument for off was that a home-wide grant is the
   * operator's call rather than a default they discover; the argument that beat it
   * is that an agent which cannot write in its own directory cannot do the work it
   * was registered to do, and the operator discovers *that* instead — later, from an
   * apology in a message. An agent confined to its outbox is the special case, and
   * `--no-home-writable` is how it is asked for.
   *
   * The X3 deny rules for `.claude/settings.json`, `.mcp.json` and the generated
   * files still apply on top — deny beats allow — so this widens the working area
   * without opening the self-grant paths. That is what makes the default safe to
   * turn on: the paths by which an agent could grant itself more stay shut.
   */
  homeWritable: z.boolean().default(true),

  /** Built-in tools this agent may use. Denials in permissions.ts still apply on top. */
  tools: z.array(z.string()).default([...DEFAULT_TOOLS]),

  /** Per-agent overrides of the dispatch defaults. */
  silenceTimeoutMs: z.number().int().positive().optional(),
  wallClockTimeoutMs: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
});

export type AgentConfigInput = z.input<typeof agentSchema>;

export const configSchema = z.object({
  /**
   * T1, T2 — the comms root is its own directory, outside every agent's home,
   * outside any shared document store the agents read, and not the repository.
   * Validated in load.ts, not here, because the check is cross-field.
   */
  commsRoot: z.string().min(1),

  /** F3 — the spelling is verified against the installed CLI by `doctor`. */
  claudeBin: z.string().default('claude'),

  /** D8 — the prompt template is a versioned file, not a string literal in code. */
  promptTemplate: z.string().default('templates/prompt/v1.md'),

  /**
   * F1 — authentication mode is configuration, not architecture. "subscription"
   * inherits the CLI's own credential resolution; "api-key" requires
   * ANTHROPIC_API_KEY and is a one-line switch, not a rewrite.
   */
  auth: z
    .object({
      mode: z.enum(['subscription', 'api-key']).default('subscription'),
      apiKeyEnvVar: z.string().default('ANTHROPIC_API_KEY'),
    })
    .default({ mode: 'subscription', apiKeyEnvVar: 'ANTHROPIC_API_KEY' }),

  defaults: z
    .object({
      model: z.string().default('sonnet'),
      /** C1 — every chain carries a finite budget, attached to the chain not the hop. */
      hopBudget: z.number().int().positive().default(8),
      invocationCeiling: z.number().int().positive().default(12),
      /** V7 — silence detection rather than elapsed time. */
      silenceTimeoutMs: z.number().int().positive().default(180_000),
      wallClockTimeoutMs: z.number().int().positive().default(1_800_000),
      /** A hard stop the CLI enforces itself, underneath our own caps. */
      maxBudgetUsd: z.number().positive().default(2),
      /**
       * V3 outcome 2 — "ran but produced nothing" — is the common case. C6 says a
       * failed invocation costs more than a successful one, so retries are cheap to
       * get wrong. One retry, then escalate to the operator.
       */
      maxAttemptsPerRow: z.number().int().positive().default(2),
      /**
       * --permission-mode. `dontAsk` suppresses the prompt that cannot be answered
       * in a non-interactive run, leaving the deny rules to decide. `doctor` and
       * `probe` verify this empirically rather than trusting the name.
       */
      permissionMode: z
        .enum(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'])
        .default('dontAsk'),
    })
    .default({}),

  /**
   * How the message contract reaches the agent.
   *
   * T6 puts the message format in the expensive column — "every agent satisfies it
   * from prose instructions, and agents get formats wrong" — so both of these exist
   * to stop relying on prose. Both default on, and turning either off degrades to
   * the behaviour that came before it rather than breaking anything: the outbox
   * sweep still accepts a hand-written file, and the prompt still carries the
   * contract as text. That is deliberate. Neither mechanism is load-bearing on its
   * own, which is what makes it safe to depend on them.
   */
  contract: z
    .object({
      /**
       * Offer the `submit_message` MCP tool, so the agent supplies fields and the
       * application writes the file. Removes the format from the agent's hands and
       * turns an M7 bounce — two cold invocations — into a free in-session retry.
       */
      mcp: z.boolean().default(true),
      /**
       * Deliver the prompt through the installed skill (`/ledger-invocation`)
       * rather than as prose. Measured on CLI 2.1.237: a slash command resolves in
       * a --print run and $ARGUMENTS is substituted, both client-side, so the skill
       * body is injected rather than being something the model chooses to read.
       */
      skill: z.boolean().default(true),
    })
    .default({}),

  /** C2 — a per-hour global cap and a per-thread invocation cap. */
  caps: z
    .object({
      perHourInvocations: z.number().int().positive().default(30),
      perThreadInvocations: z.number().int().positive().default(12),
    })
    .default({}),

  /** L7 — a thread older than N days is surfaced to a human. It is not closed. */
  staleThreadDays: z.number().positive().default(3),

  /** M5 — two rejections on a thread, then it stops and escalates to the operator. */
  maxRejectionsPerThread: z.number().int().positive().default(2),

  /** L6 — the recent-decisions digest injected into every cold agent's prompt. */
  decisionsDigestLimit: z.number().int().positive().default(15),

  /**
   * §7b. Nothing in v1 listens — §12 defers the MCP server and J2 is served by the
   * CLI — so these keys currently configure nothing. They are here because N5 and
   * N6 are decisions worth recording before the socket exists, not after.
   *
   * N1: loopback only, never 0.0.0.0 or ::. N5: 40000–49151, not a round number,
   * below every common framework default and below the 49152 ephemeral floor (N7).
   */
  ports: z
    .object({
      bindAddress: z
        .enum(['127.0.0.1', '::1'])
        .default('127.0.0.1')
        .describe('N1 — the bind address, not the protocol, determines exposure'),
      mcp: z.number().int().min(1024).max(49151).default(43817),
      operatorView: z.number().int().min(1024).max(49151).default(43818),
    })
    .default({}),

  agents: z.array(agentSchema).default([]),
});

export type ConfigInput = z.input<typeof configSchema>;
