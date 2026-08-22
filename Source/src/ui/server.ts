/**
 * The operator dashboard's HTTP server.
 *
 * This is the one place the application binds a port, and it is the decision §14
 * left open. Two things make it defensible rather than a hole:
 *
 *   - **Loopback only.** `ports.bindAddress` is 127.0.0.1 and is passed to
 *     `listen`, so the socket is not reachable from the network at all.
 *   - **A token**, because N4 is right that loopback authenticates nobody. This
 *     server can invoke agents and spend money; "a local process did it" is not an
 *     authorisation.
 *
 * Hand-rolled on `node:http` for the same reason the MCP server is hand-rolled:
 * the whole surface is a static page and a handful of JSON reads, and a framework
 * would be a dependency to audit for no behaviour gained.
 */
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { appRoot } from '../config/load.js';
import type { Config } from '../config/load.js';
import { readTextIfExists } from '../util/fsx.js';
import { tokenMatches } from './token.js';
import { agentsPayload, ledgerPayload, logPayload, statusPayload, threadPayload } from './api.js';
import { BadRequest, clearKillSwitch, dispatchAgent, setKillSwitch, writeRow } from './actions.js';
import { currentRun, runSnapshot, startRun, subscribe } from './runner.js';
import { WriterLockHeld } from '../ledger/lock.js';

export function pagePath(): string {
  return path.join(appRoot(), 'templates', 'ui', 'index.html');
}

/**
 * A browser will happily resolve an attacker-controlled hostname to 127.0.0.1 and
 * then talk to this server with the page's own origin. The token already stops the
 * request being *useful*, but rejecting a foreign Host costs one comparison and
 * removes the class entirely.
 */
function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

function send(res: http.ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    // The page is entirely self-contained, so nothing legitimate loads from
    // elsewhere and everything else can be refused outright.
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

export interface UiServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startUiServer(config: Config, token: string, port: number): Promise<UiServer> {
  const server = http.createServer((req, res) => {
    void handle(config, token, req, res).catch((err: unknown) => {
      // A failed read is worth seeing on screen rather than as a dead panel.
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, config.ports.bindAddress, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const actual = (server.address() as AddressInfo).port;
  return {
    port: actual,
    url: `http://127.0.0.1:${actual}/?t=${encodeURIComponent(token)}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function handle(
  config: Config,
  token: string,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  if (!hostAllowed(req.headers.host)) {
    send(res, 403, 'Forbidden: this server answers on loopback only.', 'text/plain; charset=utf-8');
    return;
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const supplied = url.searchParams.get('t') ?? headerToken(req);
  if (!tokenMatches(token, supplied ?? undefined)) {
    send(
      res,
      401,
      'Not authorised. Start the dashboard with `orchestrator ui --open`, or use the URL it prints.',
      'text/plain; charset=utf-8'
    );
    return;
  }

  if (req.method === 'POST') {
    await handlePost(config, url, req, res);
    return;
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: `${req.method} is not supported.` });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = await readTextIfExists(pagePath());
    if (html === null) {
      send(res, 500, `The dashboard page is missing: ${pagePath()}`, 'text/plain; charset=utf-8');
      return;
    }
    send(res, 200, html, 'text/html; charset=utf-8');
    return;
  }

  switch (url.pathname) {
    case '/api/status':
      sendJson(res, 200, await statusPayload(config));
      return;
    case '/api/ledger':
      sendJson(res, 200, await ledgerPayload(config));
      return;
    case '/api/agents':
      sendJson(res, 200, await agentsPayload(config));
      return;
    case '/api/log':
      sendJson(res, 200, await logPayload(config));
      return;
    case '/api/run':
      // The console survives a page reload: the snapshot carries every line so far.
      sendJson(res, 200, { run: runSnapshot(currentRun()) });
      return;
    case '/api/run/stream':
      streamRun(res);
      return;
    case '/api/thread': {
      const id = url.searchParams.get('id');
      if (!id) {
        sendJson(res, 400, { error: 'id is required' });
        return;
      }
      const payload = await threadPayload(config, id);
      if (!payload) {
        sendJson(res, 404, { error: `No thread contains ${id}` });
        return;
      }
      sendJson(res, 200, payload);
      return;
    }
    default:
      sendJson(res, 404, { error: `No such endpoint: ${url.pathname}` });
  }
}

function headerToken(req: http.IncomingMessage): string | null {
  const h = req.headers['x-orchestrator-token'];
  if (typeof h === 'string') return h;
  if (Array.isArray(h) && h[0]) return h[0];
  return null;
}

/** Bodies here are small forms; a cap stops a stuck client holding memory. */
const MAX_BODY = 256 * 1024;

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new BadRequest('Request body too large.');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new BadRequest('Body was not valid JSON.');
  }
}

/**
 * Server-sent events for a run in progress.
 *
 * Replays the whole buffered log before subscribing, so opening the page halfway
 * through a run shows the run rather than its tail. EventSource reconnects on its
 * own, and a reconnect that replays is correct here — the lines are a transcript,
 * not a queue.
 */
function streamRun(res: http.ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const write = (ev: unknown): void => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  const session = currentRun();
  if (!session) {
    write({ type: 'idle' });
    res.end();
    return;
  }

  for (const line of session.lines) write({ type: 'log', text: line });
  if (session.done) {
    write(
      session.error
        ? { type: 'error', error: session.error }
        : { type: 'done', outcomes: session.outcomes, costUsd: session.costUsd }
    );
    res.end();
    return;
  }

  const unsubscribe = subscribe(session, (ev) => {
    write(ev);
    if (ev.type === 'done' || ev.type === 'error') {
      unsubscribe();
      res.end();
    }
  });

  // A comment frame every 20s keeps intermediaries and the browser from deciding
  // a quiet invocation is a dead connection.
  const beat = setInterval(() => res.write(': keep-alive\n\n'), 20_000);
  res.on('close', () => {
    clearInterval(beat);
    unsubscribe();
  });
  res.on('finish', () => clearInterval(beat));
}

async function handlePost(
  config: Config,
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  try {
    const body = await readJsonBody(req);

    switch (url.pathname) {
      case '/api/write': {
        const { row, messageFile, budget } = await writeRow(config, body);
        sendJson(res, 200, { row, messageFile, budget });
        return;
      }
      case '/api/run': {
        const session = await startRun(config, { sweepFirst: !!body.sweep });
        sendJson(res, 202, { run: runSnapshot(session) });
        return;
      }
      case '/api/dispatch': {
        const agent = String(body.agent ?? '');
        if (!agent) throw new BadRequest('agent is required.');
        const outcome = await dispatchAgent(config, agent, !!body.dryRun);
        sendJson(res, 200, { outcome });
        return;
      }
      case '/api/stop': {
        const file = await setKillSwitch(config, String(body.reason ?? ''));
        sendJson(res, 200, { killed: true, file });
        return;
      }
      case '/api/resume': {
        const file = await clearKillSwitch(config);
        sendJson(res, 200, { killed: false, file });
        return;
      }
      default:
        sendJson(res, 404, { error: `No such endpoint: ${url.pathname}` });
    }
  } catch (err: unknown) {
    if (err instanceof BadRequest) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    // 409 rather than 500: nothing is wrong, something else is holding the ledger.
    if (err instanceof WriterLockHeld) {
      sendJson(res, 409, { error: err.message, holder: err.info, lockFile: err.file });
      return;
    }
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}
