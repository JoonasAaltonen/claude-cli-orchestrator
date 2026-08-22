/**
 * Wiring the MCP server into a dispatch.
 *
 * X3 is the reason this is generated per agent and passed on argv rather than left
 * in a `.mcp.json` in the agent's directory: "MCP entries start processes, connected
 * without approval in non-interactive mode", and the agent's own directory is never
 * trusted. The file this writes lives beside the generated settings (X6), names
 * exactly one server, and is paired with `--strict-mcp-config` so nothing else can
 * connect — the flag turns from a blanket refusal into a whitelist of one.
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { Agent, Config } from '../config/load.js';
import { existsSync, writeText } from '../util/fsx.js';
import { MCP_SERVER_NAME } from '../contract/names.js';

export { MCP_SERVER_NAME, MCP_TOOL_ID } from '../contract/names.js';

/** Where the generated MCP config for an agent lives (X6 — in the agent's own home). */
export function mcpConfigPathFor(agent: Agent): string {
  return path.join(agent.home, '.claude', 'orchestrator.mcp.json');
}

/**
 * Resolves how to start the server, for both a built checkout and a `tsx` dev run.
 *
 * The server is spawned by the CLI with `node`, so a bare `.ts` path would not
 * start. Under tsx the compiled entry does not exist yet, so the loader has to be
 * requested explicitly. Checking the filesystem is the only honest way to tell the
 * two apart — an env var would be a thing to remember to set.
 */
export function serverCommand(): { command: string; args: string[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const compiled = path.join(here, 'main.js');
  if (existsSync(compiled)) return { command: process.execPath, args: [compiled] };

  const source = path.join(here, 'main.ts');
  if (existsSync(source)) return { command: process.execPath, args: ['--import', 'tsx', source] };

  throw new Error(`Cannot find the MCP server entry point next to ${here}. Run \`npm run build\`.`);
}

/**
 * Writes the per-agent MCP config and returns its path.
 *
 * `--config` is passed explicitly rather than inherited: the server is started with
 * the agent's home as its working directory, so a relative default would resolve
 * against the wrong directory, and that failure would look like a broken tool rather
 * than a missing path.
 */
export async function writeMcpConfig(config: Config, agent: Agent, configFile?: string): Promise<string> {
  const { command, args } = serverCommand();
  const file = mcpConfigPathFor(agent);

  const doc = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'stdio',
        command,
        args: [...args, '--agent', agent.name, '--config', configFile ?? config.configFile],
        env: {},
      },
    },
  };

  // T5: JSON.stringify does the backslash escaping, which is why nothing here
  // builds JSON by concatenation.
  await writeText(file, JSON.stringify(doc, null, 2) + '\n');
  return file;
}
