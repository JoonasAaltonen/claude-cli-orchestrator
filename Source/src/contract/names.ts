/**
 * The names and paths the message contract is addressed by.
 *
 * Both mechanisms in `config.contract` are identified by a string that has to match
 * in three unrelated places at once — the permission rules, the prompt text the model
 * reads, and the file installed in the agent's directory. A mismatch between any two
 * of them fails silently: the tool is simply never called, or the slash command
 * arrives as prose, and the run looks like an agent that chose not to cooperate.
 * There is one definition so that cannot happen.
 */

import path from 'node:path';

export const MCP_SERVER_NAME = 'orchestrator';
export const MCP_TOOL_NAME = 'submit_message';

/**
 * How Claude Code addresses a tool from an MCP server: `mcp__<server>__<tool>`.
 * Permission rules, the prompt and the skill body all use this exact spelling.
 */
export const MCP_TOOL_ID = `mcp__${MCP_SERVER_NAME}__${MCP_TOOL_NAME}`;

/**
 * The skill the dispatcher enters. One, not one per hop — a separate `ledger-respond`
 * was considered and dropped, because the only thing that would differ is which
 * message `type` to choose and the prompt already names the row being answered.
 */
export const SKILL_NAME = 'ledger-invocation';

/** The slash command that enters it, which is the first token of the prompt. */
export const SKILL_COMMAND = `/${SKILL_NAME}`;

/**
 * The skill an agent enters *itself*, from a session a human started.
 *
 * This is a different situation from `ledger-invocation` and not a variant of it. There
 * the orchestrator is driving, the agent is cold, and the whole prompt is the job.
 * Here a person is in the room, the agent is mid-conversation, and it has noticed
 * something that belongs to someone else — so the framing, the permission assumptions
 * and the delivery mechanism all differ:
 *
 *   - `mcp__orchestrator__submit_message` is **not** available. It reaches the agent
 *     through `--mcp-config` at dispatch time, and an interactive session does not get
 *     that flag. So this skill writes the file directly.
 *   - The agent has its ordinary interactive permissions, not the dispatch plan's.
 *   - There is a human present who can be asked, and who has not agreed to whatever
 *     work this would queue.
 *
 * Collapsing the two into one file would mean a body that hedges on all three, which
 * is how a skill stops being reliable.
 */
export const NOTE_SKILL_NAME = 'ledger-note';

export const NOTE_SKILL_COMMAND = `/${NOTE_SKILL_NAME}`;

/**
 * Every skill this application installs. Adding one here is the only change needed:
 * install, status, `doctor` and the update path all iterate this.
 */
export const SKILLS = [SKILL_NAME, NOTE_SKILL_NAME] as const;

export type SkillName = (typeof SKILLS)[number];

/**
 * Where a skill is installed, relative to the agent's home.
 *
 * X3a is what permits writing here at all: the skill directory is the writable row
 * of X3's table — "instructions the model reads, not code the harness executes" —
 * and it is safe only because shell is denied.
 */
export function skillRel(name: string): string {
  return path.join('.claude', 'skills', name, 'SKILL.md');
}

/** Kept for the dispatch skill specifically, which several call sites name directly. */
export const SKILL_REL = skillRel(SKILL_NAME);

export function installedSkillPath(agentHome: string, name: string = SKILL_NAME): string {
  return path.join(agentHome, skillRel(name));
}
