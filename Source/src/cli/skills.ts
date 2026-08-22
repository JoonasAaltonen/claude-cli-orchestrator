/**
 * Installing the ledger skills into an agent's directory.
 *
 * The reasoning is the same as protocol.ts and the update path matters more here:
 * `ledger-invocation` is *executed* on every dispatch, in the sense that its text is
 * injected into the prompt, so a stale copy silently changes how every agent behaves.
 * Both files are owned wholesale by this application and replaced, never merged.
 *
 * Why skills rather than more prose in the prompt. Measured on CLI 2.1.237:
 *
 *   - `/name` on the first line of a `--print` prompt resolves, and the skill body
 *     is injected before the model sees anything.
 *   - `$ARGUMENTS` is substituted with the rest of the prompt.
 *   - No `Skill` or `SlashCommand` tool call appears in the event stream for either,
 *     so the expansion happens client-side.
 *
 * That last point is what makes it worth doing. Prose in the prompt asks the model
 * to remember something; a skill that expands before the turn starts is not a
 * request.
 *
 * X3a is the requirement that permits this at all: the skill directory is the
 * writable row of X3's table — "instructions the model reads, not code the harness
 * executes" — and it is safe only because shell is denied. permissions.ts checks the
 * two together. An agent's *own* skills are listed and never touched; the point of
 * that writable row is that agents may keep them.
 */
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import type { Agent } from '../config/load.js';
import { appRoot } from '../config/load.js';
import { readText, readTextIfExists, writeText } from '../util/fsx.js';
import { SKILLS, installedSkillPath } from '../contract/names.js';

export const SKILL_VERSION = 'v1';

/** Marks a skill file as this application's, and carries its version. */
const SKILL_MARKER = 'orchestrator-skill:';

export {
  SKILL_NAME,
  SKILL_COMMAND,
  SKILL_REL,
  NOTE_SKILL_NAME,
  NOTE_SKILL_COMMAND,
  SKILLS,
  skillRel,
  installedSkillPath,
} from '../contract/names.js';

export function skillTemplatePath(name: string): string {
  return path.join(appRoot(), 'templates', 'skills', name, 'SKILL.md');
}

export interface OneSkillStatus {
  name: string;
  installed: boolean;
  version: string | null;
  /** The installed copy differs from the template — an update is available. */
  stale: boolean;
  path: string;
}

export interface SkillStatus {
  skills: OneSkillStatus[];
  /** Skill directories in this agent's home that this application did not write. */
  otherSkills: string[];
  /** True when every skill this application owns is present and current. */
  ok: boolean;
  /** True when none of them is installed — the state a fresh agent is in. */
  none: boolean;
}

export async function skillStatus(agent: Agent): Promise<SkillStatus> {
  const skills: OneSkillStatus[] = [];

  for (const name of SKILLS) {
    const target = installedSkillPath(agent.home, name);
    const installed = await readTextIfExists(target);
    const template = await readText(skillTemplatePath(name));
    skills.push({
      name,
      installed: installed !== null,
      version: installed ? (new RegExp(`${SKILL_MARKER}(v\\d+)`).exec(installed)?.[1] ?? null) : null,
      stale: installed !== null && installed.trim() !== template.trim(),
      path: target,
    });
  }

  let otherSkills: string[] = [];
  try {
    const entries = await readdir(path.join(agent.home, '.claude', 'skills'), { withFileTypes: true });
    otherSkills = entries
      .filter((e) => e.isDirectory() && !(SKILLS as readonly string[]).includes(e.name))
      .map((e) => e.name);
  } catch {
    otherSkills = [];
  }

  return {
    skills,
    otherSkills,
    ok: skills.every((s) => s.installed && !s.stale),
    none: skills.every((s) => !s.installed),
  };
}

/** The dispatch skill specifically — what `prompt.ts` and `doctor` ask about most. */
export function dispatchSkill(status: SkillStatus): OneSkillStatus {
  return status.skills[0]!;
}

export interface SkillInstallResult {
  name: string;
  wrote: boolean;
  updated: boolean;
  path: string;
}

/**
 * Idempotent. Re-running after pulling a new version of this repository is the
 * intended way to update, which is why an installed copy is compared and replaced
 * rather than left alone when present.
 */
export async function installSkills(agent: Agent): Promise<SkillInstallResult[]> {
  const results: SkillInstallResult[] = [];

  for (const name of SKILLS) {
    const template = await readText(skillTemplatePath(name));
    const target = installedSkillPath(agent.home, name);
    const existing = await readTextIfExists(target);

    if (existing === null) {
      await writeText(target, template);
      results.push({ name, wrote: true, updated: false, path: target });
    } else if (existing.trim() !== template.trim()) {
      await writeText(target, template);
      results.push({ name, wrote: true, updated: true, path: target });
    } else {
      results.push({ name, wrote: false, updated: false, path: target });
    }
  }

  return results;
}
