/**
 * T5 — Paths are stored in exactly one canonical form: the host platform's native form.
 *
 * Every consequence T5 names is handled here and nowhere else:
 *   - native separators, one form only, never both
 *   - case-insensitive comparison on Windows (roster lookup, outbox matching,
 *     dedupe, per-row dispatch state all key on paths)
 *   - long-path awareness (260-char default limit; message files nest)
 *
 * Quoting is deliberately absent: we never hand a path to a shell. Every spawn in
 * this application passes argv directly with `shell: false`, which removes the
 * whole quoting-and-spaces problem T5 warns about rather than mitigating it.
 */
import path from 'node:path';
import os from 'node:os';

export const IS_WINDOWS = process.platform === 'win32';

/** Windows' default MAX_PATH. T5: deeply nested agent dirs run against this. */
export const MAX_PATH_DEFAULT = 260;

/**
 * The single canonical form. Absolute, native separators, no trailing separator,
 * `~` and environment references expanded. Everything that stores or compares a
 * path calls this on ingest.
 */
export function canonical(p: string, base?: string): string {
  if (!p || typeof p !== 'string') throw new Error(`Not a path: ${JSON.stringify(p)}`);
  let s = p.trim();

  // Strip surrounding quotes a user may have pasted from a shell.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }

  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) {
    s = path.join(os.homedir(), s.slice(1));
  }
  s = expandEnv(s);

  const abs = path.isAbsolute(s) ? s : path.resolve(base ?? process.cwd(), s);
  // path.normalize collapses `.`/`..` and unifies separators to the native one.
  let out = path.normalize(abs);
  if (out.length > 1 && (out.endsWith(path.sep) || out.endsWith('/'))) {
    const trimmed = out.replace(/[\\/]+$/, '');
    // Keep the separator for a drive root: `C:\` must not become `C:`.
    out = /^[a-zA-Z]:$/.test(trimmed) ? trimmed + path.sep : trimmed;
  }
  return out;
}

/** Expands `%VAR%` (Windows) and `${VAR}` / `$VAR` (POSIX) so config can be portable. */
function expandEnv(s: string): string {
  return s
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, k) => process.env[k] ?? m)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k) => process.env[k] ?? m)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, k) => process.env[k] ?? m);
}

/**
 * The comparison key for a canonical path. T5: "Windows compares paths
 * case-insensitively. Anything keyed on a path must normalise on ingest, or two
 * spellings of one directory silently become two agents."
 */
export function pathKey(p: string): string {
  const c = canonical(p);
  return IS_WINDOWS ? c.toLowerCase() : c;
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** True when `child` is `parent` or lives beneath it. Used by every boundary check. */
export function isWithin(parent: string, child: string): boolean {
  const p = canonical(parent);
  const c = canonical(child);
  if (samePath(p, c)) return true;
  const rel = path.relative(p, c);
  if (!rel) return true;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

/**
 * A path relative to the comms root, in native form, for storage in the index
 * `Ref` field. Relative because the comms root is an installation's data and must
 * survive being moved; native because T5 permits exactly one form.
 */
export function refFrom(commsRoot: string, absolute: string): string {
  const rel = path.relative(canonical(commsRoot), canonical(absolute));
  if (rel.startsWith('..')) {
    throw new Error(`Ref would escape the comms root: ${absolute}`);
  }
  return rel;
}

/** Inverse of refFrom. Tolerates a Ref stored with foreign separators. */
export function refTo(commsRoot: string, ref: string): string {
  const native = ref.replace(/[\\/]+/g, path.sep);
  return canonical(path.join(canonical(commsRoot), native));
}

/**
 * T5, fourth consequence. Returns a warning string when a path is close enough to
 * MAX_PATH that nesting a message file underneath it becomes a real risk.
 * `headroom` is how many characters the deepest thing we will create underneath
 * this directory needs.
 */
export function longPathWarning(p: string, headroom = 80): string | null {
  if (!IS_WINDOWS) return null;
  const c = canonical(p);
  if (c.length + headroom <= MAX_PATH_DEFAULT) return null;
  return `Path is ${c.length} characters; adding ${headroom} for nested files exceeds the ${MAX_PATH_DEFAULT}-character default limit. Move it shallower, or enable long paths. Path: ${c}`;
}

/** A filesystem-safe slug for message filenames. Keeps them short (T5, path length). */
export function slug(s: string, max = 40): string {
  const out = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return out || 'message';
}
