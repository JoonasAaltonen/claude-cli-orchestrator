/**
 * Resolving the CLI the way spawn resolves it.
 *
 * The case that matters is an npm install on Windows: the bin directory holds
 * `claude`, `claude.cmd` and `claude.ps1` and no executable at all. Spawn takes the
 * .cmd and fails with an error that names no file. A resolver that preferred the
 * extensionless entry would report "ok" for exactly the installation this exists to
 * catch, so the PATHEXT order is the substance of these tests, not a detail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { checkClaudeBin, resolveExecutable } from '../src/util/which.js';
import { writeText } from '../src/util/fsx.js';

const WIN = process.platform === 'win32';
let n = 0;

/** A directory placed alone on PATH, holding exactly the files named. */
async function binDir(files: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `orch-which-${n++}-`));
  for (const f of files) await writeText(path.join(dir, f), 'not a real program');
  return dir;
}

async function withPath<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = dir;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}

test('an npm-style bin directory resolves to the .cmd shim, not the bare file', async (t) => {
  if (!WIN) return t.skip('PATHEXT resolution is Windows-only');
  const dir = await binDir(['claude', 'claude.cmd', 'claude.ps1']);
  const c = await withPath(dir, () => checkClaudeBin('claude'));
  assert.equal(c.resolved, path.join(dir, 'claude.cmd'));
  assert.equal(c.kind, 'script-shim', 'this is the installation that cannot be dispatched');
});

test('a native install resolves to the executable and passes', async (t) => {
  if (!WIN) return t.skip('PATHEXT resolution is Windows-only');
  const dir = await binDir(['claude.exe']);
  const c = await withPath(dir, () => checkClaudeBin('claude'));
  assert.equal(c.resolved, path.join(dir, 'claude.exe'));
  assert.equal(c.kind, 'ok');
});

test('an executable beside a shim wins, because PATHEXT puts .exe first', async (t) => {
  if (!WIN) return t.skip('PATHEXT resolution is Windows-only');
  const dir = await binDir(['claude', 'claude.cmd', 'claude.exe']);
  const c = await withPath(dir, () => checkClaudeBin('claude'));
  assert.equal(c.extension, '.exe');
  assert.equal(c.kind, 'ok');
});

test('a full path to a shim is still a shim', async (t) => {
  if (!WIN) return t.skip('PATHEXT resolution is Windows-only');
  const dir = await binDir(['claude.cmd']);
  // Pointing the config at the shim is the obvious fix and the wrong one; it has to
  // be caught, not rewarded.
  const c = await checkClaudeBin(path.join(dir, 'claude.cmd'));
  assert.equal(c.kind, 'script-shim');
});

test('a full path to a real executable passes', async () => {
  const dir = await binDir([WIN ? 'claude.exe' : 'claude']);
  const c = await checkClaudeBin(path.join(dir, WIN ? 'claude.exe' : 'claude'));
  assert.equal(c.kind, 'ok');
});

test('nothing on PATH is reported as missing, not as broken', async () => {
  const dir = await binDir([]);
  const c = await withPath(dir, () => checkClaudeBin('claude'));
  assert.equal(c.resolved, null);
  assert.equal(c.kind, 'not-found');
});

test('the first PATH entry holding a match wins', async (t) => {
  if (!WIN) return t.skip('PATHEXT resolution is Windows-only');
  const first = await binDir(['claude.exe']);
  const second = await binDir(['claude.exe']);
  const saved = process.env.PATH;
  process.env.PATH = first + ';' + second;
  try {
    assert.equal(await resolveExecutable('claude'), path.join(first, 'claude.exe'));
  } finally {
    process.env.PATH = saved;
  }
});

test('the real claude on this machine is dispatchable', async () => {
  // Not a unit test so much as a standing check on the developer's own environment:
  // if this ever fails here, every dispatch is already failing.
  const c = await checkClaudeBin('claude');
  assert.notEqual(c.kind, 'script-shim', c.resolved + ' is a shim and cannot be spawned');
});
