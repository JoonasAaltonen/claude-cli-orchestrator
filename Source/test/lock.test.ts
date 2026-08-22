import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { acquireWriterLock, lockPath, withWriterLock, WriterLockHeld } from '../src/ledger/lock.js';
import type { LockInfo } from '../src/ledger/lock.js';
import { loadConfig } from '../src/config/load.js';
import type { Config } from '../src/config/load.js';
import { writeText } from '../src/util/fsx.js';

/** A configuration whose comms root is a fresh temp directory. */
async function scratch(): Promise<Config> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-lock-'));
  const configFile = path.join(base, 'orchestrator.config.json');
  await writeText(
    configFile,
    JSON.stringify({ commsRoot: path.join(base, 'comms'), agents: [] })
  );
  return loadConfig(configFile);
}

test('a second acquire is refused while the first is held', async () => {
  const c = await scratch();
  const first = await acquireWriterLock(c, 'run');
  await assert.rejects(() => acquireWriterLock(c, 'sweep'), WriterLockHeld);
  await first.release();
  // Released, so the next one goes through.
  const second = await acquireWriterLock(c, 'sweep');
  await second.release();
});

test('the refusal names what is holding it', async () => {
  const c = await scratch();
  const held = await acquireWriterLock(c, 'run --sweep');
  try {
    await acquireWriterLock(c, 'write');
    assert.fail('should have been refused');
  } catch (err) {
    assert.ok(err instanceof WriterLockHeld);
    assert.equal(err.info.who, 'run --sweep');
    assert.equal(err.info.pid, process.pid);
    // The operator needs a way out if the holder really is gone.
    assert.match(err.message, /delete /);
  }
  await held.release();
});

test('withWriterLock releases even when the body throws', async () => {
  const c = await scratch();
  await assert.rejects(
    () =>
      withWriterLock(c, 'run', async () => {
        throw new Error('boom');
      }),
    /boom/
  );
  // If the lock leaked, this would be refused.
  const after = await acquireWriterLock(c, 'run');
  await after.release();
});

test('a lock left by a dead process is reclaimed', async () => {
  const c = await scratch();
  const file = lockPath(c);
  // PID 0x7FFFFFFF is not a running process on any platform this targets.
  const stale: LockInfo = {
    pid: 2147483647,
    host: os.hostname(),
    who: 'run',
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
  };
  await writeText(file, JSON.stringify(stale));

  const lock = await acquireWriterLock(c, 'run');
  assert.equal(lock.reclaimedFrom?.pid, stale.pid, 'the caller is told it took over');
  await lock.release();
});

test('a lock from another machine is never reclaimed', async () => {
  const c = await scratch();
  await writeText(
    lockPath(c),
    JSON.stringify({ pid: 1, host: 'some-other-host', who: 'run', startedAt: 'x' })
  );
  // The pid cannot be checked from here, and guessing "dead" would double-spend.
  await assert.rejects(() => acquireWriterLock(c, 'run'), WriterLockHeld);
});

test('debris with no owner does not block forever', async () => {
  const c = await scratch();
  await writeText(lockPath(c), 'not json at all');
  const lock = await acquireWriterLock(c, 'run');
  await lock.release();
});

test('release is idempotent', async () => {
  const c = await scratch();
  const lock = await acquireWriterLock(c, 'run');
  await lock.release();
  await lock.release();
  const again = await acquireWriterLock(c, 'run');
  await again.release();
});

test('the lock file is inside the comms root state directory', async () => {
  const c = await scratch();
  assert.ok(
    lockPath(c).startsWith(c.commsRoot),
    'a lock outside the ledger it protects would not be seen by another checkout'
  );
  assert.match(lockPath(c), /state[\\/]writer\.lock$/);
});
