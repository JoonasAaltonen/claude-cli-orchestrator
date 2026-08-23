/**
 * Listing directories, so the dashboard can offer a picker.
 *
 * This exists because a browser cannot hand a web page a real filesystem path, and
 * that is deliberate rather than a gap to work around: `<input webkitdirectory>`
 * yields paths relative to the chosen folder, and `showDirectoryPicker()` yields a
 * handle exposing a name. Neither gives the absolute path a permission rule needs.
 *
 * So the server browses instead. The page shows what this returns and sends back a
 * path this process produced, which removes the whole class of question an operator
 * should never have had to answer — forward or backslash, trailing slash or not,
 * quoted or bare. `canonical()` still normalises anything typed by hand, because the
 * text field remains.
 *
 * What this hands out: directory *names*, nothing else. No file contents, no file
 * names, and no writes. That is a smaller capability than the dashboard already has
 * two rooms away — the same authenticated, loopback-only server can invoke agents
 * and spend money — but "already worse elsewhere" is not a reason to be careless,
 * so the surface is kept to exactly what a picker needs.
 */
import path from 'node:path';
import process from 'node:process';
import { promises as fsp } from 'node:fs';
import { canonical } from '../util/paths.js';

/** A directory with a very large number of children should not stall the page. */
const MAX_ENTRIES = 1000;

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  /** Absolute, canonical. Null when listing the roots themselves. */
  path: string | null;
  /** Absolute path of the parent, or null at a root. */
  parent: string | null;
  /** Each ancestor, nearest last, so the page can render a breadcrumb. */
  crumbs: DirEntry[];
  entries: DirEntry[];
  /** Set when the listing was cut short. */
  truncated: boolean;
  /** Set when the directory exists but could not be read. */
  note: string | null;
}

/**
 * The places a browse can start.
 *
 * Node offers no way to enumerate Windows drives, so they are probed. Twenty-six
 * `stat` calls against a local filesystem is not a cost worth engineering around,
 * and the alternative — shelling out to `wmic` — would spawn a process from the one
 * component that has no business spawning anything.
 */
export async function roots(): Promise<DirEntry[]> {
  if (process.platform !== 'win32') return [{ name: '/', path: '/' }];

  const found: DirEntry[] = [];
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  await Promise.all(
    letters.map(async (letter) => {
      const drive = `${letter}:\\`;
      try {
        await fsp.stat(drive);
        found.push({ name: `${letter}:`, path: drive });
      } catch {
        // Not a drive, or not ready. Either way it is not somewhere to browse.
      }
    })
  );
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

function crumbsFor(abs: string): DirEntry[] {
  const out: DirEntry[] = [];
  let current = abs;
  // Walking up by `dirname` terminates when it stops changing, which is the root on
  // both platforms and does not require knowing what a root looks like.
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) {
      out.unshift({ name: current, path: current });
      break;
    }
    out.unshift({ name: path.basename(current), path: current });
    current = parent;
  }
  return out;
}

export async function listDirectory(input: string | null): Promise<DirListing> {
  if (!input) {
    return { path: null, parent: null, crumbs: [], entries: await roots(), truncated: false, note: null };
  }

  const abs = canonical(input);
  const parentPath = path.dirname(abs);
  const parent = parentPath === abs ? null : parentPath;
  const crumbs = crumbsFor(abs);

  let dirents;
  try {
    dirents = await fsp.readdir(abs, { withFileTypes: true });
  } catch (err: any) {
    // A directory that cannot be read is a normal thing to meet while browsing —
    // System Volume Information, a disconnected network share — and it must not look
    // like the picker breaking. Ancestors are still returned so the way back works.
    return {
      path: abs,
      parent,
      crumbs,
      entries: [],
      truncated: false,
      note:
        err?.code === 'EACCES' || err?.code === 'EPERM'
          ? 'This directory cannot be read with the permissions this process has.'
          : err?.code === 'ENOENT'
            ? 'No such directory.'
            : `Could not read this directory: ${err?.message ?? String(err)}`,
    };
  }

  const entries: DirEntry[] = [];
  let truncated = false;
  for (const d of dirents) {
    // A symlink to a directory reports as a link, not a directory. Following it with
    // `stat` would be the friendlier answer and also a way to walk a loop, so links
    // are simply not offered — the target can be browsed to directly.
    if (!d.isDirectory()) continue;
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    entries.push({ name: d.name, path: path.join(abs, d.name) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return { path: abs, parent, crumbs, entries, truncated, note: null };
}
