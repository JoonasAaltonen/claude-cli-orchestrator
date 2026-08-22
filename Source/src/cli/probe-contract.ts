/**
 * `orchestrator probe-contract` — does the skill-plus-MCP path actually work?
 *
 * §14's argument for the working-directory probe applies unchanged here. Three
 * mechanisms have to line up for a dispatch to deliver anything: the slash command
 * has to resolve, the MCP server has to connect, and the tool has to be reachable
 * through the permission plan. Each fails silently. A skill that does not resolve
 * arrives as stray text; a server that does not connect leaves a tool the model
 * simply never sees; a tool blocked by a rule produces a denial the agent works
 * around by writing a file instead. All three look like an agent that chose not to
 * cooperate, and all three report success on every status field (V1).
 *
 * So this runs the real thing — the real skill, the real MCP config, the real
 * permission plan — against a fabricated job, and reads the outbox.
 *
 * It does not touch the ledger. The message the agent produces is left unswept and
 * then deleted, so nothing enters the index and no row is created. That is the whole
 * reason it can be run before trusting any of this with real work.
 */
import crypto from 'node:crypto';
import process from 'node:process';
import { unlink } from 'node:fs/promises';
import type { Agent, Config } from '../config/load.js';
import { findAgent } from '../config/load.js';
import { invoke } from '../dispatch/invoke.js';
import { buildPermissionPlan } from '../dispatch/permissions.js';
import { writeMcpConfig, mcpConfigPathFor } from '../mcp/config.js';
import { MCP_TOOL_ID, SKILL_COMMAND, installedSkillPath } from '../contract/names.js';
import { installSkills, skillStatus, dispatchSkill } from './skills.js';
import { parseMessageFile } from '../ledger/message.js';
import { exists, listFiles, readTextIfExists } from '../util/fsx.js';
import { formatDuration } from '../util/time.js';
import { bold, dim, green, red, yellow, heading } from './render.js';

export async function runProbeContract(
  config: Config,
  opts: { agentName?: string; yes: boolean }
): Promise<number> {
  const agent = opts.agentName ? findAgent(config, opts.agentName) : config.agents[0];
  if (!agent) {
    console.error(red(opts.agentName ? `"${opts.agentName}" is not in the roster.` : 'The roster is empty.'));
    return 2;
  }

  const token = crypto.randomBytes(4).toString('hex').toUpperCase();
  const plan = buildPermissionPlan(config, agent);

  console.log(heading('Contract probe'));
  console.log(`  agent             ${bold(agent.name)}`);
  console.log(`  working directory ${bold(agent.home)}`);
  console.log(`  skill             ${config.contract.skill ? bold(SKILL_COMMAND) : dim('disabled in config')}`);
  console.log(`  tool              ${config.contract.mcp ? bold(MCP_TOOL_ID) : dim('disabled in config')}`);
  console.log(dim('\n  One live invocation against a made-up job. The ledger is not touched: whatever'));
  console.log(dim('  the agent produces is read, reported and deleted without being swept.'));

  if (!opts.yes && process.stdin.isTTY) {
    const ok = await confirm('\n  Run it? [y/N] ');
    if (!ok) {
      console.log(dim('  Cancelled. Nothing was spent.'));
      return 0;
    }
  }

  // ---- make sure the pieces are where dispatch expects them ----------------
  if (config.contract.skill) {
    const s = await skillStatus(agent);
    const one = dispatchSkill(s);
    if (!one.installed || one.stale) {
      await installSkills(agent);
      console.log(`  ${green(one.installed ? 'updated' : 'installed')} the ledger skills  ${dim(one.path)}`);
    }
  }
  if (config.contract.mcp) {
    const f = await writeMcpConfig(config, agent, config.configFile);
    console.log(`  ${dim('mcp config')}  ${f}`);
  }

  const before = new Set(await listFiles(agent.outbox));
  const prompt = buildProbePrompt(config, agent, token);

  console.log(dim(`\n  prompt starts: ${prompt.slice(0, 60).replace(/\n/g, ' ')}…`));
  console.log(dim(`  ${prompt.length} characters, ${prompt.split('\n').length} lines`));
  console.log(dim('  invoking...'));

  const result = await invoke({ config, agent, prompt, invocationId: `probe-contract-${token}` });

  // ---- what actually happened ----------------------------------------------
  console.log(heading('Results'));

  const after = await listFiles(agent.outbox);
  const produced = after.filter((f) => !before.has(f));
  let pass = true;

  const usedTool = result.toolsUsed.includes(MCP_TOOL_ID);
  const wroteByHand = result.toolsUsed.some((t) => /^(Write|Edit|MultiEdit)$/.test(t));

  // 1 — the skill. There is no direct signal, so this is read from the behaviour it
  // was supposed to cause rather than claimed.
  if (config.contract.skill) {
    const echoed = (result.finalText ?? '').includes(SKILL_COMMAND);
    if (echoed) {
      pass = false;
      line('FAIL', `the reply contains "${SKILL_COMMAND}" as literal text — the command did not resolve`);
      console.log(dim(`        Check that ${installedSkillPath(agent.home)} exists and its frontmatter name matches.`));
    } else {
      line('ok', 'the slash command did not come back as prose, so it resolved');
    }
  }

  // 2 — the MCP tool. This is the one worth being precise about, because writing a
  // file by hand also produces an artefact and would otherwise read as a pass.
  if (config.contract.mcp) {
    if (usedTool) {
      line('ok', `${MCP_TOOL_ID} was called — the agent never touched the format`);
    } else if (wroteByHand) {
      pass = false;
      line('FAIL', 'the agent wrote a file by hand instead of calling the tool');
      console.log(dim('        The fallback worked, so the run is not lost — but the tool was not reachable.'));
      console.log(dim(`        Tools called: ${result.toolsUsed.join(', ') || 'none'}`));
      console.log(dim(`        Check the server starts: node ${mcpConfigPathFor(agent)} names the command.`));
    } else {
      pass = false;
      line('FAIL', 'neither the tool nor a file write happened');
    }

    const denials = result.permissionDenials.filter((d) => d.toolName.startsWith('mcp__'));
    if (denials.length) {
      pass = false;
      line('FAIL', 'the MCP tool call was denied by a permission rule (V4)');
      for (const d of denials) console.log(dim(`        ${d.toolName}: ${JSON.stringify(d.toolInput).slice(0, 160)}`));
    }
  }

  // 3 — V2. The artefact is the success criterion, whatever produced it.
  if (!produced.length) {
    pass = false;
    line('FAIL', 'V2 — nothing appeared in the outbox');
    console.log(dim('        Note that the CLI may have reported success on every status field (V1).'));
  } else if (produced.length > 1) {
    line('warn', `${produced.length} files appeared; a dispatch expects one`);
  }

  // 4 — is what appeared actually valid? The tool renders through the same writer
  // the sweep reads with, so a mismatch here would mean the two paths have drifted.
  for (const file of produced) {
    const parsed = await parseMessageFile(file);
    if (parsed.ok && parsed.draft) {
      line('ok', `the message parses: to ${parsed.draft.to.join(', ')}, type ${parsed.draft.type}`);
      console.log(dim(`        summary: ${parsed.draft.summary}`));
      if (parsed.draft.body.includes(token)) {
        line('ok', 'the body carries the token from the job, so the agent read the prompt through the skill');
      } else {
        line('warn', 'the body does not mention the token — the job may not have reached the agent intact');
      }
      if (parsed.lenient) {
        line('warn', 'it needed the lenient frontmatter reader, which the MCP path should never require');
      }
    } else {
      pass = false;
      line('FAIL', `what appeared is not a valid message: ${parsed.errors.join('; ')}`);
      const text = await readTextIfExists(file);
      if (text) console.log(dim(`        ${text.slice(0, 300).replace(/\n/g, '\n        ')}`));
    }
  }

  if (result.finalText) {
    console.log(dim(`\n  reply: ${result.finalText.split('\n').slice(0, 3).join('\n         ')}`));
  }
  console.log(dim(`\n  tools called: ${result.toolsUsed.join(', ') || 'none'}`));
  console.log(dim(`  ${result.outcome}, exit ${result.exitCode}, ${formatDuration(result.wallMs)}, ~$${(result.costUsd ?? 0).toFixed(4)}`));
  if (result.stderr) console.log(dim(`  stderr: ${result.stderr.slice(0, 400)}`));
  console.log(dim(`  ${plan.tools.length} built-in tool(s) offered: ${plan.tools.join(', ')}`));

  // ---- clean up: nothing reaches the ledger --------------------------------
  for (const f of produced) {
    if (await exists(f)) await unlink(f).catch(() => {});
  }
  console.log(dim(`\n  Deleted ${produced.length} outbox file(s) unswept. No row was created.`));

  console.log(heading('Verdict'));
  if (pass) {
    console.log(`  ${green('The contract holds: the skill resolves, the tool is reachable, the message is valid.')}`);
    console.log(dim('  Dispatch will deliver through the tool rather than through a hand-written file.'));
  } else {
    console.log(`  ${red('The contract did not hold on every point.')}`);
    console.log(dim('  Dispatch still works — the outbox sweep is the fallback and it is unaffected —'));
    console.log(dim('  but the guarantees above are not the ones in force. Fix what is marked FAIL, or'));
    console.log(dim('  set contract.mcp / contract.skill to false in the configuration and rely on the'));
    console.log(dim('  prompt instructions, which is where this started.'));
  }
  return pass ? 0 : 1;
}

/**
 * A job shaped like a real one: multi-line, with the roster and the delivery
 * instructions the template produces, prefixed with the skill command.
 *
 * The length matters. `probe-slash` established $ARGUMENTS substitution with a
 * single short token, and a real prompt is thousands of characters across dozens of
 * lines. Whether that survives the same expansion is a separate question, and this
 * is where it gets answered.
 */
function buildProbePrompt(config: Config, agent: Agent, token: string): string {
  const body = [
    `You are **${agent.name}**. This is an automated check of the orchestrator's message`,
    'contract, not real work. Do not do any research, read any files, or write anything',
    'except the one message described below.',
    '',
    '## The job',
    '',
    `Confirm that you received this instruction. Include the token ${token} in your`,
    'message body, along with one sentence saying whether you were given a tool for',
    'delivering messages or had to write a file by hand.',
    '',
    '## What you must produce',
    '',
    config.contract.mcp
      ? [
          `Deliver it by calling \`${MCP_TOOL_ID}\` with:`,
          '',
          '  to: operator',
          '  type: report',
          `  summary: one line mentioning ${token}`,
          '  body: the confirmation described above',
          '',
          `If \`${MCP_TOOL_ID}\` is not in your tool list, write the file instead:`,
        ].join('\n')
      : 'Write one Markdown file into your outbox:',
    '',
    '```',
    agent.outbox,
    '```',
    '',
    '```markdown',
    '---',
    'to: operator',
    'type: report',
    `summary: Contract probe ${token}`,
    '---',
    '',
    'The confirmation.',
    '```',
    '',
    'Then reply in chat with one line saying what you did.',
  ].join('\n');

  return config.contract.skill ? `${SKILL_COMMAND} ${body}` : body;
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
