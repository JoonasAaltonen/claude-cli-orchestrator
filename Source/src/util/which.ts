/**
 * Resolving `claudeBin` the way `spawn` will resolve it.
 *
 * This exists because of one Windows failure with no useful symptom. Node refuses to
 * spawn a `.cmd` or `.bat` without a shell — it throws `EINVAL` with no indication of
 * which file it objected to or why — and an npm install of the Claude CLI puts
 * exactly that on PATH: `claude.cmd`, a batch shim, with no `.exe` anywhere.
 *
 * The application will not spawn through a shell to accommodate it. `invoke.ts`
 * passes argv directly and says why: it "removes the quoting problem rather than
 * solving it". Routing the one process this tool exists to start back through
 * `cmd /c` would hand that problem back, permanently, for an install method the
 * native installer replaces.
 *
 * So the shim is diagnosed rather than supported, at the two moments a person is
 * looking at output and able to act — `init` and `doctor`.
 */
import path from 'node:path';
import process from 'node:process';
import { promises as fsp } from 'node:fs';

/** Scripts Windows can only run through an interpreter, which is what `spawn` refuses. */
const SCRIPT_EXTENSIONS = new Set(['.cmd', '.bat', '.ps1']);

export type BinaryKind = 'ok' | 'script-shim' | 'not-found';

export interface BinaryCheck {
  /** What the configuration asked for. */
  bin: string;
  /** The file `spawn` would actually start, or null if it would find nothing. */
  resolved: string | null;
  extension: string;
  kind: BinaryKind;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

function pathExtensions(): string[] {
  if (process.platform !== 'win32') return [];
  const raw = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return raw.split(';').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

/**
 * Mirrors what libuv does: a name containing a separator is used as given, anything
 * else is searched along PATH, and on Windows each candidate is tried bare and then
 * with every PATHEXT suffix in order.
 *
 * It has to mirror it rather than merely look for the file, because the whole point
 * is to learn which file will be started — finding `claude.exe` somewhere is no
 * comfort if `claude.cmd` sits earlier on PATH.
 */
export async function resolveExecutable(bin: string): Promise<string | null> {
  const exts = pathExtensions();

  // Windows only tries the bare name when it already carries an extension; otherwise
  // it tries PATHEXT suffixes, in PATHEXT order. That detail is the whole check: an
  // npm bin directory holds `claude`, `claude.cmd` and `claude.ps1` side by side, and
  // spawn takes the .cmd. A resolver that preferred the extensionless file would
  // report "ok" for the exact installation this exists to catch.
  const candidates = (base: string): string[] => {
    if (process.platform !== 'win32') return [base];
    if (path.extname(base)) return [base];
    return exts.map((e) => base + e);
  };

  if (bin.includes('/') || bin.includes(path.sep)) {
    for (const c of candidates(path.resolve(bin))) if (await isFile(c)) return c;
    return null;
  }

  const sep = process.platform === 'win32' ? ';' : ':';
  for (const dir of (process.env.PATH ?? '').split(sep).filter(Boolean)) {
    for (const c of candidates(path.join(dir, bin))) if (await isFile(c)) return c;
  }
  return null;
}

export async function checkClaudeBin(bin: string): Promise<BinaryCheck> {
  const resolved = await resolveExecutable(bin);
  if (!resolved) return { bin, resolved: null, extension: '', kind: 'not-found' };

  const extension = path.extname(resolved).toLowerCase();
  // Only Windows has this failure. On Linux and macOS npm writes a shebang script,
  // which spawn starts perfectly well, so flagging it there would be a false alarm.
  const shim = process.platform === 'win32' && SCRIPT_EXTENSIONS.has(extension);
  return { bin, resolved, extension, kind: shim ? 'script-shim' : 'ok' };
}

/**
 * What to tell someone holding a shim. Names the file, because `EINVAL` does not, and
 * says which fix is the real one — pointing `claudeBin` at the shim's full path is
 * the obvious move and it does not work.
 */
export function shimAdvice(c: BinaryCheck): string {
  return [
    `${c.resolved} is a ${c.extension} script, not an executable.`,
    'Node cannot start one without a shell, so every dispatch fails before the agent runs.',
    'The error is ENOENT or EINVAL depending on how the binary is named, and neither one',
    'names the file: it reads as "not installed" while the file sits there on PATH.',
    'This is what an npm install of the Claude CLI puts on PATH.',
    '',
    'Install the native build instead — it provides a real claude.exe:',
    '  https://claude.com/download',
    '',
    'Setting claudeBin to this file’s full path will not help; it is the file that is the problem.',
  ].join('\n');
}
