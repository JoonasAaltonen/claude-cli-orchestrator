/**
 * `orchestrator init` — creates an installation.
 *
 * "Portability is a requirement, not an aspiration. Every path is configuration.
 * Someone should be able to clone the repository, point it at their own agent
 * directories and their own comms directory, and run it without editing code."
 *
 * So this command writes configuration and scaffolds directories. It never edits
 * code, and everything it writes is overridable by flags.
 */
import path from 'node:path';
import process from 'node:process';
import { appRoot, defaultConfigPath, repoRoot, loadConfig } from '../config/load.js';
import type { ConfigInput } from '../config/schema.js';
import { initCommsRoot } from '../ledger/store.js';
import { canonical, isWithin } from '../util/paths.js';
import { exists, writeText } from '../util/fsx.js';
import { bold, dim, green, red, yellow, heading } from './render.js';
import { checkClaudeBin, shimAdvice } from '../util/which.js';

export interface InitOptions {
  configPath?: string;
  commsRoot?: string;
  force: boolean;
}

export async function runInit(opts: InitOptions): Promise<void> {
  const configFile = opts.configPath ? canonical(opts.configPath) : defaultConfigPath();
  const repo = repoRoot();

  // T2 — the comms root is an installation's data; the application is a generic
  // repository kept elsewhere. The default puts data beside the repo, never inside.
  const parent = path.dirname(repo);
  const commsRoot = canonical(opts.commsRoot ?? path.join(parent, 'claude-comms'));

  if (isWithin(repo, commsRoot)) {
    console.error(red(`Refusing: commsRoot ${commsRoot} is inside the repository. T2 requires them separate.`));
    process.exitCode = 2;
    return;
  }
  if ((await exists(configFile)) && !opts.force) {
    console.error(red(`${configFile} already exists. Pass --force to overwrite it.`));
    process.exitCode = 2;
    return;
  }

  console.log(heading('Creating an installation'));
  console.log(`  repository   ${dim(repo)}  ${dim('(generic, not this installation)')}`);
  console.log(`  comms root   ${bold(commsRoot)}`);

  // The application ships no agents. It is a channel between directories that
  // already exist and belong to the operator, so init creates the comms root and a
  // configuration file with an empty roster — nothing else. Scaffolding example
  // agents would make them look like part of the tool, and would put a "coordinator"
  // in the middle of chains that do not need one.
  const config: ConfigInput = {
    commsRoot,
    claudeBin: 'claude',
    promptTemplate: path.join(appRoot(), 'templates', 'prompt', 'v1.md'),
    agents: [],
  };

  await writeText(configFile, JSON.stringify(config, null, 2) + '\n');
  console.log(`\n${green('wrote')} ${configFile}`);

  const loaded = await loadConfig(configFile);
  await initCommsRoot(loaded);
  console.log(`${green('created')} ${commsRoot}`);
  console.log(dim('  index.jsonl  messages/  rejected/  state/  prompts/  snapshots/'));

  // The one piece of the environment that has to be right before anything else is
  // worth doing. An npm install of the Claude CLI leaves a batch shim on PATH that
  // cannot be spawned without a shell, and the failure surfaces much later as an
  // error that names no file — so it is worth one line here, while someone is
  // reading output and can still act on it.
  const binary = await checkClaudeBin(config.claudeBin ?? 'claude');
  console.log(heading('Claude CLI'));
  if (binary.kind === 'ok') {
    console.log(`  ${green('found')} ${binary.resolved}`);
  } else if (binary.kind === 'not-found') {
    console.log(`  ${yellow('not on PATH')} — nothing named ${bold(binary.bin)} was found.`);
    console.log(dim('  Install the native build (https://claude.com/download), or set'));
    console.log(dim('  `claudeBin` in the config to the full path of the executable.'));
  } else {
    console.log(`  ${red('incompatible')} — ${binary.resolved}`);
    for (const line of shimAdvice(binary).split('\n')) console.log(line ? `  ${dim(line)}` : '');
  }

  console.log(heading('Next'));
  console.log(`  1. ${bold('orchestrator agent add <name> --home <directory>')}`);
  console.log(dim('     Register an agent directory you already have. Repeat for each one.'));
  console.log(dim('     Add --write-protocol to install the protocol file, a one-line pointer in'));
  console.log(dim('     its CLAUDE.md, and the ledger skills.'));
  console.log(`  2. ${bold('orchestrator doctor --fix-hooks-audit')}`);
  console.log(dim('     Verifies paths, flags and authentication, and audits each agent'));
  console.log(dim('     directory for permission-granting hooks before anything is dispatched.'));
  console.log(`  3. ${bold('orchestrator probe <agent>')}`);
  console.log(dim('     One live invocation proving the CLI honours an external working directory.'));
  console.log(`  4. ${bold('orchestrator write --to <agent> --summary "..." --body-file ./request.md')}`);
  console.log(`  5. ${bold('orchestrator run --dry-run')}`);
  console.log(dim('     Prints the exact prompt and every permission rule. Spends nothing.'));
}
