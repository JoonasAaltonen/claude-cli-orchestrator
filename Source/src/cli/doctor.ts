/**
 * `orchestrator doctor` — the checks that are cheap now and painful later.
 *
 * Two requirements make this more than a convenience:
 *
 * F3 — "Flag spellings are verified against the installed CLI before they enter
 * code, never taken from documentation or from a model's recollection. Flag names
 * are the least stable part of any of this." So doctor parses `claude --help` and
 * compares it against the flags invoke.ts actually builds.
 *
 * P3/X7 — "An agent directory may already contain a permission-granting hook
 * installed for unrelated reasons... Audit the target directory before dispatching
 * to it; that is what P3 records." So doctor inspects each agent's settings files
 * for hooks, and can write the result back into the roster.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import type { Config, Agent } from '../config/load.js';
import { buildArgv, FORBIDDEN_FLAGS } from '../dispatch/invoke.js';
import { checkAuth, describeAuth } from '../guards/auth.js';
import { checkClaudeBin, shimAdvice } from '../util/which.js';
import { buildPermissionPlan } from '../dispatch/permissions.js';
import { unknownPlaceholders } from '../dispatch/prompt.js';
import { layout, readIndex } from '../ledger/store.js';
import { statusRowCount } from '../ledger/status-file.js';
import { exists, readTextIfExists, writeText, listFiles } from '../util/fsx.js';
import { longPathWarning, canonical } from '../util/paths.js';
import { nowIso } from '../util/time.js';
import { dim, green, red, yellow, heading } from './render.js';
import { skillStatus, dispatchSkill } from './skills.js';
import { serverCommand } from '../mcp/config.js';
import { MCP_TOOL_ID, SKILL_COMMAND } from '../contract/names.js';

type Level = 'ok' | 'warn' | 'fail';
interface Finding {
  level: Level;
  what: string;
  detail?: string;
}

export async function runDoctor(config: Config, opts: { fixHooksAudit: boolean }): Promise<number> {
  const findings: Finding[] = [];

  console.log(heading('Paths'));
  await checkPaths(config, findings);

  console.log(heading('Installed CLI (F3)'));
  const help = await checkCli(config, findings);

  console.log(heading('Flags this application builds (F3)'));
  await checkFlags(config, help, findings);

  console.log(heading('Prompt template (D8)'));
  await checkTemplate(config, findings);

  console.log(heading('Roster'));
  await checkRoster(config, findings, opts.fixHooksAudit);

  console.log(heading('Guards'));
  await checkGuards(config, findings);

  console.log(heading('Network posture (§7b)'));
  await checkContract(config, findings);
  await checkNetwork(config, findings);

  const fails = findings.filter((f) => f.level === 'fail').length;
  const warns = findings.filter((f) => f.level === 'warn').length;

  console.log(heading('Summary'));
  console.log(`  ${fails ? red(`${fails} failing`) : green('0 failing')}, ${warns ? yellow(`${warns} warning(s)`) : '0 warnings'}, ${findings.filter((f) => f.level === 'ok').length} ok`);
  if (fails) console.log(dim('  Fix the failures before dispatching. A failing check is a dispatch that costs money and returns nothing.'));

  return fails ? 1 : 0;
}

function report(findings: Finding[], f: Finding): void {
  findings.push(f);
  const tag = f.level === 'ok' ? green('ok  ') : f.level === 'warn' ? yellow('warn') : red('FAIL');
  console.log(`  ${tag}  ${f.what}`);
  if (f.detail) console.log(dim(`        ${f.detail.replace(/\n/g, '\n        ')}`));
}

async function checkPaths(config: Config, findings: Finding[]): Promise<void> {
  const l = layout(config);

  report(findings, {
    level: (await exists(l.root)) ? 'ok' : 'fail',
    what: `comms root exists — ${l.root}`,
    detail: (await exists(l.root)) ? undefined : 'Run `orchestrator init`.',
  });

  report(findings, {
    level: (await exists(l.index)) ? 'ok' : 'warn',
    what: `index — ${l.index}`,
    detail: (await exists(l.index)) ? undefined : 'No index yet. It is created on the first write.',
  });

  // The rendered view agents read. It is written from `appendRow`, so it falling
  // behind means something wrote the index by another route — which should be
  // impossible under L2, and is worth knowing about if it happens.
  const statusText = await readTextIfExists(l.statusFile);
  if (statusText === null) {
    report(findings, {
      level: (await exists(l.index)) ? 'warn' : 'ok',
      what: `status.md — ${l.statusFile}`,
      detail: (await exists(l.index))
        ? 'Missing. Agents cannot run the CLI (X1), so this file is how they see the fold. Fix: orchestrator status'
        : 'Not written yet. It appears with the first row.',
    });
  } else {
    const { rows } = await readIndex(config);
    const claimed = statusRowCount(statusText);
    const behind = claimed !== null && claimed !== rows.length;
    report(findings, {
      level: behind ? 'warn' : 'ok',
      what: behind
        ? `status.md is behind the index — it describes ${claimed} row(s), the index has ${rows.length}`
        : `status.md is current (${rows.length} row(s))`,
      detail: behind
        ? 'An agent reading it would be reasoning over a stale picture. Fix: orchestrator status'
        : undefined,
    });
  }

  // T5, fourth consequence — path length. Message files nest.
  const lp = longPathWarning(l.messages, 80);
  report(findings, {
    level: lp ? 'warn' : 'ok',
    what: 'path length is within the Windows default limit (T5)',
    detail: lp ?? undefined,
  });

  for (const a of config.agents) {
    const homeOk = await exists(a.home);
    report(findings, {
      level: homeOk ? 'ok' : 'fail',
      what: `${a.name} home — ${a.home}`,
      detail: homeOk ? undefined : 'The directory does not exist. D2 invokes the CLI with this as its working directory.',
    });

    // X5 — "Each agent *is* its instruction file; a run without it is a generic
    // assistant wearing the agent's name."
    const claudeMd = path.join(a.home, 'CLAUDE.md');
    const hasMd = await exists(claudeMd);
    report(findings, {
      level: hasMd ? 'ok' : 'fail',
      what: `${a.name} CLAUDE.md (X5)`,
      detail: hasMd ? undefined : `Missing at ${claudeMd}. Without it this agent is a generic assistant wearing its name.`,
    });

    const outboxOk = await exists(a.outbox);
    report(findings, {
      level: outboxOk ? 'ok' : 'warn',
      what: `${a.name} outbox (L5) — ${a.outbox}`,
      detail: outboxOk ? undefined : 'Created on first sweep, but the agent is told to write here, so it should exist first.',
    });
  }
}

async function checkCli(config: Config, findings: Finding[]): Promise<string> {
  // Which file spawn would actually start, checked before trying to start it. A
  // batch shim fails with an error naming nothing, and the generic advice below —
  // "set claudeBin to the full path" — points straight at the file that is the
  // problem. F3 says the environment is verified rather than assumed; this is the
  // cheapest verification there is, and it happens before anything is spent.
  const binary = await checkClaudeBin(config.claudeBin);
  if (binary.kind === 'script-shim') {
    report(findings, {
      level: 'fail',
      what: "`" + config.claudeBin + "` resolves to a script shim, which cannot be dispatched",
      detail: shimAdvice(binary),
    });
    return '';
  }
  if (binary.resolved) {
    report(findings, { level: 'ok', what: 'resolves to ' + binary.resolved });
  }

  const version = await run(config.claudeBin, ['--version']);
  if (version.error) {
    report(findings, {
      level: 'fail',
      what: `\`${config.claudeBin}\` is not runnable`,
      detail: `${version.error}\nSet \`claudeBin\` in the config to the full path of the executable.`,
    });
    return '';
  }
  report(findings, { level: 'ok', what: `\`${config.claudeBin}\` — ${version.stdout.trim()}` });

  // Installed is not the same as usable. This is the check that turns "every run
  // produced nothing" into "you are logged out".
  const auth = await checkAuth(config);
  report(findings, {
    level: auth.checked && !auth.loggedIn ? 'fail' : auth.error ? 'warn' : 'ok',
    what: `authentication — ${describeAuth(auth)}`,
    detail: auth.advice.length ? auth.advice.join('\n') : undefined,
  });

  const help = await run(config.claudeBin, ['--help']);
  if (help.error) {
    report(findings, { level: 'warn', what: 'could not read `--help`, so flags are unverified (F3)', detail: help.error });
    return '';
  }
  return help.stdout;
}

async function checkFlags(config: Config, help: string, findings: Finding[]): Promise<void> {
  if (!help) return;
  const agent = config.agents[0];
  if (!agent) {
    report(findings, { level: 'warn', what: 'no agents in the roster, so no argv to verify' });
    return;
  }

  const plan = buildPermissionPlan(config, agent);
  let argv: string[];
  try {
    argv = buildArgv(config, agent, plan);
  } catch (err: any) {
    report(findings, { level: 'fail', what: 'argv could not be built', detail: err?.message ?? String(err) });
    return;
  }

  const flags = argv.filter((a) => a.startsWith('--'));
  const missing: string[] = [];
  for (const flag of flags) {
    // The help text lists flags with their aliases; a plain substring test is
    // enough to tell "this spelling exists" from "this spelling does not".
    if (!help.includes(flag)) missing.push(flag);
  }

  report(findings, {
    level: missing.length ? 'fail' : 'ok',
    what: `all ${flags.length} flag spellings appear in the installed CLI's help (F3)`,
    detail: missing.length
      ? `Not found: ${missing.join(', ')}\nF3: flag names are the least stable part of any of this. Fix them before dispatching.`
      : flags.join(' '),
  });

  // X5/F2 — the mode that strips instruction files must never be used.
  const forbidden = argv.filter((a) => (FORBIDDEN_FLAGS as readonly string[]).includes(a));
  report(findings, {
    level: forbidden.length ? 'fail' : 'ok',
    what: 'no context-stripping flag is used (X5/F2)',
    detail: forbidden.length
      ? `Found ${forbidden.join(', ')}`
      : `Never passed: ${FORBIDDEN_FLAGS.join(', ')} — each strips CLAUDE.md, and F2 warns one is the announced future default for scripted calls.`,
  });

  // --permission-mode is an enumeration, and the name does not prove the meaning.
  const modeLine = /--permission-mode[\s\S]{0,300}/.exec(help)?.[0] ?? '';
  const modeOk = modeLine.includes(config.defaults.permissionMode);
  report(findings, {
    level: modeOk ? 'ok' : 'fail',
    what: `--permission-mode ${config.defaults.permissionMode} is an accepted value`,
    detail: modeOk
      ? 'Its behaviour is verified empirically by `orchestrator probe`, not inferred from its name.'
      : `The installed CLI does not list "${config.defaults.permissionMode}".`,
  });
}

async function checkTemplate(config: Config, findings: Finding[]): Promise<void> {
  const text = await readTextIfExists(config.promptTemplate);
  if (text === null) {
    report(findings, {
      level: 'fail',
      what: `prompt template — ${config.promptTemplate}`,
      detail: 'D8: the prompt template is a versioned file. Without it nothing can be dispatched.',
    });
    return;
  }
  report(findings, { level: 'ok', what: `prompt template — ${config.promptTemplate} (${text.length} chars)` });

  const unknown = unknownPlaceholders(text);
  report(findings, {
    level: unknown.length ? 'fail' : 'ok',
    what: 'every placeholder in the template is one the builder supplies (D8)',
    detail: unknown.length
      ? `Unfilled: ${unknown.join(', ')}. These would be sent to the agent literally.`
      : undefined,
  });

  // D10a — the requirement §13b calls the one most likely to be discovered late.
  const hasThread = text.includes('{{THREAD_BLOCK}}');
  report(findings, {
    level: hasThread ? 'ok' : 'fail',
    what: 'the template carries the full thread, not just the triggering row (D10a)',
    detail: hasThread
      ? undefined
      : 'Without {{THREAD_BLOCK}} a single-hop test passes and every longer chain fails in a way that looks like the agent being stupid rather than the prompt being short.',
  });

  const hasDecisions = text.includes('{{DECISIONS_BLOCK}}');
  report(findings, {
    level: hasDecisions ? 'ok' : 'warn',
    what: 'the template carries the recent-decisions digest (L6)',
  });
}

async function checkRoster(config: Config, findings: Finding[], fix: boolean): Promise<void> {
  if (!config.agents.length) {
    report(findings, { level: 'warn', what: 'the roster is empty' });
    return;
  }

  let changed = false;
  const audited: Record<string, boolean> = {};

  for (const a of config.agents) {
    // X7 — audit the target directory before dispatching to it.
    const audit = await auditHooks(a);
    audited[a.name] = audit.found;

    if (audit.found) {
      report(findings, {
        level: 'warn',
        what: `${a.name}: permission-granting hooks present (P3/X7)`,
        detail:
          `${audit.detail}\nThe orchestrator's permission model is only as strong as the hooks in the target directory. ` +
          `A hook that returns an allow decision overrides the deny rules this application writes.`,
      });
    } else {
      report(findings, { level: 'ok', what: `${a.name}: no permission-granting hooks found (P3)` });
    }

    if (a.hasPermissionHooks !== audit.found) changed = true;

    // X1/X3a — the two requirements that hold each other up.
    if (a.shellAllowed) {
      report(findings, {
        level: 'warn',
        what: `${a.name}: shell is allowed (X2)`,
        detail: 'Its file boundaries are advisory. X3a: skill-write is denied for this agent as a consequence — the two requirements are not relaxed independently.',
      });
    } else {
      report(findings, { level: 'ok', what: `${a.name}: shell denied, not omitted (X1)` });
    }

    if (a.dispatchExcluded) {
      report(findings, { level: 'ok', what: `${a.name}: dispatch-excluded, rows queue for manual relay (P2/J3)` });
    }

    // P4 — restated as a check, because the config could be hand-edited later.
    if (canonical(a.home) === config.repoRoot) {
      report(findings, { level: 'fail', what: `${a.name} is the orchestrator's own directory (P4)` });
    }

    // The contract. Neither of these fails loudly at dispatch time, which is the
    // whole reason they are checked here: a missing skill degrades to a plain
    // prompt, and a missing MCP config degrades to a tool the model never sees.
    // Both leave a run that looks like an agent that chose not to cooperate.
    const s = await skillStatus(a);
    const fix = `Fix: orchestrator agent skills ${a.name} --install`;

    // The dispatch skill only matters when dispatch is set up to use it. The note
    // skill matters regardless — it is how this agent reaches the ledger from a
    // session a human started, and nothing else provides that.
    const dispatchOne = dispatchSkill(s);
    if (config.contract.skill) {
      if (!dispatchOne.installed) {
        report(findings, {
          level: 'warn',
          what: `${a.name}: ${dispatchOne.name} is not installed`,
          detail: `Dispatch would send the prompt plain rather than through ${SKILL_COMMAND}. ${fix}`,
        });
      } else if (dispatchOne.stale) {
        report(findings, {
          level: 'warn',
          what: `${a.name}: the installed ${dispatchOne.name} differs from the shipped one`,
          detail: fix,
        });
      } else {
        report(findings, {
          level: 'ok',
          what: `${a.name}: ${dispatchOne.name} installed (${dispatchOne.version ?? 'unversioned'})`,
        });
      }
    }

    for (const one of s.skills.slice(1)) {
      if (!one.installed) {
        report(findings, {
          level: 'warn',
          what: `${a.name}: ${one.name} is not installed`,
          detail: `Without it this agent has no way to leave a message in the ledger from an ordinary interactive session. ${fix}`,
        });
      } else if (one.stale) {
        report(findings, {
          level: 'warn',
          what: `${a.name}: the installed ${one.name} differs from the shipped one`,
          detail: fix,
        });
      } else {
        report(findings, {
          level: 'ok',
          what: `${a.name}: ${one.name} installed (${one.version ?? 'unversioned'})`,
        });
      }
    }

    if (s.otherSkills.length) {
      report(findings, {
        level: 'ok',
        what: `${a.name}: ${s.otherSkills.length} of its own skill(s), untouched`,
        detail: `${s.otherSkills.join(', ')} — X3a's writable row is there so agents may keep their own.`,
      });
    }
  }

  if (changed) {
    if (fix) {
      const text = await readTextIfExists(config.configFile);
      if (text) {
        const raw = JSON.parse(text);
        for (const entry of raw.agents ?? []) {
          if (entry?.name in audited) {
            entry.hasPermissionHooks = audited[entry.name];
            entry.hooksAuditedAt = nowIso();
          }
        }
        await writeText(config.configFile, JSON.stringify(raw, null, 2) + '\n');
        console.log(dim(`        recorded the audit result into ${config.configFile} (P3)`));
      }
    } else {
      report(findings, {
        level: 'warn',
        what: 'the roster\'s recorded hook audit disagrees with what is on disk (P3)',
        detail: 'Run `orchestrator doctor --fix-hooks-audit` to record the current result.',
      });
    }
  }
}

/**
 * X7 — "Convenience hooks that auto-approve commands matching a filter — or any
 * command carrying a magic prefix — are common, and they are holes under
 * orchestration: an agent launched with a restrictive permission mode can
 * self-approve by typing the prefix."
 *
 * This looks for hooks at all, not for malicious ones. P3 records "does this
 * directory run permission-granting hooks", and any PreToolUse hook can return a
 * permission decision, so presence is the finding.
 */
async function auditHooks(agent: Agent): Promise<{ found: boolean; detail: string }> {
  const notes: string[] = [];
  const candidates = [
    path.join(agent.home, '.claude', 'settings.json'),
    path.join(agent.home, '.claude', 'settings.local.json'),
  ];

  for (const file of candidates) {
    const text = await readTextIfExists(file);
    if (text === null) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      notes.push(`${file}: not valid JSON, so its hooks cannot be audited`);
      continue;
    }
    const hooks = parsed?.hooks;
    if (hooks && typeof hooks === 'object') {
      for (const [event, entries] of Object.entries(hooks)) {
        const n = Array.isArray(entries) ? entries.length : 1;
        // PreToolUse is the one that can return a permission decision.
        const flag = event === 'PreToolUse' ? ' — can return a permission decision' : '';
        notes.push(`${path.basename(file)}: ${event} × ${n}${flag}`);
      }
    }
  }

  // .mcp.json entries start processes, connected without approval in -p mode (X3).
  const mcp = path.join(agent.home, '.mcp.json');
  if (await exists(mcp)) notes.push('.mcp.json present — entries start processes (X3)');

  // Subagent definitions carry tool grants (X3).
  const agentsDir = path.join(agent.home, '.claude', 'agents');
  const subagents = await listFiles(agentsDir);
  if (subagents.length) notes.push(`.claude/agents/: ${subagents.length} subagent definition(s) — they carry tool grants (X3)`);

  return { found: notes.length > 0, detail: notes.join('\n') };
}

async function checkGuards(config: Config, findings: Finding[]): Promise<void> {
  const l = layout(config);
  const killSet = await exists(l.kill);
  report(findings, {
    level: killSet ? 'warn' : 'ok',
    what: `kill switch (C3) — ${l.kill}`,
    detail: killSet ? 'SET. Nothing will be dispatched until it is cleared with `orchestrator resume`.' : 'not set',
  });

  report(findings, {
    level: 'ok',
    what: `caps (C2) — ${config.caps.perHourInvocations}/hour, ${config.caps.perThreadInvocations}/thread`,
    detail: `chain defaults (C1): ${config.defaults.hopBudget} hops, ${config.defaults.invocationCeiling} invocations. C6: these count invocations, not successes — a failed invocation costs more than a successful one.`,
  });

  report(findings, {
    level: 'ok',
    what: `timeouts (V7) — ${config.defaults.silenceTimeoutMs / 1000}s silence, ${config.defaults.wallClockTimeoutMs / 1000}s wall clock`,
    detail: 'Silence detection rather than elapsed time, so a legitimately long run is not killed.',
  });

  // F1 — authentication mode is configuration, not architecture.
  if (config.auth.mode === 'api-key') {
    const set = !!process.env[config.auth.apiKeyEnvVar];
    report(findings, {
      level: set ? 'ok' : 'fail',
      what: `auth mode: api-key, from $${config.auth.apiKeyEnvVar} (F1)`,
      detail: set ? undefined : `$${config.auth.apiKeyEnvVar} is not set.`,
    });
  } else {
    report(findings, {
      level: 'ok',
      what: 'auth mode: subscription (F1)',
      detail: 'Switching to an API key is a config change, not a rewrite.',
    });
  }
}

async function checkNetwork(config: Config, findings: Finding[]): Promise<void> {
  // N1 — the bind address, not the protocol, determines exposure.
  const loopback = config.ports.bindAddress === '127.0.0.1' || config.ports.bindAddress === '::1';
  report(findings, {
    level: loopback ? 'ok' : 'fail',
    what: `bind address is loopback (N1) — ${config.ports.bindAddress}`,
  });

  // N5/N7 — inside 40000–49151, below every common framework default and below the
  // ephemeral floor.
  for (const [name, port] of [['mcp', config.ports.mcp], ['operatorView', config.ports.operatorView]] as const) {
    const inWindow = port >= 40000 && port <= 49151;
    report(findings, {
      level: inWindow ? 'ok' : 'warn',
      what: `ports.${name} = ${port}`,
      detail: inWindow
        ? undefined
        : 'N5/N7: choose from 40000–49151 — below every common framework default, and below the 49152 ephemeral floor where a fixed listener can lose a race at boot.',
    });
  }

  // N7 — "Reserved exclusion ranges make ports un-bindable while appearing free.
  // Hyper-V, WSL and Docker Desktop reserve blocks at install time... Nothing is
  // listening on those and nothing can bind them either; the error is a permission
  // denial that reads as a privilege problem rather than a reservation. `netsh int
  // ipv4 show excludedportrange protocol=tcp` lists them, and the list changes when
  // those products update."
  //
  // Checked now rather than when the socket is built, because the failure it
  // prevents looks like nothing at all.
  if (process.platform === 'win32') {
    const excluded = await readExcludedPortRanges();
    if (!excluded.ok) {
      report(findings, {
        level: 'warn',
        what: 'could not read the reserved port exclusions (N7)',
        detail: `${excluded.error}\nRun: netsh int ipv4 show excludedportrange protocol=tcp`,
      });
    } else {
      const clashes: string[] = [];
      for (const [name, port] of [['mcp', config.ports.mcp], ['operatorView', config.ports.operatorView]] as const) {
        const hit = excluded.ranges.find((r) => port >= r.start && port <= r.end);
        if (hit) clashes.push(`ports.${name} = ${port} falls inside the reserved range ${hit.start}–${hit.end}`);
      }
      report(findings, {
        level: clashes.length ? 'fail' : 'ok',
        what: `configured ports are not inside a reserved exclusion range (N7)`,
        detail: clashes.length
          ? `${clashes.join('\n')}\nNothing is listening there and nothing can bind there either. The error reads as a privilege problem rather than a reservation.`
          : `${excluded.ranges.length} reserved range(s) on this machine; neither port is inside one.`,
      });
    }
  }

  // The MCP server exists now, but it is stdio: the CLI spawns it as a child and
  // talks to it over pipes. Nothing binds a socket, so N1's exposure question does
  // not arise for it and `ports.mcp` remains unused.
  report(findings, {
    level: 'ok',
    what: 'nothing binds a port',
    detail:
      'The MCP server is stdio — spawned per invocation, no socket, so N1 does not apply to it. J2 is served by this CLI. These keys record the decision (N5/N6) for whatever listens later.',
  });
}

/** The contract's moving parts, checked once rather than per agent. */
async function checkContract(config: Config, findings: Finding[]): Promise<void> {
  if (!config.contract.mcp) {
    report(findings, {
      level: 'warn',
      what: 'contract.mcp is off — agents write message files by hand',
      detail:
        'That is the behaviour from before the tool existed, and it works — the sweep is unchanged. But T6\'s format problem is back in the agent\'s hands, and a malformed message costs an M7 bounce plus a second invocation to fix.',
    });
  } else {
    try {
      const { command, args } = serverCommand();
      report(findings, {
        level: 'ok',
        what: `the MCP tool is offered as ${MCP_TOOL_ID}`,
        detail: `Spawned as: ${command} ${args.join(' ')}`,
      });
    } catch (err: any) {
      report(findings, {
        level: 'fail',
        what: 'the MCP server entry point cannot be found',
        detail: `${err?.message ?? String(err)}
Every dispatch would offer a tool that fails to connect. Fix: npm run build`,
      });
    }
  }

  if (!config.contract.skill) {
    report(findings, {
      level: 'warn',
      what: 'contract.skill is off — the prompt is sent as plain text',
      detail: 'The delivery instructions are then something the model reads on its way past rather than something injected before the turn starts.',
    });
  }
}

/** N7 — the exclusions change when Hyper-V, WSL or Docker Desktop update, so this is read, never cached. */
async function readExcludedPortRanges(): Promise<
  { ok: true; ranges: { start: number; end: number }[] } | { ok: false; error: string }
> {
  const out = await run('netsh', ['int', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp']);
  if (out.error) return { ok: false, error: out.error };
  const ranges: { start: number; end: number }[] = [];
  for (const line of out.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) ranges.push({ start, end });
  }
  return { ok: true, ranges };
}

function run(bin: string, args: string[]): Promise<{ stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    // shell: false throughout, per T5 and §14's console-encoding note.
    const child = spawn(bin, args, { shell: false, windowsHide: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.on('data', (d: string) => (stderr += d));
    child.on('error', (err) => resolve({ stdout, stderr, error: err.message }));
    child.on('close', (code) =>
      resolve(code === 0 ? { stdout, stderr } : { stdout, stderr, error: `exit ${code}: ${stderr.trim() || stdout.trim()}` })
    );
  });
}
