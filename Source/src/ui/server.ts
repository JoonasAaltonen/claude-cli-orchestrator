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
import { agentsPayload, ledgerPayload, logPayload, metaPayload, statusPayload, threadPayload } from './api.js';
import {
  BadRequest,
  addRosterAgent,
  clearKillSwitch,
  dispatchAgent,
  installContract,
  removeRosterAgent,
  setKillSwitch,
  updateRosterAgent,
  writeRow,
} from './actions.js';
import { currentRun, runSnapshot, startRun, subscribe } from './runner.js';
import { listDirectory } from './fsbrowse.js';
import { WriterLockHeld } from '../ledger/lock.js';
import { logProblem } from '../log/problems.js';

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

/**
 * What a failing response said, kept until the response finishes.
 *
 * Logging from inside `send` would report a status before the response is actually
 * out, and logging from every error branch means one branch will eventually be
 * added without it. One hook on `finish` covers all of them — including the 404 and
 * the 405, which no branch would have bothered to log — and this map is only how the
 * message gets from the branch to the hook.
 */
const failureNote = new WeakMap<http.ServerResponse, { what?: string; detail?: string }>();

function noteFailure(res: http.ServerResponse, patch: { what?: string; detail?: string }): void {
  failureNote.set(res, { ...failureNote.get(res), ...patch });
}

function send(res: http.ServerResponse, status: number, body: string, type: string): void {
  if (status >= 400) noteFailure(res, { what: firstOf(body) });

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

/** An error body reads better in a log as its message than as its JSON. */
function firstOf(body: string): string {
  if (body.startsWith('{')) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === 'string') return parsed.error;
    } catch {
      /* not JSON after all — the raw text is the message */
    }
  }
  return body;
}

export interface UiServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * The configuration the handlers see, in a box.
 *
 * A box rather than a closed-over value, because the dashboard can now edit the
 * roster and the edit has to be visible to the next request. A box rather than a
 * module-level variable, because that would be shared by every server started in one
 * process — fine for the single dashboard `orchestrator ui` runs, wrong the moment
 * anything starts two.
 *
 * `loadConfig` is where the cross-checks and the derived paths live, so every edit
 * replaces `config` wholesale with what came back from disk — never a field patched
 * in place.
 */
interface Live {
  config: Config;
}

export async function startUiServer(config: Config, token: string, port: number): Promise<UiServer> {
  const live: Live = { config };
  const server = http.createServer((req, res) => {
    // Every response that fails is reported once, here, when it is actually sent.
    // The dashboard shows the operator one line beside a button; this is the copy
    // that reaches the terminal and the log, with the stack the page never sees.
    res.once('finish', () => {
      if (res.statusCode < 400) return;
      const note = failureNote.get(res) ?? {};
      logProblem({
        source: 'server',
        what: note.what ?? `${res.statusCode}`,
        where: `${req.method ?? '?'} ${(req.url ?? '/').split('?')[0]}`,
        status: res.statusCode,
        detail: note.detail ?? null,
      });
    });

    void handle(live, token, req, res).catch((err: unknown) => {
      // A failed read is worth seeing on screen rather than as a dead panel — and
      // the stack is kept here because this is the only place it exists.
      noteFailure(res, { detail: err instanceof Error ? (err.stack ?? null) ?? undefined : undefined });
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

/**
 * A ceiling on browser reports, because the reporter is a loop away from being the
 * problem: one thrown error inside a render that runs on a timer would otherwise
 * append to the log forever. Sixty a minute is far more than a person generates and
 * far less than a loop does.
 */
const CLIENT_ERROR_LIMIT = 60;
let clientErrorWindow = { startedAt: 0, count: 0 };

function clientErrorsAllowed(): boolean {
  const now = Date.now();
  if (now - clientErrorWindow.startedAt > 60_000) clientErrorWindow = { startedAt: now, count: 0 };
  clientErrorWindow.count += 1;
  if (clientErrorWindow.count === CLIENT_ERROR_LIMIT + 1) {
    logProblem({
      source: 'server',
      what: `The dashboard reported more than ${CLIENT_ERROR_LIMIT} errors in a minute — the rest of this minute is not logged.`,
      where: 'POST /api/client-error',
    });
  }
  return clientErrorWindow.count <= CLIENT_ERROR_LIMIT;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

async function handle(
  live: Live,
  token: string,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  if (!hostAllowed(req.headers.host)) {
    send(res, 403, 'Forbidden: this server answers on loopback only.', 'text/plain; charset=utf-8');
    return;
  }

  const config = live.config;
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
    await handlePost(live, url, req, res);
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
    // The vocabulary the page builds its menus from. Static for the life of the
    // process — it is derived from constants — so it is fetched once and kept.
    case '/api/meta':
      sendJson(res, 200, metaPayload());
      return;
    case '/api/fs': {
      // A picker, not a file browser: directory names only, never contents.
      const at = url.searchParams.get('path');
      sendJson(res, 200, await listDirectory(at && at.trim() ? at : null));
      return;
    }
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

/**
 * Roster edits are refused mid-run.
 *
 * Not for the config file's sake — that write is atomic enough. It is that
 * `buildPermissionPlan` runs per dispatch from the roster, so a change landing
 * between two dispatches in one loop would give the second half of a chain different
 * boundaries from the first, with nothing in the ledger saying so.
 */
function requireIdle(what: string): void {
  const session = currentRun();
  if (session && !session.done) {
    throw new BadRequest(`A run is in progress. Wait for it to finish, or stop it, before you ${what} — an agent's boundaries are computed per dispatch and would change underneath it.`);
  }
}

async function handlePost(
  live: Live,
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const config = live.config;

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
      // The page's own failures, reported by the page. This is the half that was
      // missing: a TypeError in the dashboard never reached the server at all, so
      // the only trace of it was one line of red text beside a button and whatever
      // the operator happened to have devtools open for.
      case '/api/client-error': {
        if (clientErrorsAllowed()) {
          logProblem({
            source: 'browser',
            what: String((body as Record<string, unknown>).what ?? 'unknown error'),
            where: str((body as Record<string, unknown>).where),
            status: null,
            detail: str((body as Record<string, unknown>).detail),
          });
        }
        // Always 204, even when throttled. A page that gets an error back from
        // reporting an error is a page that reports it again.
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
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

      // ---- the roster -----------------------------------------------------
      //
      // Each of these replaces `live` with the config that came back from disk, so
      // the next request sees the edit. The guard is shared: an agent's write
      // scoping is computed at dispatch from the roster, and editing the roster
      // while a run is in flight would mean a plan built from one configuration and
      // an agent already running under another.
      case '/api/agents/add': {
        requireIdle('add an agent');
        const { config: next, agent, warnings, installed } = await addRosterAgent(config, body);
        live.config = next;
        sendJson(res, 200, { agent: agent.name, home: agent.home, outbox: agent.outbox, warnings, installed });
        return;
      }
      case '/api/agents/update': {
        requireIdle('change an agent');
        const { config: next, agent } = await updateRosterAgent(config, body);
        live.config = next;
        sendJson(res, 200, { agent: agent.name });
        return;
      }
      case '/api/agents/remove': {
        requireIdle('remove an agent');
        const { config: next, removed } = await removeRosterAgent(config, body);
        live.config = next;
        sendJson(res, 200, { removed: removed.name, home: removed.home });
        return;
      }
      // One agent, or every agent — `agent protocol --install` and `agent skills
      // --install`, with `--all` and `--force` behind the same endpoint.
      //
      // Idle for the same reason a roster edit is, and it is not a formality here:
      // `ledger-invocation` is injected into the prompt at dispatch, so replacing it
      // between two invocations of one run would hand the second half of a chain
      // different delivery instructions from the first, with nothing saying so.
      case '/api/agents/install': {
        requireIdle('reinstall the protocol and skills');
        const installed = await installContract(config, body);
        sendJson(res, 200, installed);
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
    noteFailure(res, { detail: err instanceof Error ? err.stack ?? undefined : undefined });
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}
