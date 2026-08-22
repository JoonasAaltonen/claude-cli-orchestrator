#!/usr/bin/env node
/**
 * Entry point for the MCP server, spawned by the Claude Code CLI — never by a human.
 *
 * It is its own binary rather than an `orchestrator mcp` subcommand because the CLI
 * launches it with the *agent's* working directory and a minimal environment. Fewer
 * layers between the process start and the stdio loop is fewer things that can write
 * a stray byte to stdout, and a stray byte on stdout is a protocol error.
 */
import process from 'node:process';
import { main } from './server.js';

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`orchestrator mcp: ${err?.stack ?? String(err)}\n`);
  process.exit(1);
});
