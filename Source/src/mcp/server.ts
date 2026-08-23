/**
 * The MCP server an agent calls to deliver its reply.
 *
 * T6 puts the message file format in the expensive column: "every agent satisfies it
 * from prose instructions, and agents get formats wrong". Everything upstream of this
 * file is damage control for that — the lenient frontmatter reader, the M7 bounce,
 * the protocol document. This removes the cause instead: the agent supplies *fields*,
 * and the application writes the file. There is no format for the agent to get wrong
 * because the agent never writes one.
 *
 * The second gain is the one that actually saves quota. A bounce (M7) is a cold
 * invocation spent discovering the message was malformed and another spent fixing
 * it. A rejected tool call returns the same reasons *inside the same session*, while
 * the agent still has its context, and it can correct and call again for free.
 *
 * What this deliberately does NOT do is write to the ledger. It writes a message file
 * into the agent's own outbox and stops. The sweep still owns the append, so:
 *
 *   - L2's single writer is untouched. Two processes appending to the index
 *     concurrently is exactly the corruption the single-writer rule exists to
 *     prevent, and an MCP server runs as a child of the agent, not of the dispatcher.
 *   - The outbox sweep stays the one path into the index, so an agent that ignores
 *     this tool and writes a file by hand still works. That fallback is the reason
 *     this can be adopted without betting the system on it.
 *
 * Transport is newline-delimited JSON-RPC on stdio, implemented directly rather than
 * through the MCP SDK. The surface is three methods and the framing is one line per
 * message; a dependency would be more code to audit than the protocol it speaks.
 *
 * **stdio contradicts §14, which calls loopback HTTP a forced choice.** Its reason is
 * a server that owns the index, which this one does not — see deviation 1.8 in
 * docs/spec-deviations.md for the full argument. The short version: under stdio the
 * orchestrator sets `--agent` at spawn time and the agent cannot influence it, so the
 * process boundary is the identity boundary. Under a shared HTTP server the agent
 * would have to state who it is, and N4 says loopback authenticates nobody.
 *
 * If this server ever writes the index or holds state shared across agents, §14
 * applies in full and the transport must change.
 *
 * Nothing but JSON-RPC may go to stdout. Diagnostics go to stderr.
 */
import process from 'node:process';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, findAgent } from '../config/load.js';
import type { Agent, Config } from '../config/load.js';
import { MESSAGE_TYPES, MESSAGE_TYPE_INFO, OUTCOMES } from '../ledger/row.js';
import { parseMessageText, renderMessageFile } from '../ledger/message.js';
import type { MessageDraft } from '../ledger/message.js';
import { readIndex } from '../ledger/store.js';
import { writeText, ensureDir } from '../util/fsx.js';
import { MCP_SERVER_NAME, MCP_TOOL_NAME } from '../contract/names.js';

const SERVER_NAME = MCP_SERVER_NAME;
const TOOL_NAME = MCP_TOOL_NAME;
const SERVER_VERSION = '0.1.0';
const DEFAULT_PROTOCOL = '2024-11-05';

interface Request {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
}

const TOOL_SCHEMA = {
  name: TOOL_NAME,
  description: [
    'Deliver your reply to the orchestrator ledger. This is how your work reaches',
    'whoever is waiting for it — a reply that is only in your chat output is not',
    'recorded and nobody receives it.',
    '',
    'Call this exactly once, when the work is finished. Put the full result in `body`.',
    'If any field is wrong the call is rejected with the specific reason and you can',
    'correct it and call again immediately.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      to: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description:
          'Who should receive this. Agent names as they appear in the roster you were shown, or "operator" for the human. Usually one name.',
      },
      type: {
        type: 'string',
        enum: [...MESSAGE_TYPES],
        // Generated from the one description of each type. Hand-written copies of
        // this list went stale the first time a type was added.
        description: MESSAGE_TYPES.map((t) => {
          const info = MESSAGE_TYPE_INFO[t];
          const needs = [
            info.replyTo === 'required' ? 'replyTo' : null,
            info.outcome === 'required' ? 'outcome' : null,
          ].filter(Boolean);
          return `${t} — ${info.what}${needs.length ? ` (needs ${needs.join(' and ')})` : ''}`;
        }).join('\n'),
      },
      replyTo: {
        type: 'string',
        description:
          'The four-digit ID of the message you are answering, exactly as it appeared in the thread, e.g. "0003". Required on a response or signoff.',
      },
      needs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional. Names of anyone whose input is still outstanding before this can move on.',
      },
      outcome: {
        type: 'string',
        enum: [...OUTCOMES],
        description:
          'Required on a response or signoff, and forbidden on anything else. A "rejected" outcome must say in the body exactly what would make it pass.',
      },
      summary: {
        type: 'string',
        description:
          'One line saying what this message is, for the ledger index. Any punctuation is fine. Long summaries are shortened rather than refused.',
      },
      body: {
        type: 'string',
        description:
          'The actual content — the work, the answer, the request in full. This is what the recipient reads. Markdown is fine.',
      },
    },
    required: ['to', 'type', 'summary', 'body'],
  },
} as const;

export async function main(argv: string[]): Promise<void> {
  const agentName = flag(argv, '--agent') ?? process.env['ORCHESTRATOR_AGENT'];
  const configFile = flag(argv, '--config') ?? process.env['ORCHESTRATOR_CONFIG'];

  if (!agentName) {
    process.stderr.write('orchestrator mcp: --agent is required\n');
    process.exit(2);
  }

  let config: Config;
  let agent: Agent;
  try {
    config = await loadConfig(configFile);
    const found = findAgent(config, agentName);
    if (!found) throw new Error(`"${agentName}" is not in the roster in ${config.configFile}`);
    agent = found;
  } catch (err: any) {
    // Exiting here would leave the CLI reporting a failed MCP connection with no
    // reason. Staying up and failing every call with the reason is more useful.
    process.stderr.write(`orchestrator mcp: ${err?.message ?? String(err)}\n`);
    process.exit(2);
    return;
  }

  await ensureDir(agent.outbox);
  process.stderr.write(`orchestrator mcp: serving "${agent.name}", outbox ${agent.outbox}\n`);

  // Requests are handled concurrently, so a close has to wait for what is in flight.
  // Exiting on `end` alone loses the response to a call still writing its file —
  // measured, not theorised: the client sees the connection drop where it expected a
  // result, which is indistinguishable from a tool that silently did nothing.
  const inFlight = new Set<Promise<void>>();

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const p = handleLine(line, config, agent);
      inFlight.add(p);
      void p.finally(() => inFlight.delete(p));
    }
  });
  process.stdin.on('end', () => {
    void (async () => {
      // A handler can enqueue nothing further, but it can still be settling when the
      // first pass drains, so this loops rather than awaiting once.
      while (inFlight.size) await Promise.allSettled([...inFlight]);
      process.exit(0);
    })();
  });
}

async function handleLine(line: string, config: Config, agent: Agent): Promise<void> {
  let req: Request;
  try {
    req = JSON.parse(line);
  } catch {
    return; // A line that is not JSON has no id to answer to.
  }

  // A notification has no id and takes no response. `notifications/initialized`
  // arrives on every connection, and replying to it is a protocol error.
  const isNotification = req.id === undefined || req.id === null;

  try {
    switch (req.method) {
      case 'initialize':
        return send(req.id, {
          protocolVersion: typeof req.params?.protocolVersion === 'string' ? req.params.protocolVersion : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });

      case 'tools/list':
        return send(req.id, { tools: [TOOL_SCHEMA] });

      case 'tools/call': {
        if (req.params?.name !== TOOL_NAME) {
          return sendError(req.id, -32602, `Unknown tool: ${req.params?.name}`);
        }
        const outcome = await submit(config, agent, req.params?.arguments ?? {});
        return send(req.id, {
          content: [{ type: 'text', text: outcome.text }],
          isError: !outcome.ok,
        });
      }

      case 'ping':
        return send(req.id, {});

      default:
        if (isNotification) return;
        return sendError(req.id, -32601, `Method not found: ${req.method}`);
    }
  } catch (err: any) {
    if (!isNotification) sendError(req.id, -32603, err?.message ?? String(err));
  }
}

/**
 * The whole point of the tool, and the one place worth being careful.
 *
 * Validation is done by rendering the fields into a message file and running the
 * *existing* parser over it. Reimplementing the rules here would let the two paths
 * drift, and the drift would be silent: the MCP path would accept something the
 * sweep later rejects, which is the M7 bounce we are trying to eliminate, arriving
 * by a longer route.
 */
async function submit(
  config: Config,
  agent: Agent,
  args: any
): Promise<{ ok: boolean; text: string }> {
  const draft = coerce(args);

  // D3 — a row cannot be dispatched back to its own writer, so it must not be
  // possible to create one. Caught here rather than at the sweep so the agent hears
  // about it while it can still act.
  if (draft.to.includes(agent.name)) {
    return reject([
      `to: you addressed this to yourself ("${agent.name}"). Address it to whoever should act on it next, or to "operator" if it is finished and a human should see it.`,
    ]);
  }

  // A replyTo that names nothing is the single most common way a message fails
  // validation, and it is answerable from the index without spending anything.
  if (draft.replyTo) {
    const { rows } = await readIndex(config);
    if (!rows.some((r) => r.id === draft.replyTo)) {
      const recent = rows.slice(-6).map((r) => `${r.id} (${r.type} from ${r.writer})`);
      return reject([
        `replyTo: "${draft.replyTo}" is not a message in the ledger.`,
        recent.length ? `The most recent are: ${recent.join(', ')}` : 'The ledger is empty.',
      ]);
    }
  }

  const rendered = renderMessageFile(draft);
  const check = parseMessageText(rendered, '<mcp>');
  if (!check.ok || !check.draft) return reject(check.errors);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(
    agent.outbox,
    `${stamp}-${crypto.randomBytes(2).toString('hex')}.md`
  );
  await writeText(file, renderMessageFile(check.draft));

  return {
    ok: true,
    text: [
      'Delivered. Your message is queued for the ledger and will be appended when this',
      'invocation ends, then shown to everyone you addressed it to.',
      '',
      `  to      ${check.draft.to.join(', ')}`,
      `  type    ${check.draft.type}${check.draft.outcome ? ` (${check.draft.outcome})` : ''}`,
      `  summary ${check.draft.summary}`,
      '',
      'Nothing further is needed. Do not write a message file by hand as well — that',
      'would enter the ledger a second time.',
    ].join('\n'),
  };
}

function reject(errors: string[]): { ok: boolean; text: string } {
  return {
    ok: false,
    text: [
      'Not delivered. Nothing was written, and nothing is waiting on a retry, so fix',
      'these and call the tool again:',
      '',
      ...errors.map((e) => `  - ${e}`),
    ].join('\n'),
  };
}

/**
 * Takes what the model actually sent rather than what the schema asked for.
 *
 * A JSON Schema is a description, not an enforcement: models send a bare string
 * where an array was specified, or "0003" as the number 3. Every coercion here is
 * one that has exactly one sensible reading. Anything ambiguous is left alone and
 * fails validation with a reason, which is the honest outcome.
 */
function coerce(args: any): MessageDraft {
  const list = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    if (typeof v === 'string') return v.split(/[+,]/).map((s) => s.trim()).filter(Boolean);
    return [];
  };

  const replyToRaw = args?.replyTo;
  const replyTo =
    replyToRaw === undefined || replyToRaw === null || replyToRaw === ''
      ? null
      : String(replyToRaw).trim();

  return {
    to: list(args?.to),
    type: String(args?.type ?? '').trim() as MessageDraft['type'],
    // The index pads to four digits, so an agent that sends 3 means 0003.
    replyTo: replyTo && /^\d+$/.test(replyTo) ? replyTo.padStart(4, '0') : replyTo,
    needs: list(args?.needs),
    outcome: (args?.outcome ? String(args.outcome).trim() : null) as MessageDraft['outcome'],
    summary: String(args?.summary ?? '').trim(),
    body: String(args?.body ?? '').trim(),
  };
}

function send(id: Request['id'], result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function sendError(id: Request['id'], code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : undefined;
}
