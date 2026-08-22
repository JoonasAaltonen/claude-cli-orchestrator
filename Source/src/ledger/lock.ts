/**
 * One writer at a time, across processes.
 *
 * L2 says only the application writes the index, and adds: *"This removes file
 * locking from the design entirely, which matters because the platform offers no
 * usable cross-process lock here."* That held while the application was a CLI —
 * one short-lived process, run by hand, finishing before the next one starts.
 *
 * The dashboard breaks that assumption. It is long-lived, it can start a run, and
 * a terminal is still free to run `orchestrator run` at the same moment. Two
 * dispatch loops over one ledger is not a race in the ledger's *format* — appends
 * are atomic enough — it is a race in its *meaning*: both loops read the same fold,
 * both find row 0007 outstanding, and both invoke the agent for it. The cost is
 * doubled and the second response is a duplicate nobody asked for.
 *
 * So this is not the file locking L2 ruled out. `LockFileEx`-style locking is what
 * the platform handles badly; an **atomic create** (`wx`) is portable, and it is
 * all that is needed here because the thing being protected is a whole operation,
 * not a byte range. The lock is advisory, held for the duration of one writing
 * command, and reclaimed automatically when its owner is gone.
 */
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { promises as fsp, rmSync } from 'node:fs';
import type { Config } from '../config/load.js';
import { layout } from './store.js';
import { ensureDir, readTextIfExists } from '../util/fsx.js';

export interface LockInfo {
  pid: number;
  host: string;
  /** What the holder is doing, so the message can say more than "busy". */
  who: string;
  startedAt: string;
}

export class WriterLockHeld extends Error {
  constructor(readonly info: LockInfo, readonly file: string) {
    super(
      `Another orchestrator process is writing: ${info.who} (pid ${info.pid}, started ${info.startedAt}).\n` +
        `Wait for it to finish, or stop it. If you are sure nothing is running, delete ${file}.`
    );
    this.name = 'WriterLockHeld';
  }
}

export function lockPath(config: Config): string {
  return path.join(layout(config).state, 'writer.lock');
}

/**
 * Is the recorded owner still running?
 *
 * `kill(pid, 0)` sends no signal and only asks. `EPERM` means the process exists
 * but belongs to someone else — alive, and not ours to reclaim. A lock written on
 * a different machine cannot be checked at all, so it is treated as held: a shared
 * comms root is outside this design, and guessing wrong here means double-spending.
 */
function ownerAlive(info: LockInfo): boolean {
  if (info.host !== os.hostname()) return true;
  try {
    process.kill(info.pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface HeldLock {
  release: () => Promise<void>;
  /** Set when a dead process's lock was cleared to take this one. */
  reclaimedFrom: LockInfo | null;
}

export async function acquireWriterLock(config: Config, who: string): Promise<HeldLock> {
  const file = lockPath(config);
  await ensureDir(path.dirname(file));

  const mine: LockInfo = {
    pid: process.pid,
    host: os.hostname(),
    who,
    startedAt: new Date().toISOString(),
  };

  const attempt = async (): Promise<boolean> => {
    try {
      // 'wx' fails if the file exists. That check-and-create is one syscall, which
      // is the whole reason this is safe against another process doing the same.
      const handle = await fsp.open(file, 'wx');
      try {
        await handle.writeFile(JSON.stringify(mine, null, 2) + '\n', 'utf8');
      } finally {
        await handle.close();
      }
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      return false;
    }
  };

  if (await attempt()) return makeHeld(file, null);

  const text = await readTextIfExists(file);
  let existing: LockInfo | null = null;
  try {
    existing = text ? (JSON.parse(text) as LockInfo) : null;
  } catch {
    existing = null;
  }

  // An unreadable or empty lock is debris from a process killed mid-write. It
  // names no owner, so it can protect nothing.
  if (!existing || typeof existing.pid !== 'number') {
    await fsp.rm(file, { force: true });
    if (await attempt()) return makeHeld(file, null);
    throw new WriterLockHeld(
      { pid: -1, host: 'unknown', who: 'unknown', startedAt: 'unknown' },
      file
    );
  }

  if (ownerAlive(existing)) throw new WriterLockHeld(existing, file);

  await fsp.rm(file, { force: true });
  if (await attempt()) return makeHeld(file, existing);

  // Lost the race to another process reclaiming the same dead lock. Its lock is
  // valid; ours is not.
  const now = await readTextIfExists(file);
  throw new WriterLockHeld(now ? (JSON.parse(now) as LockInfo) : existing, file);
}

function makeHeld(file: string, reclaimedFrom: LockInfo | null): HeldLock {
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    process.off('exit', onExit);
    await fsp.rm(file, { force: true });
  };
  // A Ctrl+C mid-run would otherwise leave a lock naming a pid that is gone. The
  // reclaim path handles that, but not leaving it is cheaper than explaining it.
  const onExit = (): void => {
    if (!released) {
      try {
        rmSync(file, { force: true }); // 'exit' handlers cannot await
      } catch {
        /* best effort */
      }
    }
  };
  process.once('exit', onExit);
  return { release, reclaimedFrom };
}

/** Runs `fn` holding the lock, releasing it whether or not `fn` throws. */
export async function withWriterLock<T>(
  config: Config,
  who: string,
  fn: (lock: HeldLock) => Promise<T>
): Promise<T> {
  const lock = await acquireWriterLock(config, who);
  try {
    return await fn(lock);
  } finally {
    await lock.release();
  }
}
