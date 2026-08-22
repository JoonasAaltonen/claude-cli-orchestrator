/**
 * The MCP server, exercised over its real transport.
 *
 * These spawn the built server and speak newline-delimited JSON-RPC at it, rather
 * than calling the handler directly. The transport is hand-written, so the framing
 * and the notification handling are exactly the parts worth testing — a server that
 * answers `notifications/initialized` or writes a stray byte to stdout is a protocol
 * error the CLI reports as a failed connection with no reason attached.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { MCP_TOOL_ID, MCP_TOOL_NAME } from '../src/contract/names.js';

const SERVER = fileURLToPath(new URL('../src/mcp/main.ts', import.meta.url));

interface Fixture {
  root: string;
  configFile: string;
  outbox: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'orch-mcp-'));
  const home = path.join(root, 'agents', 'worker');
  const comms = path.join(root, 'comms');
  const outbox = path.join(home, 'outbox');
  await mkdir(outbox, { recursive: true });
  await mkdir(comms, { recursive: true });
  await writeFile(path.join(home, 'CLAUDE.md'), '# worker\n');

  const configFile = path.join(root, 'orchestrator.config.json');
  await writeFile(
    configFile,
    JSON.stringify({ commsRoot: comms, agents: [{ name: 'worker', home }] }, null, 2)
  );
  return { root, configFile, outbox };
}

/** Sends a batch of requests, returns the responses keyed by id. */
function converse(configFile: string, requests: unknown[]): Promise<Map<number, any>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', SERVER, '--agent', 'worker', '--config', configFile],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const responses = new Map<number, any>();
    let buffer = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        // Any non-JSON line on stdout is itself a failure worth surfacing.
        const msg = JSON.parse(line);
        if (typeof msg.id === 'number') responses.set(msg.id, msg);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', () => resolve(responses));

    for (const r of requests) child.stdin.write(JSON.stringify(r) + '\n');
    child.stdin.end();

    setTimeout(() => {
      child.kill();
      reject(new Error(`timed out; stderr: ${stderr}`));
    }, 30_000).unref();
  });
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } };
/** No id: a notification. Answering it would be the protocol error. */
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };

function call(id: number, args: unknown) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name: MCP_TOOL_NAME, arguments: args } };
}

test('it initializes, echoes the protocol version, and never answers a notification', async () => {
  const f = await fixture();
  try {
    const res = await converse(f.configFile, [INIT, INITIALIZED, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    assert.equal(res.get(1)?.result?.protocolVersion, '2024-11-05');
    assert.equal(res.get(1)?.result?.serverInfo?.name, 'orchestrator');
    // The notification had no id, so it cannot have produced a numbered response.
    assert.equal(res.size, 2, 'exactly two responses for two requests plus one notification');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('tools/list offers exactly the one tool, under the name the prompt refers to', async () => {
  const f = await fixture();
  try {
    const res = await converse(f.configFile, [INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    const tools = res.get(2)?.result?.tools;
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, MCP_TOOL_NAME);
    assert.equal(`mcp__orchestrator__${tools[0].name}`, MCP_TOOL_ID);
    for (const field of ['to', 'type', 'summary', 'body']) {
      assert.ok(tools[0].inputSchema.properties[field], `${field} must be in the schema`);
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a valid call writes one parseable file into the outbox and nowhere else', async () => {
  const f = await fixture();
  try {
    const res = await converse(f.configFile, [
      INIT,
      call(2, {
        to: ['operator'],
        type: 'report',
        // Every one of these bounced or would have bounced under the old contract.
        summary: 'Q3: revenue up 12%; margin flat — see the "notes" section',
        body: 'The full body, with a path C:\\YourDirectory\\x and a `fence` in it.',
      }),
    ]);
    assert.equal(res.get(2)?.result?.isError, false, JSON.stringify(res.get(2)));

    const files = await readdir(f.outbox);
    assert.equal(files.length, 1);
    const text = await readFile(path.join(f.outbox, files[0]!), 'utf8');

    const { parseMessageText } = await import('../src/ledger/message.js');
    const parsed = parseMessageText(text, files[0]!);
    assert.equal(parsed.ok, true, parsed.errors.join('; '));
    // The application wrote it, so it must not need the lenient reader — that path
    // exists for text an agent typed, and its use here would mean we emit bad YAML.
    assert.notEqual(parsed.lenient, true);
    assert.equal(parsed.draft?.summary, 'Q3: revenue up 12%; margin flat — see the "notes" section');
    assert.ok(parsed.draft?.body.includes('C:\\YourDirectory\\x'));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('a bad call is rejected in-session with the reason, and writes nothing', async () => {
  const f = await fixture();
  try {
    const res = await converse(f.configFile, [
      INIT,
      // outcome is required on a response, and replyTo names nothing.
      call(2, { to: ['operator'], type: 'response', replyTo: '0009', summary: 'x', body: 'y' }),
      // D3 — a message addressed to its own writer cannot exist.
      call(3, { to: ['worker'], type: 'report', summary: 'x', body: 'y' }),
      call(4, { to: ['operator'], type: 'reponse', summary: 'x', body: 'y' }),
    ]);

    for (const id of [2, 3, 4]) {
      assert.equal(res.get(id)?.result?.isError, true, `call ${id} should have been rejected`);
    }
    assert.match(res.get(2).result.content[0].text, /replyTo/);
    assert.match(res.get(3).result.content[0].text, /yourself/);
    assert.match(res.get(4).result.content[0].text, /report, request, response/);

    // M7's whole cost is that a bounce needs another invocation. Nothing may be
    // written here, or the sweep would append the malformed message anyway.
    assert.deepEqual(await readdir(f.outbox), []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('it takes what models actually send: a bare string for a list, a number for an ID', async () => {
  const f = await fixture();
  try {
    // A ledger with one row, so replyTo has something real to point at.
    const res = await converse(f.configFile, [
      INIT,
      call(2, { to: 'operator', type: 'report', summary: 'coerced', body: 'A body.' }),
    ]);
    assert.equal(res.get(2)?.result?.isError, false, JSON.stringify(res.get(2)));

    const files = await readdir(f.outbox);
    const text = await readFile(path.join(f.outbox, files[0]!), 'utf8');
    assert.match(text, /^to: operator$/m);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('an unknown method gets an error, not silence', async () => {
  const f = await fixture();
  try {
    const res = await converse(f.configFile, [INIT, { jsonrpc: '2.0', id: 2, method: 'nonsense/method' }]);
    assert.equal(res.get(2)?.error?.code, -32601);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
