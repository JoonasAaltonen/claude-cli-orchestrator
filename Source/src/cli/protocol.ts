/**
 * Installing the agent protocol.
 *
 * The content lives in a file inside the agent's directory, and `CLAUDE.md` carries
 * a single line pointing at it. That split is deliberate and the reasoning is worth
 * keeping, because the obvious alternatives are both worse:
 *
 *   - **Appending the whole block to CLAUDE.md** puts fifty-odd lines about a tool
 *     into every interactive session the operator has with that agent, where it is
 *     noise. It also makes updating it a text-surgery problem.
 *   - **Importing it into CLAUDE.md** (`@path`) loads it eagerly, which has exactly
 *     the same cost — an import is not a conditional read.
 *
 * A pointer is read by a human-facing model in the one case it matters: when a
 * message arrives that says it came from the orchestrator. The rest of the time it
 * costs one line.
 *
 * The consequence the operator gets for free is the update path: the protocol is a
 * whole file this application owns, so a new version is a copy, not a merge.
 */
import path from 'node:path';
import type { Agent } from '../config/load.js';
import { appRoot } from '../config/load.js';
import { readText, readTextIfExists, writeText } from '../util/fsx.js';

/**
 * Bumped whenever either half changes — the content file or the CLAUDE.md pointer.
 * They are separate markers with separate jobs, but one version number for both means
 * a mismatch cannot hide: the template's marker and this constant are asserted equal
 * in the tests, which is how a content bump that forgot the pointer was caught.
 */
export const PROTOCOL_VERSION = 'v4';

/** Marks the pointer line inside an agent's CLAUDE.md. */
const POINTER_MARKER = 'orchestrator-protocol-ref';
/** Marks the protocol file itself, and any legacy copy inlined into a CLAUDE.md. */
const CONTENT_MARKER = 'orchestrator-protocol:';

/** Where the protocol file is installed, relative to the agent's home. */
export const PROTOCOL_REL = path.join('.claude', 'orchestrator-protocol.md');

export function templatePath(): string {
  return path.join(appRoot(), 'templates', 'agent-protocol.md');
}

export function installedPath(agent: Agent): string {
  return path.join(agent.home, PROTOCOL_REL);
}

export function readTemplate(): Promise<string> {
  return readText(templatePath());
}

/**
 * The protocol as it is installed, with this installation's paths filled in.
 *
 * The comms root is the one thing in it that cannot be written once and shipped: an
 * agent needs the absolute path to read `status.md`, and in an ordinary session
 * nothing else tells it where that is. Substituting here keeps it out of the agent's
 * CLAUDE.md and out of every prompt, while still being somewhere the agent can look.
 *
 * Every reader goes through this, so a stale-file comparison compares like with like.
 */
export async function renderProtocol(commsRoot: string): Promise<string> {
  const template = await readTemplate();
  // Forward slashes: the value is going into prose an agent will read and may quote
  // back at a tool, and a Windows path with single backslashes is the one form that
  // breaks on the way through (T5).
  return template.replace(/\{\{COMMS_ROOT\}\}/g, commsRoot.replace(/\\/g, '/'));
}

/**
 * The few lines an agent's CLAUDE.md gains. Everything else stays in the file.
 *
 * v2 added the second paragraph. v1 ended with "Ignore this section entirely in an
 * ordinary interactive session", which became actively wrong once `/ledger-note`
 * existed: reaching the ledger from an interactive session is a thing this agent can
 * now do, and an instruction to ignore the pointer would stop it discovering that.
 */
export function pointerBlock(): string {
  return [
    `<!-- ${POINTER_MARKER}:${PROTOCOL_VERSION} -->`,
    '## Working with other agents through the orchestrator',
    '',
    'Some sessions are started by a tool rather than by a person. Those messages say so',
    'and carry a numbered ledger thread. When you see one, **read**',
    `\`${PROTOCOL_REL.replace(/\\/g, '/')}\` in this directory before acting on it — it`,
    'explains what to write, where, and what not to do.',
    '',
    'In an ordinary session like this one, that file is also where to look if you find',
    'work belonging to another agent — a file they own that needs changing, or a question',
    'only they can answer. You can leave them a message with the `/ledger-note` skill.',
    'Ask me first.',
  ].join('\n');
}

/**
 * Every pointer block this application has ever written, newest first.
 *
 * Upgrading in place means finding the old text to replace, and the only safe way to
 * do that is to recognise it exactly. A block that has been edited by hand is left
 * alone and reported, rather than having its boundaries guessed at — CLAUDE.md is the
 * agent, and mangling it is worse than an out-of-date pointer.
 */
function historicPointerBlocks(): string[] {
  const rel = PROTOCOL_REL.replace(/\\/g, '/');
  return [
    // v1
    [
      `<!-- ${POINTER_MARKER}:v1 -->`,
      '## If a request arrives from the orchestrator',
      '',
      'Some sessions are started by a tool rather than by a person. Those messages say so',
      'and carry a numbered ledger thread. When you see one, **read**',
      `\`${rel}\` in this directory before acting on it — it`,
      'explains what to write, where, and what not to do.',
      '',
      'Ignore this section entirely in an ordinary interactive session.',
    ].join('\n'),
    // v2 and v3 shared a pointer block; only the content file changed between them.
    [
      `<!-- ${POINTER_MARKER}:v2 -->`,
      '## Working with other agents through the orchestrator',
      '',
      'Some sessions are started by a tool rather than by a person. Those messages say so',
      'and carry a numbered ledger thread. When you see one, **read**',
      `\`${rel}\` in this directory before acting on it — it`,
      'explains what to write, where, and what not to do.',
      '',
      'In an ordinary session like this one, that file is also where to look if you find',
      'work belonging to another agent — a file they own that needs changing, or a question',
      'only they can answer. You can leave them a message with the `/ledger-note` skill.',
      'Ask me first.',
    ].join('\n'),
  ];
}

export interface ProtocolStatus {
  /** The protocol file is present in the agent's directory. */
  fileInstalled: boolean;
  fileVersion: string | null;
  /** The installed file differs from the shipped one — an update is available. */
  fileStale: boolean;
  /** CLAUDE.md carries the pointer line. */
  pointerPresent: boolean;
  pointerVersion: string | null;
  /** The pointer is present but from an older version of this application. */
  pointerStale: boolean;
  /** CLAUDE.md has the whole protocol pasted into it — the older arrangement. */
  legacyInline: boolean;
  claudeMdPresent: boolean;
  /** True when nothing needs doing. */
  ok: boolean;
}

export async function protocolStatus(agent: Agent, commsRoot: string): Promise<ProtocolStatus> {
  const installed = await readTextIfExists(installedPath(agent));
  const claudeMd = await readTextIfExists(path.join(agent.home, 'CLAUDE.md'));
  const template = await renderProtocol(commsRoot);

  const fileVersion = installed
    ? (new RegExp(`${CONTENT_MARKER}(v\\d+)`).exec(installed)?.[1] ?? null)
    : null;
  const pointerPresent = claudeMd?.includes(POINTER_MARKER) ?? false;
  const pointerVersion = claudeMd
    ? (new RegExp(`${POINTER_MARKER}:(v\\d+)`).exec(claudeMd)?.[1] ?? null)
    : null;
  // The old arrangement pasted the content itself into CLAUDE.md.
  const legacyInline = (claudeMd?.includes(CONTENT_MARKER) ?? false) && !pointerPresent;

  // Staleness has to reach `ok`, or `agent add` reports "already installed" for a
  // pointer written by an older version and never offers the update. The pointer is
  // the half that matters most: v1's wording told agents to ignore the whole thing
  // in an interactive session, which is now the opposite of what is wanted.
  const fileStale = installed !== null && installed.trim() !== template.trim();
  const pointerStale = pointerPresent && pointerVersion !== PROTOCOL_VERSION;

  return {
    fileInstalled: installed !== null,
    fileVersion,
    fileStale,
    pointerPresent,
    pointerVersion,
    pointerStale,
    legacyInline,
    claudeMdPresent: claudeMd !== null,
    ok: installed !== null && !fileStale && pointerPresent && !pointerStale && !legacyInline,
  };
}

export interface InstallResult {
  wroteFile: boolean;
  fileWasUpdated: boolean;
  wrotePointer: boolean;
  removedLegacy: boolean;
  claudeMdMissing: boolean;
  notes: string[];
}

/**
 * Copies the protocol file into the agent's directory and ensures CLAUDE.md points
 * at it. Idempotent: safe to re-run after pulling a new version of this repository,
 * which is the whole point of the arrangement.
 */
export async function installProtocol(agent: Agent, commsRoot: string): Promise<InstallResult> {
  const result: InstallResult = {
    wroteFile: false,
    fileWasUpdated: false,
    wrotePointer: false,
    removedLegacy: false,
    claudeMdMissing: false,
    notes: [],
  };

  const template = await renderProtocol(commsRoot);
  const target = installedPath(agent);
  const existing = await readTextIfExists(target);

  if (existing === null) {
    await writeText(target, template);
    result.wroteFile = true;
  } else if (existing.trim() !== template.trim()) {
    // The file belongs to this application, so replacing it wholesale is correct —
    // that is what makes "pull a new version and re-run" work.
    await writeText(target, template);
    result.wroteFile = true;
    result.fileWasUpdated = true;
  }

  const claudeMdPath = path.join(agent.home, 'CLAUDE.md');
  const claudeMd = await readTextIfExists(claudeMdPath);
  if (claudeMd === null) {
    result.claudeMdMissing = true;
    result.notes.push(
      `No CLAUDE.md at ${claudeMdPath}. The protocol file is installed, but nothing points at it — add a line telling this agent to read ${PROTOCOL_REL.replace(/\\/g, '/')} when a request arrives from the orchestrator.`
    );
    return result;
  }

  // An up-to-date pointer: nothing to do.
  if (claudeMd.includes(`${POINTER_MARKER}:${PROTOCOL_VERSION}`)) return result;

  // An older one: replace it in place if it is still exactly as written, so the
  // operator's own text around it survives and the pointer does not end up duplicated.
  if (claudeMd.includes(POINTER_MARKER)) {
    for (const old of historicPointerBlocks()) {
      if (claudeMd.includes(old)) {
        await writeText(claudeMdPath, claudeMd.replace(old, pointerBlock()));
        result.wrotePointer = true;
        result.notes.push(
          `Updated the CLAUDE.md pointer to ${PROTOCOL_VERSION}. It now mentions that this agent can leave messages for others from an ordinary session, which the old wording told it to ignore.`
        );
        return result;
      }
    }
    result.notes.push(
      `The CLAUDE.md pointer is an older version and has been edited since it was written, so it was left alone. Replace it by hand with:\n\n${pointerBlock()}`
    );
    return result;
  }

  let body = claudeMd;

  // Migrate the older arrangement: strip the inlined copy, leave the pointer.
  if (body.includes(CONTENT_MARKER)) {
    const idx = body.indexOf(`<!-- ${CONTENT_MARKER}`);
    if (idx >= 0) {
      body = body.slice(0, idx).trimEnd();
      result.removedLegacy = true;
      result.notes.push(
        'Removed the protocol text that was pasted into CLAUDE.md and replaced it with a pointer. The content now lives in the file, where it can be replaced on update.'
      );
    }
  }

  await writeText(claudeMdPath, body.trimEnd() + '\n\n' + pointerBlock() + '\n');
  result.wrotePointer = true;
  return result;
}
