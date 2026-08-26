/**
 * Building the prompt. D8, D9, D10, D10a, D11.
 *
 * D8 — "The prompt template is a versioned file, not a string literal in code. It
 * is the actual interface: a cold agent sees its CLAUDE.md and whatever the
 * application hands it, and nothing else."
 *
 * D10a is the requirement this module exists to satisfy, and §13b calls it "the one
 * most likely to be discovered late and expensively":
 *
 *   "The thread, not the triggering row, is the unit handed to an agent... In the
 *   shortest realistic chain one agent is invoked twice: once to delegate, and once
 *   to write the report from what came back. The second invocation does not
 *   remember the first. Handed only the reply, it cannot know what was originally
 *   asked or why it delegated anything — it would answer the wrong question, exit 0,
 *   and look exactly like a success."
 *
 * So `buildThreadBlock` walks every pending row back to its root and renders the
 * whole chain, with the message bodies L8 permits this agent to read. A single-hop
 * test passes without any of that, which is why it is asserted in the tests rather
 * than left to inspection.
 */
import path from 'node:path';
import type { Config, Agent } from '../config/load.js';
import type { Fold, Outstanding, Thread } from '../ledger/fold.js';
import { mayReadBody, REASON_INFO } from '../ledger/fold.js';
import type { Row } from '../ledger/row.js';
import { OPERATOR, OUTCOME_INFO } from '../ledger/row.js';
import { readText, readTextIfExists } from '../util/fsx.js';
import { refTo } from '../util/paths.js';
import { MCP_TOOL_ID, SKILL_COMMAND, installedSkillPath } from '../contract/names.js';
import { exists } from '../util/fsx.js';
import { describeWorkspace } from './permissions.js';

export interface PromptInputs {
  agent: Agent;
  /** D5 — pending items batched by recipient. */
  pending: Outstanding[];
  fold: Fold;
  hopsRemaining: number;
  invocationsRemaining: number;
}

export interface BuiltPrompt {
  text: string;
  templatePath: string;
  templateVersion: string;
  /** Recorded in the invocation log so a prompt can be tied to what produced it. */
  rowIds: string[];
  threadRootIds: string[];
  charCount: number;
  /** Whether the prompt was handed over through the skill. Recorded in the log (D9). */
  viaSkill: boolean;
}

/** How much of a message body is inlined before it is replaced by a pointer. */
const MAX_BODY_CHARS = 6000;

export async function buildPrompt(config: Config, inputs: PromptInputs): Promise<BuiltPrompt> {
  const template = await readText(config.promptTemplate);
  const { agent, pending, fold: f } = inputs;

  const threads = uniqueThreads(f, pending);
  const threadBlock = await buildThreadBlock(config, agent, threads);
  const pendingBlock = buildPendingBlock(config, agent, pending);
  const decisionsBlock = buildDecisionsBlock(config, f);

  // A hint, not a rule: the frontmatter example in the template is more useful when
  // it is pre-filled with the row this agent is most likely answering.
  const primary = pending[0]?.row;
  const replyToHint = primary ? primary.writer : OPERATOR;
  const replyToIdHint = primary ? primary.id : '0001';

  const participants = uniqueParticipants(config, f, agent);

  const filled = fill(template, {
    AGENT_NAME: agent.name,
    OUTBOX: agent.outbox,
    DELIVERY_BLOCK: buildDeliveryBlock(config, agent, replyToHint, replyToIdHint),
    DELIVERY_STEP: config.contract.mcp
      ? `Call \`${MCP_TOOL_ID}\` with your message.`
      : `Write **one** file into \`${agent.outbox}\`.`,
    COMMS_ROOT: config.commsRoot,
    WORKSPACE_BLOCK: describeWorkspace(config, agent),
    PARTICIPANTS: participants.join(' · '),
    ROSTER_BLOCK: buildRosterBlock(config, participants, agent),
    REPLY_TO_HINT: replyToHint,
    REPLY_TO_ID_HINT: replyToIdHint,
    THREAD_BLOCK: threadBlock,
    PENDING_BLOCK: pendingBlock,
    DECISIONS_BLOCK: decisionsBlock,
    HOPS_REMAINING: String(inputs.hopsRemaining),
    INVOCATIONS_REMAINING: String(inputs.invocationsRemaining),
  });

  // Measured on CLI 2.1.237: a slash command on the first line of a --print prompt is
  // expanded before the model sees anything, and the remainder lands in $ARGUMENTS.
  // So the skill body is *prepended*, not merely offered — which is the difference
  // between an instruction and a request. The command has to be the first token, so
  // this is the last thing done to the text rather than part of the template.
  //
  // The file is checked rather than assumed. An unresolved slash command does not
  // fail loudly — it arrives as five stray characters at the head of an otherwise
  // valid prompt — so a missing skill would degrade into something that mostly works
  // and is hard to notice. Sending the plain prompt is the honest fallback, and
  // `doctor` reports the missing file separately.
  const usingSkill = config.contract.skill && (await exists(installedSkillPath(agent.home)));
  const text = usingSkill ? `${SKILL_COMMAND} ${filled}` : filled;

  return {
    text,
    templatePath: config.promptTemplate,
    templateVersion: path.basename(config.promptTemplate, path.extname(config.promptTemplate)),
    rowIds: pending.map((p) => p.row.id),
    threadRootIds: threads.map((t) => t.rootId),
    charCount: text.length,
    viaSkill: usingSkill,
  };
}

/**
 * How this agent delivers its message — the one section of the prompt that changes
 * with configuration.
 *
 * The MCP form is not merely the file form with different words. It removes the
 * format from the agent's hands entirely, which is the T6 problem solved rather than
 * mitigated. The file form is kept complete and correct because the sweep still
 * accepts it: an agent that never calls the tool, or a run where the server failed
 * to connect, still works. That fallback is what makes the tool safe to depend on.
 */
function buildDeliveryBlock(
  config: Config,
  agent: Agent,
  replyToHint: string,
  replyToIdHint: string
): string {
  if (!config.contract.mcp) return fileDeliveryBlock(agent, replyToHint, replyToIdHint);

  return [
    `**Deliver your message by calling \`${MCP_TOOL_ID}\`.** That call is the only`,
    'thing that reaches the ledger. Nothing you say in this chat is recorded, and',
    'nobody is shown it.',
    '',
    'You supply the fields listed below; the orchestrator writes the file and assigns',
    'the ID, the timestamp and your name. You cannot supply those and should not try.',
    '',
    'Call it once per message. Usually that is one call, at the end. It is more than',
    'one when you are delegating: a call for each agent you are asking, and — only if',
    'you can answer now — a call answering what was asked of you. If a field is wrong',
    'the call comes back with the specific reason and you can correct it and call again',
    'immediately — that costs nothing, so there is no reason to guess.',
    '',
    `If \`${MCP_TOOL_ID}\` is not in your tool list, the connection failed. Fall back to`,
    'writing the file yourself:',
    '',
    fileDeliveryBlock(agent, replyToHint, replyToIdHint),
  ].join('\n');
}

function fileDeliveryBlock(agent: Agent, replyToHint: string, replyToIdHint: string): string {
  return [
    '**The file is the deliverable.** Write one Markdown file per message, into your outbox:',
    '',
    '```',
    agent.outbox,
    '```',
    '',
    'Pick any filename ending in `.md`. The orchestrator sweeps that directory when you',
    'exit, validates what it finds, and appends a ledger row for each. Usually you write',
    'one. You write several when you are delegating — one per agent you are asking. Each',
    'is YAML frontmatter followed by your message:',
    '',
    '```markdown',
    '---',
    `to: ${replyToHint}`,
    'type: response',
    `replyTo: ${replyToIdHint}`,
    'outcome: done',
    'summary: One line saying what this is',
    '---',
    '',
    'Your message goes here.',
    '```',
  ].join('\n');
}

/**
 * D10 — "the batched pending items (ID, Writer, Type, Summary, path to each message
 * file)". The path is included because the body may have been truncated in the
 * thread block above, and an agent that wants the whole thing should be able to
 * open it rather than guess.
 */
function buildPendingBlock(config: Config, agent: Agent, pending: Outstanding[]): string {
  if (!pending.length) {
    return '_Nothing is waiting on you. If that is unexpected, say so in your reply and write no file._';
  }
  const lines: string[] = [];
  for (const p of pending) {
    const r = p.row;
    const why = REASON_INFO[p.reason].onYou;
    // For a delivered answer the heading names the row the agent wrote itself, which
    // reads as nonsense — "from you" — unless it says so. The row that matters here is
    // the answer, and it is listed below.
    lines.push(
      p.reason === 'undelivered-answer'
        ? `### ${r.id} — **your own request** (${r.type})`
        : `### ${r.id} — from **${r.writer}** (${r.type})`
    );
    lines.push('');
    lines.push(`> ${r.summary}`);
    lines.push('');
    lines.push(`- Why it is on you: ${why}`);
    if (r.ref) lines.push(`- Full message: \`${refTo(config.commsRoot, r.ref)}\``);
    if (p.reason === 'unread-information') {
      // Nobody is waiting on work here, so the instruction has to say what "done"
      // is. Without it a cold agent reads an unanswered row addressed to it and
      // does the only thing the rest of this prompt describes: work it like a
      // request.
      // Whether it can keep the fact at all is a permission question, and telling an
      // agent to write a file its own settings deny is how a run ends in a refusal
      // loop rather than a note.
      lines.push(
        agent.homeWritable
          ? '- **No work is being asked of you.** Decide whether this is worth keeping. If it is,'
              + ' write it into your own notes yourself — in your home directory, wherever you keep'
              + ' such things — in your own words, with enough context to be usable cold.'
          : '- **No work is being asked of you**, and you cannot write anywhere except your outbox,'
              + ' so you cannot file this yourself. If it is worth keeping, say so in your'
              + ' acknowledgement and quote the part that matters, so the operator can place it.'
      );
      // A report carries no outcome (M1), so the acknowledgement line is the whole of
      // the answer — and "I already hold this" is as useful to the sender as "kept it",
      // which is why both shapes are named. Without that, a fact the recipient declines
      // to keep is closed by a line that does not say so, and the sender learns nothing.
      lines.push(
        `- Then acknowledge it: one \`report\` with \`replyTo: ${r.id}\`. It carries no`
          + ' `outcome`, so that one line is your whole answer, and it says one of two things:'
          + ' you kept it, and where — or you did not, and why, because "we already hold this"'
          + ' and "this contradicts what we hold" are worth very different follow-ups from'
          + ' whoever sent it. That is what closes it; until then it comes back to you.'
      );
    } else if (p.reason === 'undelivered-answer') {
      // Nobody is waiting on work here either, and the default framing is worse than
      // useless: an agent shown its own request with no explanation reads it as a job
      // to do and does it again. What it is actually being handed is the answer.
      lines.push(
        `- **This is not new work.** You asked for this in an earlier invocation and do not`
          + ' remember doing so. It has been answered. You are being invoked because nothing'
          + ' has been done with the answer yet — that is the only reason this thread is'
          + ' still moving.'
      );
      for (const a of p.answeredBy) {
        const outcome = a.outcome ? OUTCOME_INFO[a.outcome] : null;
        lines.push(
          `- **${a.id}** — ${a.writer} answered \`${a.outcome ?? 'no outcome'}\`: ${a.summary}`
            + (a.ref ? `\n  Full message: \`${refTo(config.commsRoot, a.ref)}\`` : '')
            + (outcome ? `\n  ${outcome.onReceipt}` : '')
        );
      }
      lines.push(
        '- Then write one message into this thread. That is what closes it, and until you'
          + ' write one you will be invoked again with the same answer. If the work it fed is'
          + ' now finished, say so and say what you did — a `report` to whoever should know,'
          + ' or to `operator` if nobody else is waiting. If it opened something new, send'
          + ' that instead. What you must not do is nothing.'
      );
    } else {
      lines.push(`- Answer it with \`replyTo: ${r.id}\``);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * D10a. Every pending row, walked back through ReplyTo to the row that started the
 * thread, rendered root-first with bodies.
 */
async function buildThreadBlock(
  config: Config,
  agent: Agent,
  threads: Thread[]
): Promise<string> {
  if (!threads.length) return '_No thread context._';

  const out: string[] = [];
  for (const t of threads) {
    out.push(`### Thread ${t.rootId}`);
    out.push('');
    if (t.rows.length === 1) {
      out.push('_This thread starts here._');
    } else {
      out.push(
        `_${t.rows.length} messages, oldest first. Rows written by you are marked — you wrote them in an earlier invocation and do not remember doing so._`
      );
    }
    out.push('');

    const readable = mayReadBody(t, agent.name);

    for (const r of t.rows) {
      out.push(renderRowHeader(r, agent.name));
      const body = readable ? await loadBody(config, r) : null;
      if (body === null) {
        // L8 — the index is public; the body is not. Say which it is, so the agent
        // does not read an absent body as an empty one.
        out.push('');
        out.push(readable ? '_(no message file)_' : '_(body not readable by you — L8)_');
      } else {
        out.push('');
        out.push(indent(body));
      }
      out.push('');
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}

function renderRowHeader(r: Row, self: string): string {
  const mine = r.writer === self ? '  ← **you wrote this**' : '';
  const parts = [
    `**${r.id}**`,
    `${r.writer} → ${r.to.join(', ')}`,
    `\`${r.type}\``,
  ];
  if (r.replyTo) parts.push(`replying to ${r.replyTo}`);
  if (r.outcome) parts.push(`outcome: \`${r.outcome}\``);
  if (r.needs.length) parts.push(`needs sign-off from ${r.needs.join(', ')}`);
  return `#### ${parts.join(' · ')}${mine}\n\n> ${r.summary}`;
}

async function loadBody(config: Config, r: Row): Promise<string | null> {
  if (!r.ref) return null;
  const abs = refTo(config.commsRoot, r.ref);
  const text = await readTextIfExists(abs);
  if (text === null) return null;
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  let body = (m?.[1] ?? text).trim();
  if (body.length > MAX_BODY_CHARS) {
    body =
      body.slice(0, MAX_BODY_CHARS) +
      `\n\n_[truncated at ${MAX_BODY_CHARS} characters — the whole message is at ${abs}]_`;
  }
  return body;
}

/**
 * L6's second output — "the recent-decisions digest, built from `decision` rows,
 * injected into every cold agent's prompt."
 *
 * "Decisions made in conversation and recorded nowhere an agent reads are the most
 * common way a multi-agent system quietly diverges from its own history."
 */
function buildDecisionsBlock(config: Config, f: Fold): string {
  if (!f.decisions.length) {
    return '## Decisions already taken\n\n_None recorded yet._';
  }
  const lines = ['## Decisions already taken', ''];
  lines.push(
    '_Settled since these instructions were written. Do not re-open any of them; if one is wrong, say so in your reply rather than acting against it._'
  );
  lines.push('');
  for (const d of f.decisions) {
    const where = d.ref ? ` — \`${refTo(config.commsRoot, d.ref)}\`` : '';
    lines.push(`- **${d.id}** (${d.writer}, ${d.time.slice(0, 10)}) ${d.summary}${where}`);
  }
  return lines.join('\n');
}

function uniqueThreads(f: Fold, pending: Outstanding[]): Thread[] {
  const seen = new Set<string>();
  const out: Thread[] = [];
  for (const p of pending) {
    const t = f.threadOf.get(p.row.id);
    if (!t || seen.has(t.rootId)) continue;
    seen.add(t.rootId);
    out.push(t);
  }
  return out;
}

/**
 * T4 — "If agents need to know who exists, derive a participant list from the
 * index." The roster *file* is never shown: it holds installation-specific absolute
 * paths and the P3 security flag, and neither is any agent's business.
 *
 * A name on its own is not enough to delegate with, though. An agent asked to hand
 * work to someone, shown only "operator · worker · researcher", picks by guessing —
 * and then the chain fails for a reason that looks like the model being stupid
 * rather than the prompt being thin, which is the same trap D10a describes.
 *
 * So the description travels and nothing else does. It is the one roster field that
 * is about what an agent is *for* rather than where it lives or what it may do.
 */
function uniqueParticipants(config: Config, f: Fold, self: Agent): string[] {
  const names = new Set<string>([OPERATOR]);
  for (const n of f.participants) names.add(n);
  for (const a of config.agents) names.add(a.name);
  names.delete(self.name); // D3 — never addressed to yourself.
  return [...names].sort();
}

function buildRosterBlock(config: Config, names: string[], self: Agent): string {
  const lines: string[] = [];
  for (const name of names) {
    if (name === self.name) continue;
    if (name === OPERATOR) {
      lines.push(`- **${OPERATOR}** — the human who started this chain. Address reports and finished work here.`);
      continue;
    }
    const agent = config.agents.find((a) => a.name === name);
    if (!agent) {
      // A participant seen in the index but not in the roster: a renamed or removed
      // agent. Named anyway, because the thread may reference it.
      lines.push(`- **${name}** — appears in this thread's history but is not currently dispatchable.`);
      continue;
    }
    const excluded = agent.dispatchExcluded
      ? ' _(a human works in this directory, so replies are relayed by hand and may be slow)_'
      : '';
    lines.push(`- **${name}** — ${agent.description || 'no description recorded.'}${excluded}`);
  }
  if (!lines.length) return '_You are the only participant besides the operator._';
  return lines.join('\n');
}

function indent(s: string): string {
  return s
    .split('\n')
    .map((l) => (l.trim() ? `    ${l}` : ''))
    .join('\n');
}

/**
 * Every substitution the builder makes, named once.
 *
 * `fill` takes a complete `Record<PromptPlaceholder, string>`, so this list and the
 * object built in `buildPrompt` cannot drift: a name here with nothing supplying it
 * fails the build, and a value supplied under a name not here fails it too. Before
 * that, `unknownPlaceholders` held a second copy of the list by hand, and the copy
 * was what `doctor` checked the template against — so adding a placeholder to both
 * the template and the builder made a correct template report as broken.
 */
export const PROMPT_PLACEHOLDERS = [
  'AGENT_NAME',
  'OUTBOX',
  'COMMS_ROOT',
  'WORKSPACE_BLOCK',
  'PARTICIPANTS',
  'ROSTER_BLOCK',
  'REPLY_TO_HINT',
  'REPLY_TO_ID_HINT',
  'THREAD_BLOCK',
  'PENDING_BLOCK',
  'DECISIONS_BLOCK',
  'HOPS_REMAINING',
  'INVOCATIONS_REMAINING',
  'DELIVERY_BLOCK',
  'DELIVERY_STEP',
] as const;

export type PromptPlaceholder = (typeof PROMPT_PLACEHOLDERS)[number];

function fill(template: string, vars: Record<PromptPlaceholder, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) => {
    const v = (vars as Record<string, string>)[key];
    if (v === undefined) {
      // D8's point: when the template is wrong every agent misbehaves identically.
      // An unfilled placeholder is left visible rather than blanked, so it shows up
      // in the logged prompt (D9) instead of silently becoming an empty section.
      return whole;
    }
    return v;
  });
}

/** Placeholders the template uses that the builder does not supply. Checked by `doctor`. */
export function unknownPlaceholders(template: string): string[] {
  const known = new Set<string>(PROMPT_PLACEHOLDERS);
  const found = new Set<string>();
  for (const m of template.matchAll(/\{\{([A-Z_]+)\}\}/g)) {
    const k = m[1]!;
    if (!known.has(k)) found.add(k);
  }
  return [...found];
}
