/**
 * `orchestrator probe` — the ten-minute test §14 says gates the first dispatch.
 *
 * "Spawning the CLI with an explicit working directory from the application's own
 * runtime is unproven. The mechanism is established through one route only. On
 * Windows the CLI is reached via a shim, which is the known trap on that path. It
 * is a ten-minute test and it gates the first dispatch."
 *
 * One live invocation, deliberately cheap, that answers four questions at once:
 *
 *   1. D2  — does an externally set working directory actually take effect, and does
 *            the agent load *that* directory's CLAUDE.md?
 *   2. V2  — can the agent write a file into its own outbox, and can we see it?
 *   3. X1  — is the shell genuinely denied, and does the denial surface in the
 *            permission_denials array (V4)?
 *   4. —    does `--permission-mode` mean what its name suggests? The mode is an
 *            enumeration whose behaviour is not documented by its spelling, so it is
 *            established by measurement rather than assumed.
 *
 * The probe writes a marker file into the agent's home, asks the agent to read it
 * and report the value, and asks it to attempt one shell command. Nothing it does
 * touches the ledger.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import type { Config } from '../config/load.js';
import { findAgent } from '../config/load.js';
import { invoke } from '../dispatch/invoke.js';
import { buildPermissionPlan } from '../dispatch/permissions.js';
import { ensureDir, exists, listFiles, readTextIfExists, writeText } from '../util/fsx.js';
import { canonical } from '../util/paths.js';
import { formatDuration } from '../util/time.js';
import { bold, dim, green, red, yellow, heading } from './render.js';

export async function runProbe(
  config: Config,
  opts: { agentName?: string; yes: boolean }
): Promise<number> {
  const agent = opts.agentName ? findAgent(config, opts.agentName) : config.agents[0];
  if (!agent) {
    console.error(red(opts.agentName ? `"${opts.agentName}" is not in the roster.` : 'The roster is empty.'));
    return 2;
  }

  const token = crypto.randomBytes(4).toString('hex').toUpperCase();
  const markerName = `orchestrator-probe-${token}.txt`;
  const marker = path.join(agent.home, markerName);

  console.log(heading('Probe'));
  console.log(`  agent            ${bold(agent.name)}`);
  console.log(`  working directory ${bold(agent.home)}   ${dim('(D2)')}`);
  console.log(`  binary           ${config.claudeBin}`);
  console.log(`  model            ${agent.model ?? config.defaults.model}`);
  console.log(dim(`\n  This is one live invocation and it will spend a small amount of your quota.`));
  console.log(dim(`  §14: it is the test that gates the first dispatch.`));

  if (!opts.yes && process.stdin.isTTY) {
    const ok = await confirm('\n  Run it? [y/N] ');
    if (!ok) {
      console.log(dim('  Cancelled. Nothing was spent.'));
      return 0;
    }
  }

  await ensureDir(agent.outbox);
  await writeText(marker, `PROBE_TOKEN=${token}\n`);

  const before = new Set(await listFiles(agent.outbox));

  const prompt = [
    'This is an automated probe from the orchestrator. Do exactly these four things and nothing else.',
    '',
    `1. Read the file "${markerName}" in your current working directory and note the token in it.`,
    '',
    `2. Write a file named "probe-${token}.md" into this directory:`,
    `   ${agent.outbox}`,
    '   Its entire contents should be four lines:',
    '',
    '   ---',
    `   token: <the token you read from ${markerName}>`,
    '   cwd: <your current working directory, exactly as you see it>',
    '   ---',
    '',
    '3. Attempt to run this shell command: echo probe',
    '   It is expected to be denied. Do not look for another way to run it, and do not',
    '   work around the denial. Just note what happened.',
    '',
    '4. Reply with ONE line: the token, whether the shell command was denied, and the',
    '   first heading of your CLAUDE.md if you can see one.',
  ].join('\n');

  const plan = buildPermissionPlan(config, agent);
  console.log(`\n  ${dim(`${plan.settings.permissions.deny.length} deny rule(s) in force; ${plan.tools.length} tool(s) available`)}`);
  console.log(dim('  invoking...'));

  const result = await invoke({
    config,
    agent,
    prompt,
    invocationId: `probe-${token}`,
  });

  // ---- results -------------------------------------------------------------
  console.log(heading('Results'));

  const after = await listFiles(agent.outbox);
  const produced = after.filter((f) => !before.has(f));
  const probeFile = produced.find((f) => path.basename(f).includes(token)) ?? produced[0] ?? null;
  const probeText = probeFile ? await readTextIfExists(probeFile) : null;

  let pass = true;

  // 2 / V2 / X4 — the artefact is the success criterion, and the write permission
  // is what makes an artefact possible. X4: "Getting this wrong produces a system
  // that looks like it works and does nothing."
  const writeDenials = result.permissionDenials.filter((d) => /^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(d.toolName));
  if (probeFile && probeText) {
    line('ok', `V2/X4 — an artefact appeared in the outbox: ${path.basename(probeFile)}`);
  } else if (writeDenials.length) {
    pass = false;
    line('FAIL', 'X4 — the agent was denied permission to write into its own outbox');
    for (const d of writeDenials) {
      console.log(dim(`        ${d.toolName}: ${JSON.stringify(d.toolInput).slice(0, 200)}`));
    }
    console.log(dim('        The allow rule for the outbox is not matching. Compare it against the deny/allow'));
    console.log(dim('        rules in `orchestrator dispatch <agent> --dry-run`. Nothing else can work until it does.'));
  } else {
    pass = false;
    line('FAIL', 'V2 — nothing appeared in the outbox, and no write was denied');
    console.log(dim('        The agent did not attempt a write. V1: every status field can still say success.'));
  }

  // 1 / D2 — the working directory, and with it the whole design.
  //
  // The token counts wherever it appears. The first run of this probe demanded it in
  // the artefact, which conflated two independent questions: the write was denied by
  // a permission rule while the *read* had plainly succeeded, and the probe reported
  // D2 as failed when D2 had in fact worked. Keeping the two separate is the point.
  const sawToken = (probeText?.includes(token) ?? false) || (result.finalText?.includes(token) ?? false);
  const reportedCwd = /cwd:\s*(.+)/.exec(probeText ?? '')?.[1]?.trim() ?? null;
  const cwdMatches = reportedCwd ? canonical(reportedCwd.replace(/^["']|["']$/g, '')) === canonical(agent.home) : false;

  if (sawToken) {
    line('ok', `D2 — the agent read a file from ${agent.home}, so the external working directory took effect`);
  } else {
    pass = false;
    line('FAIL', 'D2 — the agent did not report the token, so it may not have been running in the intended directory');
    console.log(dim('        §14 names the Windows shim as the known trap here. This is the mechanism the entire design rests on.'));
  }
  if (reportedCwd) {
    line(cwdMatches ? 'ok' : 'warn', `D2 — agent reported cwd: ${reportedCwd}`);
  }

  // 3 / X1 + V4 — the shell denial, and whether it surfaces.
  const shellDenials = result.permissionDenials.filter((d) => /bash/i.test(d.toolName));
  if (agent.shellAllowed) {
    line('warn', 'X1 — shell is allowed for this agent (X2), so the denial was not tested');
  } else if (shellDenials.length) {
    line('ok', `X1/V4 — the shell attempt was denied, and the denial surfaced with its full input`);
    for (const d of shellDenials) {
      console.log(dim(`        ${d.toolName}: ${JSON.stringify(d.toolInput).slice(0, 200)}`));
    }
  } else {
    // Two very different situations produce no denial, and V4 says so explicitly:
    // "an agent can also simply decline the work, which produces no denial at all."
    line('warn', 'X1 — no shell denial was recorded');
    console.log(dim('        Either the agent declined to try (V4 says this produces no denial), or the tool was not reachable at all.'));
    console.log(dim(`        Read the agent's reply below to tell which. Tools offered: ${plan.tools.join(', ')}`));
  }

  // 4 / D11 — the one-line confirmation as a free health check.
  if (result.finalText) {
    line('ok', 'D11 — the agent returned a chat response');
    console.log(dim(`        ${result.finalText.split('\n').slice(0, 4).join('\n        ')}`));
  } else {
    line('warn', 'D11 — the agent returned no text, so a working run and a broken one look alike from outside');
  }

  // ---- what the CLI claimed, kept separate from what happened ---------------
  console.log(heading('What the CLI reported (V1 — not the test)'));
  console.log(`  process outcome  ${result.outcome}`);
  console.log(`  exit code        ${result.exitCode}`);
  console.log(`  subtype          ${result.resultSubtype}`);
  console.log(`  is_error         ${result.isError}`);
  console.log(`  turns            ${result.numTurns}`);
  console.log(`  wall             ${formatDuration(result.wallMs)}`);
  console.log(`  cost             ${result.costUsd == null ? 'unknown' : '~$' + result.costUsd.toFixed(4)} ${dim('(client-side estimate, §14)')}`);
  console.log(dim(`  events           ${JSON.stringify(result.eventCounts)}`));
  if (result.stderr) console.log(dim(`  stderr           ${result.stderr.slice(0, 500)}`));
  console.log(dim('\n  V1: a run that achieved nothing has been measured reporting success on every one'));
  console.log(dim('  of these fields. The verdict above came from the outbox, not from here.'));

  // ---- clean up ------------------------------------------------------------
  const { unlink } = await import('node:fs/promises');
  for (const f of [marker, ...(probeFile ? [probeFile] : [])]) {
    if (await exists(f)) await unlink(f).catch(() => {});
  }
  console.log(dim(`\n  Cleaned up the probe marker and artefact. The ledger was not touched.`));

  console.log(heading('Verdict'));
  if (pass) {
    console.log(`  ${green('The mechanism the design rests on works on this machine.')}`);
    console.log(dim('  Next: orchestrator write --to ... , then orchestrator run --dry-run'));
  } else {
    console.log(`  ${red('The probe did not establish D2 or V2. Do not dispatch until it does.')}`);
  }
  return pass ? 0 : 1;
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
