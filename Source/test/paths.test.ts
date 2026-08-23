/**
 * Directories outside the home, and the picker that names them.
 *
 * The permission side of this is tested in permissions.test.ts. What is here is the
 * plumbing that decides *which* directories those rules get built from — the merge
 * of two config spellings into one list, and the browse endpoint that supplies the
 * paths in the first place.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promises as fs } from 'node:fs';
import { loadConfig } from '../src/config/load.js';
import type { Config } from '../src/config/load.js';
import { writeText } from '../src/util/fsx.js';
import { listDirectory, roots } from '../src/ui/fsbrowse.js';
import { pathWarnings, updateAgent } from '../src/roster/edit.js';
import { buildPermissionPlan } from '../src/dispatch/permissions.js';

let n = 0;

async function scratch(agentEntry: Record<string, unknown>): Promise<{ config: Config; base: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `orch-paths-${n++}-`));
  await fs.mkdir(path.join(base, 'agents', 'worker'), { recursive: true });
  await writeText(path.join(base, 'agents', 'worker', 'CLAUDE.md'), '# worker\n');
  const configFile = path.join(base, 'orchestrator.config.json');
  await writeText(
    configFile,
    JSON.stringify({
      commsRoot: path.join(base, 'comms'),
      agents: [{ name: 'worker', home: path.join(base, 'agents', 'worker'), ...agentEntry }],
    })
  );
  return { config: await loadConfig(configFile), base };
}

// ------------------------------------------------------------- the two spellings

test('the old readPaths spelling still loads, as read-without-write', async () => {
  const docs = path.join(os.tmpdir(), 'orch-legacy-docs');
  const { config } = await scratch({ readPaths: [docs] });
  const p = config.agents[0]!.paths;
  assert.equal(p.length, 1);
  assert.equal(p[0]!.path, docs);
  assert.equal(p[0]!.read, true);
  assert.equal(p[0]!.write, false, 'a read path was never a write path');
});

test('a directory named in both spellings is merged permissively, not overwritten', async () => {
  const shared = path.join(os.tmpdir(), 'orch-shared-docs');
  const { config } = await scratch({
    readPaths: [shared],
    paths: [{ path: shared, read: true, write: true }],
  });
  const p = config.agents[0]!.paths;
  assert.equal(p.length, 1, 'one directory, one entry');
  assert.equal(p[0]!.write, true, 'the write tick must survive the legacy entry beside it');
});

test('two spellings of one directory become one entry', async () => {
  const dir = path.join(os.tmpdir(), 'orch-dup-docs');
  const { config } = await scratch({
    paths: [
      { path: dir, read: true, write: false },
      { path: dir + path.sep, read: false, write: true },
    ],
  });
  const p = config.agents[0]!.paths;
  assert.equal(p.length, 1, 'a trailing separator is the same directory');
  assert.equal(p[0]!.read, true);
  assert.equal(p[0]!.write, true);
});

test('an entry granting neither read nor write is dropped', async () => {
  const { config } = await scratch({
    paths: [{ path: path.join(os.tmpdir(), 'orch-nothing'), read: false, write: false }],
  });
  assert.equal(config.agents[0]!.paths.length, 0, 'that is a line in a file, not a boundary');
});

test('the workspace carries every granted directory, read-only ones included', async () => {
  const dir = path.join(os.tmpdir(), 'orch-ws-docs');
  const { config } = await scratch({ paths: [{ path: dir, read: true, write: false }] });
  const plan = buildPermissionPlan(config, config.agents[0]!);
  assert.ok(
    plan.addDirs.some((d) => d.toLowerCase() === dir.toLowerCase()),
    'a directory outside the workspace cannot be addressed at all, whatever the rules say'
  );
});

// ------------------------------------------------------------------- warnings

test('a write grant reaching the ledger is warned about, not refused', async () => {
  const { config, base } = await scratch({});
  const { config: next, warnings } = await updateAgent(config, 'worker', {
    paths: [{ path: base, read: true, write: true }],
  });
  assert.equal(next.agents[0]!.paths.length, 1, 'it is granted — this is the operator\'s call');
  assert.match(warnings.join(' '), /contains the ledger/);
});

test('a read-only grant over the same directory says nothing', async () => {
  const { config, base } = await scratch({});
  const { warnings } = await updateAgent(config, 'worker', {
    paths: [{ path: base, read: true, write: false }],
  });
  assert.deepEqual(warnings, [], 'reading the ledger is what agents are supposed to do');
});

test('a write grant reaching another agent home names that agent', async () => {
  const { config, base } = await scratch({});
  const other = path.join(base, 'agents', 'worker');
  // Warn about a *different* agent's home, so `self` is what suppresses the noise.
  assert.deepEqual(pathWarnings(config, [{ path: other, write: true }], 'worker'), []);
  assert.match(
    pathWarnings(config, [{ path: other, write: true }]).join(' '),
    /reaches into "worker"/
  );
});

// --------------------------------------------------------------- the picker

test('the roots are somewhere a browse can start', async () => {
  const r = await roots();
  assert.ok(r.length, 'with no roots the picker opens onto nothing');
  if (process.platform === 'win32') {
    assert.ok(r.some((d) => /^[A-Z]:$/.test(d.name)), 'drive letters');
    assert.ok(r.some((d) => d.path.startsWith('C:')), 'this machine has a C: drive');
  } else {
    assert.equal(r[0]!.path, '/');
  }
});

test('a listing offers subdirectories, a parent and a breadcrumb', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-browse-'));
  await fs.mkdir(path.join(base, 'alpha'));
  await fs.mkdir(path.join(base, 'beta'));
  await writeText(path.join(base, 'a-file.txt'), 'not a directory');

  const l = await listDirectory(base);
  assert.deepEqual(l.entries.map((e) => e.name), ['alpha', 'beta'], 'directories only, sorted');
  assert.equal(l.parent, path.dirname(base));
  assert.equal(l.crumbs[l.crumbs.length - 1]!.path, l.path, 'the last crumb is where you are');
  assert.ok(l.crumbs.length > 1, 'and there is a way back up');
  assert.equal(l.note, null);
});

test('every path a listing hands out is absolute, so it can go straight into a rule', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-browse-abs-'));
  await fs.mkdir(path.join(base, 'child'));
  const l = await listDirectory(base);
  for (const e of [...l.entries, ...l.crumbs]) {
    assert.ok(path.isAbsolute(e.path), `${e.path} is not absolute`);
  }
});

test('a path typed with the wrong separators still lands on the right directory', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-browse-sep-'));
  await fs.mkdir(path.join(base, 'child'));
  // The picker never produces this; the text field beside it frequently does.
  const wonky = base.split(path.sep).join('/') + '/';
  const l = await listDirectory(wonky);
  assert.equal(l.path, base, 'canonicalised, so the picker and the text box agree');
  assert.deepEqual(l.entries.map((e) => e.name), ['child']);
});

test('a directory that cannot be read reports why and still offers the way back', async () => {
  const missing = path.join(os.tmpdir(), 'orch-browse-nope-' + Date.now());
  const l = await listDirectory(missing);
  assert.match(l.note ?? '', /No such directory/);
  assert.equal(l.entries.length, 0);
  assert.ok(l.parent, 'a dead end that traps the picker would be worse than the error');
});

test('no argument lists the roots rather than guessing a directory', async () => {
  const l = await listDirectory(null);
  assert.equal(l.path, null);
  assert.equal(l.parent, null);
  assert.ok(l.entries.length);
});
