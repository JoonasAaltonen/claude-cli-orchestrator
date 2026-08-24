/**
 * Roster management — `orchestrator agent add | list | remove | protocol`.
 *
 * The application ships no agents. It is a channel between directories that already
 * exist and belong to the operator; scaffolding an example roster would make it look
 * like the agents are part of the tool, and P1's "adding an agent is a config entry
 * plus a directory" reads the other way round — the directory comes first.
 *
 * So `add` registers a directory rather than creating one. The only things it writes
 * into an agent's home are the two it owns: the outbox it will sweep (L5) and the
 * generated permission settings (X6). It never touches that agent's CLAUDE.md —
 * that file is the agent, and it belongs to whoever wrote it.
 */
import path from 'node:path';
import process from 'node:process';
import type { Config } from '../config/load.js';
import { writeAgentSettings } from '../dispatch/invoke.js';
import { buildPermissionPlan } from '../dispatch/permissions.js';
import { canonical } from '../util/paths.js';
import { addAgent, removeAgent, RosterError, GRANT_CATALOGUE, GRANT_FIELDS } from '../roster/edit.js';
import type { GrantField } from '../roster/edit.js';
import { ensureDir } from '../util/fsx.js';
import { bold, dim, green, red, yellow, heading } from './render.js';

import { installProtocol, protocolStatus, readTemplate, PROTOCOL_REL, PROTOCOL_VERSION } from './protocol.js';
import { installSkills, skillStatus, skillRel, SKILL_COMMAND, NOTE_SKILL_COMMAND } from './skills.js';

export interface AddOptions {
  name: string;
  home: string;
  description?: string;
  model?: string;
  /** The boolean grants, whatever GRANT_CATALOGUE currently describes. */
  grants?: Partial<Record<GrantField, boolean>>;
  readPaths?: string[];
  writePaths?: string[];
  tools?: string[];
  /** Append the protocol block to the agent's CLAUDE.md rather than only reporting. */
  writeProtocol?: boolean;
}

export async function runAgentAdd(config: Config, opts: AddOptions): Promise<number> {
  const home = canonical(opts.home);

  console.log(heading(`Registering ${opts.name}`));
  console.log(`  home   ${bold(home)}`);

  // Every rule that decides whether this is allowed lives in roster/edit.ts, which
  // the dashboard calls too. A second copy here is how a nesting rule ends up
  // enforced on one front-end and not the other — and a nesting rule that does not
  // hold is a write boundary that silently does not exist (X4).
  let change;
  try {
    change = await addAgent(config, {
      name: opts.name,
      home,
      description: opts.description ?? '',
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.grants ?? {}),
      paths: [
        ...(opts.readPaths ?? []).map((p) => ({ path: p, read: true, write: false })),
        ...(opts.writePaths ?? []).map((p) => ({ path: p, read: true, write: true })),
      ],
      ...(opts.tools ? { tools: opts.tools } : {}),
    });
  } catch (err) {
    if (err instanceof RosterError) {
      console.error(red(err.message));
      for (const d of err.details) console.error(red('  ' + d));
      return 2;
    }
    throw err;
  }

  for (const w of change.warnings) console.log(`  ${yellow('warning')} ${w}`);

  const updated = change.config;
  const agent = change.agent;

  // The only two things this tool writes into an agent's home, both of which it owns.
  await ensureDir(agent.outbox);
  const settingsFile = await writeAgentSettings(updated, agent);
  const plan = buildPermissionPlan(updated, agent);

  console.log(`  ${green('added')} to ${config.configFile}`);
  console.log(dim(`  created ${path.relative(home, agent.outbox)}/  (L5 — swept after every invocation)`));
  console.log(dim(`  wrote   ${path.relative(home, settingsFile)}  (${plan.settings.permissions.deny.length} deny rules, regenerated before every dispatch)`));

  // The protocol: a file this application owns, plus one line in CLAUDE.md pointing
  // at it. See protocol.ts for why it is not appended or imported.
  const status = await protocolStatus(agent, config);
  if (status.ok) {
    console.log(`  ${green('ok')} protocol already installed (${status.fileVersion ?? 'unversioned'})`);
  } else if (opts.writeProtocol) {
    const r = await installProtocol(agent, config);
    if (r.wroteFile) console.log(`  ${green('wrote')}   ${PROTOCOL_REL.replace(/\\/g, '/')}`);
    if (r.wrotePointer) console.log(`  ${green('added')}   a one-line pointer to CLAUDE.md`);
    for (const note of r.notes) console.log(dim(`  ${note}`));
  } else {
    console.log(`\n  ${yellow('This agent does not yet know it can be invoked by a tool.')}`);
    console.log(dim('  It will still be dispatched and will probably cope — the format rules are in'));
    console.log(dim('  the per-invocation prompt — but it has no standing instructions about them.'));
    console.log(`\n  ${bold(`orchestrator agent protocol ${opts.name} --install`)}`);
    console.log(dim(`  Writes ${PROTOCOL_REL.replace(/\\/g, '/')} and adds one line to CLAUDE.md.`));
  }

  // The skill is a file this application owns, in the writable row of X3's table
  // (X3a). It installs on the same flag as the protocol, because both are the
  // agent-side half of the contract, and splitting them across two commands to run
  // in sequence is how one of them ends up not run.
  const skill = await skillStatus(agent);
  if (skill.ok) {
    console.log(`  ${green('ok')} ledger skills already installed`);
  } else if (opts.writeProtocol) {
    for (const r of await installSkills(agent)) {
      const what = r.wrote ? (r.updated ? 'updated' : 'wrote  ') : 'current';
      console.log(`  ${green(what)} ${skillRel(r.name).replace(/\\/g, '/')}`);
    }
    console.log(dim(`  ${SKILL_COMMAND} — how dispatch hands this agent a job.`));
    console.log(dim(`  ${NOTE_SKILL_COMMAND} — how it leaves a message for another agent from an ordinary session.`));
  } else {
    console.log(dim('  The ledger skills are not installed either. The same flag writes them.'));
  }

  console.log(`\n  ${dim('next:')} ${bold('orchestrator doctor --fix-hooks-audit')} ${dim('— audits this directory for permission-granting hooks (P3/X7)')}`);
  return 0;
}

/**
 * Installs or reports the ledger skill.
 *
 * Separate from `agent protocol` because the two have different update cadences: the
 * protocol changes when the human-facing rules do, the skill changes whenever
 * dispatch does. An agent's own skills are listed and never touched — the whole
 * point of X3a's writable row is that agents may keep their own.
 */
export async function runAgentSkills(
  config: Config,
  name: string | undefined,
  opts: { install: boolean; all: boolean }
): Promise<number> {
  const targets = opts.all
    ? config.agents
    : config.agents.filter((a) => a.name.toLowerCase() === (name ?? '').toLowerCase());

  if (!targets.length) {
    console.error(red(name ? `"${name}" is not in the roster.` : 'Name an agent, or pass --all.'));
    return 2;
  }

  if (!opts.install) {
    for (const agent of targets) {
      const s = await skillStatus(agent);
      console.log(bold(agent.name));
      for (const one of s.skills) {
        const state = !one.installed
          ? red('not installed')
          : one.stale
            ? yellow('out of date')
            : green(one.version ?? 'installed');
        console.log(`  ${state}  ${dim(skillRel(one.name).replace(/\\/g, '/'))}`);
      }
      if (s.otherSkills.length) {
        console.log(dim(`  this agent's own skills, untouched: ${s.otherSkills.join(', ')}`));
      }
    }
    console.log(dim('\nRun with --install to write them.'));
    return 0;
  }

  for (const agent of targets) {
    const results = await installSkills(agent);
    const changed = results.filter((r) => r.wrote);
    console.log(
      `${green('ok')}  ${bold(agent.name)} ${dim(
        changed.length ? changed.map((r) => `${r.name} ${r.updated ? 'updated' : 'written'}`).join(', ') : 'already current'
      )}`
    );
  }
  return 0;
}

export async function runAgentList(config: Config): Promise<number> {
  console.log(heading(`Roster — ${config.agents.length} agent(s)`));
  if (!config.agents.length) {
    console.log(dim('  Empty. This tool ships no agents; register your own:'));
    console.log(`  ${bold('orchestrator agent add <name> --home <directory>')}`);
    return 0;
  }
  for (const a of config.agents) {
    // Whatever is not at its default, in the catalogue's own words — the same set
    // the dashboard chips, from the same place.
    const flags: string[] = GRANT_FIELDS.filter((f) => a[f] !== GRANT_CATALOGUE[f].fallback).map((f) => {
      const chip = GRANT_CATALOGUE[f].chip;
      return chip.tone === 'bad' ? red(chip.label) : chip.tone === 'warn' ? yellow(chip.label) : chip.label;
    });
    if (a.hasPermissionHooks === null) flags.push(yellow('hooks unaudited'));
    else if (a.hasPermissionHooks) flags.push(yellow('has hooks'));

    console.log(`  ${bold(a.name)} ${flags.join(' ')}`);
    console.log(dim(`     ${a.home}`));
    if (a.description) console.log(dim(`     ${a.description}`));

    const status = await protocolStatus(a, config);
    if (!status.claudeMdPresent) console.log(`     ${red('no CLAUDE.md')} ${dim('(X5)')}`);
    else if (status.legacyInline) {
      console.log(`     ${yellow('protocol is pasted into CLAUDE.md')} ${dim(`— orchestrator agent protocol ${a.name} --install  moves it to a file`)}`);
    } else if (!status.ok) {
      // Which half is wrong, rather than one label for four different states. "not
      // installed" was printed for an agent whose protocol file was present and
      // current and whose CLAUDE.md had simply been rewritten by hand — the operator
      // reads that as "the install failed" and reinstalls over their own text.
      const why = !status.fileInstalled
        ? 'protocol file missing'
        : status.fileStale
          ? `protocol file is out of date (${status.fileVersion ?? 'unversioned'} on disk)`
          : !status.pointerPresent
            ? 'nothing in CLAUDE.md points at the protocol file'
            : `CLAUDE.md pointer is ${status.pointerVersion ?? 'unversioned'}, current is ${PROTOCOL_VERSION}`;
      console.log(`     ${yellow(why)} ${dim(`— orchestrator agent protocol ${a.name} --install`)}`);
    } else {
      console.log(dim(`     protocol ${status.fileVersion ?? 'installed'}`));
    }
    for (const p of a.paths) {
      const how = p.write ? 'read+write' : 'read only';
      console.log(dim(`     ${how}: ${p.path}`));
    }
    if (a.model) console.log(dim(`     model: ${a.model}`));
  }
  return 0;
}

export async function runAgentRemove(config: Config, name: string): Promise<number> {
  const agent = config.agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!agent) {
    console.error(red(`"${name}" is not in the roster.`));
    return 2;
  }
  await removeAgent(config, name);
  console.log(`${green('removed')} ${agent.name} from ${config.configFile}`);
  console.log(dim(`  ${agent.home} was not touched. Its outbox and generated settings file are still there.`));
  console.log(dim('  Ledger rows it already wrote stay in the index — nothing is ever edited (L1).'));
  return 0;
}

export async function runAgentProtocol(
  config: Config,
  name: string | undefined,
  opts: { install: boolean; all: boolean; force?: boolean }
): Promise<number> {
  if (opts.force && !opts.install) {
    console.error(red('--force only means anything with --install.'));
    return 2;
  }

  // No target: print it. The portable path — paste it anywhere, including into an
  // agent this installation does not manage.
  if (!name && !opts.all) {
    process.stdout.write(await readTemplate());
    return 0;
  }

  const targets = opts.all
    ? config.agents
    : config.agents.filter((a) => a.name.toLowerCase() === (name ?? '').toLowerCase());

  if (!targets.length) {
    console.error(red(`"${name}" is not in the roster.`));
    return 2;
  }

  if (!opts.install) {
    // A named agent without --install: show where it stands rather than guessing.
    for (const agent of targets) {
      const s = await protocolStatus(agent, config);
      console.log(`${bold(agent.name)} ${dim(agent.home)}`);
      console.log(`  file    ${s.fileInstalled ? green(s.fileVersion ?? 'installed') : red('not installed')} ${dim(PROTOCOL_REL.replace(/\\/g, '/'))}`);
      // The version, not just the presence of a marker. This line used to print a
      // green "present in CLAUDE.md" for a v4 pointer under a v5 installation, which
      // reads as nothing to do — and then offered a fix that declined to act.
      console.log(
        `  pointer ${
          !s.claudeMdPresent
            ? red('no CLAUDE.md')
            : !s.pointerPresent
              ? red('missing')
              : s.pointerStale
                ? yellow(`${s.pointerVersion ?? 'unversioned'}, current is ${PROTOCOL_VERSION}`)
                : green(`${s.pointerVersion ?? 'present'} in CLAUDE.md`)
        }`
      );
      if (s.legacyInline) console.log(`  ${yellow('the protocol text is pasted into CLAUDE.md; --install moves it to the file')}`);
      if (s.pointerEdited) {
        console.log(`  ${yellow('that pointer has been edited since it was written, so --install will not touch it')}`);
        console.log(dim(`  fix: orchestrator agent protocol ${agent.name} --install --force`));
      } else if (!s.ok) {
        console.log(dim(`  fix: orchestrator agent protocol ${agent.name} --install`));
      }
    }
    console.log(dim('\nRun with --install to write it, or with no agent name to print the text.'));
    return 0;
  }

  // §11 step 5 in practice: pull a new version of this repository, run this, and
  // every registered agent gets the new protocol. The file is replaced wholesale
  // because this application owns it; CLAUDE.md only ever gains one line.
  let failures = 0;
  for (const agent of targets) {
    const r = await installProtocol(agent, config, { force: opts.force });
    const bits: string[] = [];
    if (r.wroteFile) bits.push(r.fileWasUpdated ? 'file updated' : 'file written');
    if (r.wrotePointer) bits.push(r.forced ? 'pointer appended to CLAUDE.md' : 'pointer added to CLAUDE.md');
    if (r.removedLegacy) bits.push('inline copy removed');
    console.log(`${r.claudeMdMissing ? yellow('partial') : green('ok')}  ${bold(agent.name)} ${dim(bits.join(', ') || 'already current')}`);
    for (const note of r.notes) console.log(dim(`     ${note}`));
    if (r.claudeMdMissing) failures++;
  }
  return failures ? 1 : 0;
}
