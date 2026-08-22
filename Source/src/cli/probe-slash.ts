/**
 * `orchestrator probe-slash` — does a slash command resolve in a `--print` run?
 *
 * This gates the skill half of the planned MCP + skill pairing. The whole reason to
 * put the ledger contract in a skill is that a skill is read *at invocation time*
 * and reliably followed; if `/name` arrives at the model as five literal characters
 * instead, the skill is a file nobody opens and the contract has to live somewhere
 * else. That is a design decision, so it is measured rather than assumed — the same
 * reasoning §14 applies to the working-directory probe.
 *
 * Three stages, run in order, stopping at the first that works. Best case is one
 * cheap invocation; worst case is three.
 *
 *   A. A skill in `.claude/skills/`, invoked as `/name`, with exactly the tool set
 *      dispatch uses. A pass here means production is already correct.
 *   B. The same skill, with `Skill` and `SlashCommand` added to `--tools`. A pass
 *      here and not at A is a precise finding: layer 3 is removing the tool that
 *      drives the mechanism, and DEFAULT_TOOLS needs one entry.
 *   C. A command in `.claude/commands/` instead. A pass here and not at A or B
 *      means the contract belongs in a command file, not a skill.
 *
 * The test is a secret that exists in exactly one place: the body of the file being
 * probed. It is never in the prompt, so it cannot come back by being echoed. If the
 * agent says the secret, the file was opened and its instructions were followed.
 * That is the artefact rule (V2) applied to a mechanism rather than to a message.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { rm } from 'node:fs/promises';
import type { Agent, Config } from '../config/load.js';
import { findAgent } from '../config/load.js';
import { invoke } from '../dispatch/invoke.js';
import type { InvocationResult } from '../dispatch/invoke.js';
import { buildPermissionPlan } from '../dispatch/permissions.js';
import { writeText } from '../util/fsx.js';
import { formatDuration } from '../util/time.js';
import { bold, dim, green, red, yellow, heading } from './render.js';

/**
 * The tools the mechanism is thought to run on. `Skill` is how a skill is entered;
 * `SlashCommand` is how a custom command is. Neither is in DEFAULT_TOOLS, which is
 * the hypothesis stage B exists to test.
 */
const SLASH_TOOLS = ['Skill', 'SlashCommand'];

interface Stage {
  key: 'A' | 'B' | 'C';
  what: string;
  /** The file the mechanism has to open, and the directory to delete afterwards. */
  file: string;
  root: string;
  contents: string;
  /** Exactly what goes on stdin. The secret is deliberately absent from it. */
  prompt: string;
  secret: string;
  extraTools: string[];
  /** What a pass at this stage, and no earlier one, tells us to do. */
  finding: string;
}

export async function runProbeSlash(
  config: Config,
  opts: { agentName?: string; yes: boolean }
): Promise<number> {
  const agent = opts.agentName ? findAgent(config, opts.agentName) : config.agents[0];
  if (!agent) {
    console.error(red(opts.agentName ? `"${opts.agentName}" is not in the roster.` : 'The roster is empty.'));
    return 2;
  }

  const token = crypto.randomBytes(3).toString('hex').toLowerCase();
  const stages = buildStages(agent, token);
  const plan = buildPermissionPlan(config, agent);

  console.log(heading('Slash-command probe'));
  console.log(`  agent             ${bold(agent.name)}`);
  console.log(`  working directory ${bold(agent.home)}`);
  console.log(`  tools in dispatch ${plan.tools.join(', ')}`);
  console.log(dim(`\n  Question: does a slash command resolve in a --print run, and does the`));
  console.log(dim(`  file behind it actually get read? Up to three small invocations, stopping`));
  console.log(dim(`  at the first that works.`));
  console.log(dim(`\n  Nothing here touches the ledger. Every file it writes is removed afterwards.`));

  if (!opts.yes && process.stdin.isTTY) {
    const ok = await confirm('\n  Run it? [y/N] ');
    if (!ok) {
      console.log(dim('  Cancelled. Nothing was spent.'));
      return 0;
    }
  }

  const created: string[] = [];
  let passed: Stage | null = null;
  let args: ArgFinding | null = null;
  const attempts: { stage: Stage; result: InvocationResult; saidSecret: boolean }[] = [];

  try {
    for (const stage of stages) {
      await writeText(stage.file, stage.contents);
      if (!created.includes(stage.root)) created.push(stage.root);

      console.log(heading(`Stage ${stage.key} — ${stage.what}`));
      console.log(`  file    ${dim(stage.file)}`);
      console.log(`  stdin   ${bold(stage.prompt)}`);
      console.log(`  tools   ${stage.extraTools.length ? dim(`dispatch set + ${stage.extraTools.join(', ')}`) : dim('exactly the dispatch set')}`);
      console.log(dim('  invoking...'));

      const result = await invoke({
        config,
        agent,
        prompt: stage.prompt,
        invocationId: `probe-slash-${stage.key}-${token}`,
        extraTools: stage.extraTools,
      });

      const said = (result.finalText ?? '').includes(stage.secret);
      attempts.push({ stage, result, saidSecret: said });
      report(stage, result, said);

      if (said) {
        passed = stage;
        break;
      }
    }

    // Only worth asking once something resolves, and it is the question step 3
    // depends on: the ledger skill is entered as `/ledger-invocation <job>`, so the
    // job has to survive the trip. Whether it arrives substituted into $ARGUMENTS
    // or merely appended as trailing text changes how the skill is written.
    if (passed) {
      const check = buildArgStage(passed, token);
      await writeText(check.file, check.contents);

      console.log(heading('Stage A2 — does an argument reach the skill?'));
      console.log(`  stdin   ${bold(check.prompt)}`);
      console.log(dim('  invoking...'));

      const result = await invoke({
        config,
        agent,
        prompt: check.prompt,
        invocationId: `probe-slash-args-${token}`,
        extraTools: passed.extraTools,
      });
      attempts.push({ stage: check, result, saidSecret: false });

      const text = result.finalText ?? '';
      args = {
        substituted: text.includes(`job=${check.argValue}`),
        placeholderLeftIntact: text.includes('job=$ARGUMENTS'),
        argVisible: text.includes(check.argValue),
      };

      if (args.substituted) {
        line('ok', '$ARGUMENTS was substituted with the text after the command name');
      } else if (args.argVisible) {
        line('warn', 'the argument reached the model, but not through $ARGUMENTS');
      } else {
        line('FAIL', 'the argument did not reach the model at all');
      }
      if (args.placeholderLeftIntact) {
        console.log(dim('        the literal $ARGUMENTS came back, so the placeholder is not expanded here'));
      }
      console.log(dim(`        outcome ${result.outcome}, ${formatDuration(result.wallMs)}, ~$${(result.costUsd ?? 0).toFixed(4)}`));
      if (result.finalText) {
        console.log(dim(`        reply: ${result.finalText.split('\n').slice(0, 3).join('\n        ')}`));
      }
    }
  } finally {
    // The probe installs files into a directory it does not own. Removing them is
    // not tidiness — a leftover skill would be loaded by every later invocation of
    // this agent, and it instructs the agent to say a fixed string.
    for (const dir of created) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    console.log(dim(`\n  Removed ${created.length} probe file(s) from ${agent.home}.`));
  }

  console.log(heading('Verdict'));
  if (passed) {
    console.log(`  ${green(`Slash commands resolve in --print, and the file was read (stage ${passed.key}).`)}`);
    console.log(`\n  ${bold('What this means for the build:')}`);
    console.log(`  ${passed.finding}`);
    if (args?.substituted) {
      console.log('\n  The job can be passed as an argument: `/ledger-invocation <job>` lands in');
      console.log('  $ARGUMENTS, so the skill body can place it deliberately rather than hoping');
      console.log('  the model finds it.');
    } else if (args?.argVisible) {
      console.log('\n  An argument reaches the model but not through $ARGUMENTS. The skill has to');
      console.log('  read it as trailing text, or the job goes on stdin after the command name');
      console.log('  instead of being interpolated.');
    } else if (args) {
      console.log('\n  ' + yellow('An argument does not survive the trip.') + ' The job cannot ride on the command');
      console.log('  line — put the command name on the first line of stdin and the job below it.');
    }
  } else {
    console.log(`  ${red('No slash mechanism resolved. The file behind the command was never read.')}`);
    console.log(`\n  ${bold('What this means for the build:')}`);
    console.log('  The ledger contract cannot rely on a skill being entered by name. It has to');
    console.log('  stay where it is now — in the protocol file the CLAUDE.md pointer names, read');
    console.log('  by the agent on condition. The MCP tool is unaffected: it is offered to the');
    console.log('  model as a tool, not reached through a slash command, so step 3 can proceed');
    console.log('  without this.');
    console.log(dim('\n  Before concluding that, check the replies above for a refusal — an agent that'));
    console.log(dim('  declined the instruction looks identical to a mechanism that never fired.'));
  }

  const spent = attempts.reduce((sum, a) => sum + (a.result.costUsd ?? 0), 0);
  console.log(dim(`\n  ${attempts.length} invocation(s), ~$${spent.toFixed(4)} by the client-side estimate (§14).`));

  return passed ? 0 : 1;
}

function report(stage: Stage, result: InvocationResult, said: boolean): void {
  if (said) {
    line('ok', `the agent returned the secret, which exists only inside ${path.basename(stage.file)}`);
  } else {
    line('FAIL', 'the secret did not come back — the file behind the slash command was not read');
  }

  // Distinguishing the two ways a stage fails is the entire value of running it.
  const usedSlashTool = result.toolsUsed.filter((t) => SLASH_TOOLS.includes(t));
  if (usedSlashTool.length) {
    line('ok', `the mechanism fired: ${usedSlashTool.join(', ')} was called`);
  } else if (!said) {
    line('warn', 'no Skill or SlashCommand tool call appeared in the stream');
  }

  const echoed = (result.finalText ?? '').includes(stage.prompt.split(/\s/)[0]!);
  if (!said && echoed) {
    line('warn', 'the reply contains the literal slash text, so it arrived unexpanded as prose');
  }

  if (result.toolsUsed.length) console.log(dim(`        tools called: ${result.toolsUsed.join(', ')}`));
  if (result.permissionDenials.length) {
    console.log(dim(`        denials: ${result.permissionDenials.map((d) => d.toolName).join(', ')}`));
  }
  console.log(dim(`        outcome ${result.outcome}, exit ${result.exitCode}, ${formatDuration(result.wallMs)}, ~$${(result.costUsd ?? 0).toFixed(4)}`));
  if (result.finalText) {
    const reply = result.finalText.split('\n').slice(0, 3).join('\n        ');
    console.log(dim(`        reply: ${reply}`));
  } else {
    line('warn', 'the agent returned no text at all');
  }
  if (result.stderr) console.log(dim(`        stderr: ${result.stderr.slice(0, 300)}`));
}

function buildStages(agent: Agent, token: string): Stage[] {
  const skillName = `orchestrator-probe-${token}`;
  const cmdName = `orchestrator-cmd-${token}`;
  const skillRoot = path.join(agent.home, '.claude', 'skills', skillName);
  const cmdRoot = path.join(agent.home, '.claude', 'commands');

  const secretA = `SLASH-OK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const secretC = `CMD-OK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

  // Deliberately trivial. It proves the file was opened and its instruction obeyed,
  // and nothing else — a bigger skill would confound "did the mechanism work" with
  // "did the agent do the job", which is the question step 3 asks.
  const skillBody = [
    '---',
    `name: ${skillName}`,
    'description: Orchestrator self-test. Replies with one fixed line and does nothing else.',
    '---',
    '',
    '# Orchestrator probe',
    '',
    'You have been invoked by an automated self-test. Do exactly one thing:',
    '',
    `Reply with this single line, exactly as written, and nothing else:`,
    '',
    `    hello world ${secretA}`,
    '',
    'Do not read any files. Do not write any files. Do not explain what you did.',
  ].join('\n');

  const cmdBody = [
    '---',
    'description: Orchestrator self-test. Replies with one fixed line and does nothing else.',
    '---',
    '',
    'You have been invoked by an automated self-test. Do exactly one thing:',
    '',
    `Reply with this single line, exactly as written, and nothing else:`,
    '',
    `    hello world ${secretC}`,
    '',
    'Do not read any files. Do not write any files. Do not explain what you did.',
  ].join('\n');

  return [
    {
      key: 'A',
      what: 'a skill, with the tool set dispatch actually uses',
      file: path.join(skillRoot, 'SKILL.md'),
      root: skillRoot,
      contents: skillBody,
      prompt: `/${skillName}`,
      secret: secretA,
      extraTools: [],
      finding: [
        'Production is already correct. Ship the ledger skill into each agent\'s',
        '  .claude/skills/ at registration time, and dispatch can enter it by name —',
        '  no change to DEFAULT_TOOLS, no change to the permission plan.',
      ].join('\n'),
    },
    {
      key: 'B',
      what: 'the same skill, with Skill and SlashCommand added to --tools',
      file: path.join(skillRoot, 'SKILL.md'),
      root: skillRoot,
      contents: skillBody,
      prompt: `/${skillName}`,
      extraTools: SLASH_TOOLS,
      secret: secretA,
      finding: [
        'The mechanism works, but layer 3 was hiding it: --tools has to carry the tool',
        '  that enters a skill. Add it to DEFAULT_TOOLS in src/config/schema.ts. It is a',
        '  read-and-follow tool with no filesystem reach of its own, so X1 and X3 are',
        '  untouched by allowing it.',
      ].join('\n'),
    },
    {
      key: 'C',
      what: 'a custom command in .claude/commands/ instead of a skill',
      file: path.join(cmdRoot, `${cmdName}.md`),
      // Only the file this probe created is removed, never the commands directory,
      // which may hold the agent's own.
      root: path.join(cmdRoot, `${cmdName}.md`),
      contents: cmdBody,
      prompt: `/${cmdName}`,
      extraTools: SLASH_TOOLS,
      secret: secretC,
      finding: [
        'Commands resolve where skills do not. Ship the ledger contract as a command',
        '  file in .claude/commands/ rather than as a skill — same idea, same install',
        '  step, different directory.',
      ].join('\n'),
    },
  ];
}

interface ArgFinding {
  /** The text after the command name landed where $ARGUMENTS was. */
  substituted: boolean;
  /** The placeholder came back verbatim, so nothing expanded it. */
  placeholderLeftIntact: boolean;
  /** The text reached the model somehow, substituted or not. */
  argVisible: boolean;
}

/**
 * Rewrites the file that just passed so it echoes `$ARGUMENTS` back inside a marker,
 * then invokes it with a value. Reusing the same path is deliberate: a different
 * location would be testing a different mechanism.
 */
function buildArgStage(passed: Stage, token: string): Stage & { argValue: string } {
  const argValue = `ARG-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const contents = passed.contents.replace(
    /Reply with this single line[\s\S]*$/,
    [
      'Reply with this single line, exactly as written, and nothing else:',
      '',
      `    hello world ${passed.secret} | job=$ARGUMENTS`,
      '',
      'If $ARGUMENTS has no value, write it out literally rather than guessing.',
      'Do not read any files. Do not write any files. Do not explain what you did.',
    ].join('\n')
  );

  return {
    ...passed,
    key: 'A',
    what: 'argument passing',
    contents,
    prompt: `${passed.prompt} ${argValue}`,
    argValue,
    finding: `Probe ${token}`,
  };
}

function line(level: 'ok' | 'warn' | 'FAIL', text: string): void {
  const tag = level === 'ok' ? green('ok  ') : level === 'warn' ? yellow('warn') : red('FAIL');
  console.log(`  ${tag}  ${text}`);
}

function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d: string) => {
      process.stdin.pause();
      resolve(/^y(es)?$/i.test(d.trim()));
    });
  });
}
