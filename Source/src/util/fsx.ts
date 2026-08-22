/**
 * Filesystem helpers. Everything reads and writes UTF-8 explicitly.
 *
 * §14, console encoding: "Redirected output defaulting to the system codepage will
 * mangle non-ASCII punctuation, and it will look like an agent problem rather than
 * a plumbing one." The same hazard applies to files. No call in this application
 * omits the encoding, and no call routes through a shell.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

export async function readText(file: string): Promise<string> {
  return fsp.readFile(file, 'utf8');
}

export async function writeText(file: string, contents: string): Promise<void> {
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, contents, 'utf8');
}

/**
 * L2 — one writer. This is still an append, not a read-modify-write, so a crash
 * mid-call truncates at most one line rather than corrupting the file.
 */
export async function appendLine(file: string, line: string): Promise<void> {
  await ensureDir(path.dirname(file));
  await fsp.appendFile(file, line.replace(/\r?\n$/, '') + '\n', 'utf8');
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export function existsSync(p: string): boolean {
  return fs.existsSync(p);
}

export async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Recursive walk returning file paths relative to `dir`, sorted. Used by the D13
 * skills diff, where the whole point is that it does not depend on the agent
 * telling us anything.
 */
export async function walkRelative(dir: string, maxEntries = 5000): Promise<string[]> {
  const out: string[] = [];
  async function rec(cur: string, prefix: string): Promise<void> {
    if (out.length >= maxEntries) return;
    let entries;
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true });
    } catch (err: any) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return;
      throw err;
    }
    for (const e of entries) {
      if (out.length >= maxEntries) return;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await rec(path.join(cur, e.name), rel);
      else if (e.isFile()) out.push(rel);
    }
  }
  await rec(dir, '');
  return out.sort();
}

export function sha256(s: string | Buffer): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export async function sha256File(file: string): Promise<string> {
  return sha256(await fsp.readFile(file));
}

export async function fileMtime(file: string): Promise<Date | null> {
  try {
    return (await fsp.stat(file)).mtime;
  } catch {
    return null;
  }
}

/** Moves a file, falling back to copy+unlink across volumes. */
export async function moveFile(from: string, to: string): Promise<void> {
  await ensureDir(path.dirname(to));
  try {
    await fsp.rename(from, to);
  } catch (err: any) {
    if (err?.code !== 'EXDEV') throw err;
    await fsp.copyFile(from, to);
    await fsp.unlink(from);
  }
}
