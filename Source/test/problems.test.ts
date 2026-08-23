/**
 * Errors reaching somewhere an operator will find them.
 *
 * The failure this exists for: the dashboard refused a registration with
 * `Cannot read properties of null (reading 'value')` and that string existed in
 * exactly one place — a span next to the button. Nothing was in the terminal, no
 * file was written, and the operator had to ask what the dashboard even logs.
 *
 * So both halves are asserted here: a failing response is recorded server-side with
 * the request that caused it, and a failure inside the page is recorded when the
 * page posts it. Neither may throw into the path that reported it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadConfig } from '../src/config/load.js';
import type { Config } from '../src/config/load.js';
import { initCommsRoot } from '../src/ledger/store.js';
import { startUiServer } from '../src/ui/server.js';
import type { UiServer } from '../src/ui/server.js';
import {
  startProblemLog,
  stopProblemLog,
  logProblem,
  readProblems,
  flushProblemLog,
  problemLogPath,
} from '../src/log/problems.js';

const TOKEN = 'test-token';
let n = 0;

async function scratch(): Promise<{ config: Config; base: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `orch-problems-${n++}-`));
  const home = path.join(base, 'agents', 'worker');
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, 'CLAUDE.md'), '# worker\n');
  const configFile = path.join(base, 'orchestrator.config.json');
  await fs.writeFile(
    configFile,
    JSON.stringify({ commsRoot: path.join(base, 'comms'), agents: [{ name: 'worker', home }] })
  );
  const config = await loadConfig(configFile);
  await initCommsRoot(config);
  return { config, base };
}

async function serve(config: Config): Promise<UiServer> {
  return startUiServer(config, TOKEN, 0);
}

/** stderr is captured, because "it prints" is half of what is being claimed. */
async function capturingStderr<T>(fn: () => Promise<T>): Promise<{ result: T; err: string }> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as NodeJS.WriteStream).write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, err: chunks.join('') };
  } finally {
    (process.stderr as NodeJS.WriteStream).write = original;
  }
}

test('a problem is printed to stderr and appended to the log', async () => {
  const { config } = await scratch();
  startProblemLog(config);
  try {
    const { err } = await capturingStderr(async () => {
      logProblem({
        source: 'browser',
        what: "Cannot read properties of null (reading 'value')",
        where: 'roster add',
        detail: 'TypeError: ...\n    at readPathRows (index.html:559:41)',
      });
      await flushProblemLog();
    });

    // The console the orchestrator was started in.
    assert.match(err, /Cannot read properties of null/);
    assert.match(err, /roster add/);
    assert.match(err, /readPathRows/, 'the stack is the part the page could not show');

    // And the file, for what happened while nobody was watching.
    const recorded = await readProblems(config);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.source, 'browser');
    assert.equal(recorded[0]!.where, 'roster add');
    assert.ok(recorded[0]!.at, 'every record is timestamped');
    assert.ok(problemLogPath(config).endsWith('problems.jsonl'));
  } finally {
    stopProblemLog();
  }
});

test('with no log file configured it still prints, and writes nothing', async () => {
  const { config } = await scratch();
  stopProblemLog();
  const { err } = await capturingStderr(async () => {
    logProblem({ source: 'server', what: 'no sink configured' });
  });
  assert.match(err, /no sink configured/);
  assert.deepEqual(await readProblems(config), [], 'a one-shot command creates no log file');
});

test('every failing response is recorded with the request that caused it', async () => {
  const { config } = await scratch();
  startProblemLog(config);
  const s = await serve(config);
  try {
    await capturingStderr(async () => {
      // A refusal the operator caused, a route that does not exist, and a bad token.
      await fetch(`http://127.0.0.1:${s.port}/api/write?t=${TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'nobody-at-all', summary: 'x', body: 'y' }),
      });
      await fetch(`http://127.0.0.1:${s.port}/api/nonsense?t=${TOKEN}`);
      await fetch(`http://127.0.0.1:${s.port}/api/status?t=wrong`);
      await flushProblemLog();
    });

    const recorded = await readProblems(config);
    assert.deepEqual(
      recorded.map((p) => p.status),
      [400, 404, 401],
      'all three, in the order they happened'
    );
    assert.equal(recorded[0]!.where, 'POST /api/write');
    assert.match(recorded[0]!.what, /nobody-at-all/, 'the message, not just the status');
    assert.equal(recorded[1]!.where, 'GET /api/nonsense');
    for (const p of recorded) assert.equal(p.source, 'server');
  } finally {
    await s.close();
    stopProblemLog();
  }
});

test('a successful response records nothing', async () => {
  const { config } = await scratch();
  startProblemLog(config);
  const s = await serve(config);
  try {
    await capturingStderr(async () => {
      const r = await fetch(`http://127.0.0.1:${s.port}/api/status?t=${TOKEN}`);
      assert.equal(r.status, 200);
      await flushProblemLog();
    });
    assert.deepEqual(await readProblems(config), [], 'the log is for failures only');
  } finally {
    await s.close();
    stopProblemLog();
  }
});

test('the page can report its own error, and is answered without one', async () => {
  const { config } = await scratch();
  startProblemLog(config);
  const s = await serve(config);
  try {
    const { result } = await capturingStderr(async () => {
      const r = await fetch(`http://127.0.0.1:${s.port}/api/client-error?t=${TOKEN}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          what: "Cannot read properties of null (reading 'value')",
          where: 'roster add',
          detail: 'TypeError\n    at readPathRows',
        }),
      });
      await flushProblemLog();
      return r;
    });

    // 204, because a page that gets an error back from reporting an error reports
    // that too, and the loop is worse than the original fault.
    assert.equal(result.status, 204);

    const recorded = await readProblems(config);
    assert.equal(recorded.length, 1, 'the report itself must not also log a failure');
    assert.equal(recorded[0]!.source, 'browser');
    assert.match(recorded[0]!.detail ?? '', /readPathRows/);
  } finally {
    await s.close();
    stopProblemLog();
  }
});

test('a flood of browser reports is capped rather than allowed to fill the log', async () => {
  const { config } = await scratch();
  startProblemLog(config);
  const s = await serve(config);
  try {
    await capturingStderr(async () => {
      for (let i = 0; i < 75; i++) {
        await fetch(`http://127.0.0.1:${s.port}/api/client-error?t=${TOKEN}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ what: 'in a render loop ' + i }),
        });
      }
      await flushProblemLog();
    });

    const browser = (await readProblems(config)).filter((p) => p.source === 'browser');
    assert.ok(browser.length <= 60, `capped, got ${browser.length}`);
    assert.ok(browser.length >= 55, 'but not so eagerly that ordinary use is lost');
  } finally {
    await s.close();
    stopProblemLog();
  }
});
