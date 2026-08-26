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
import type { Agent, Config } from '../config/load.js';
import { appRoot } from '../config/load.js';
import { describeWorkspace } from '../dispatch/permissions.js';
import { readText, readTextIfExists, writeText } from '../util/fsx.js';

/**
 * Bumped whenever either half changes — the content file or the CLAUDE.md pointer.
 * They are separate markers with separate jobs, but one version number for both means
 * a mismatch cannot hide: the template's marker and this constant are asserted equal
 * in the tests, which is how a content bump that forgot the pointer was caught.
 */
export const PROTOCOL_VERSION = 'v7';

/** Marks the pointer line inside an agent's CLAUDE.md. */
const POINTER_MARKER = 'orchestrator-protocol-ref';
/** Marks the protocol file itself, and any legacy copy inlined into a CLAUDE.md. */
const CONTENT_MARKER = 'orchestrator-protocol:';

/** Where the protocol file is installed, relative to the agent's home. */
export const PROTOCOL_REL = path.join('.claude', 'orchestrator-protocol.md');

/** The same path as the agent reads it: prose, so forward slashes (T5). */
const POINTER_REL = PROTOCOL_REL.replace(/\\/g, '/');

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
 * The protocol as it is installed — per installation, and per agent.
 *
 * Two substitutions, for two different reasons.
 *
 * The comms root cannot be written once and shipped: an agent needs the absolute
 * path to read `status.md`, and in an ordinary session nothing else tells it where
 * that is. Substituting here keeps it out of the agent's CLAUDE.md and out of every
 * prompt, while still being somewhere the agent can look.
 *
 * The workspace block cannot be shipped at all. It is what this agent may read,
 * write and reach, and it differs between two agents in the same roster — see
 * `describeWorkspace`, which is generated from the same roster entry the permission
 * plan is. Before it existed, the shipped text asserted one answer for all of them
 * and was wrong for most.
 *
 * That makes the installed file agent-specific, which is exactly what the staleness
 * check wants: it renders for the same agent it is comparing against, so an agent
 * whose grants have changed is correctly reported as needing a new copy.
 */
export async function renderProtocol(config: Config, agent: Agent): Promise<string> {
  const template = await readTemplate();
  return template
    // Forward slashes: the value is going into prose an agent will read and may quote
    // back at a tool, and a Windows path with single backslashes is the one form that
    // breaks on the way through (T5).
    .replace(/\{\{COMMS_ROOT\}\}/g, config.commsRoot.replace(/\\/g, '/'))
    .replace(/\{\{WORKSPACE_BLOCK\}\}/g, () => describeWorkspace(config, agent));
}

/** The pointer body as it stands now — everything after the marker line. */
const CURRENT_POINTER_BODY = [
  '## Working with other agents through the orchestrator',
  '',
  'Some sessions are started by a tool rather than by a person. Those messages say so',
  'and carry a numbered ledger thread. When you see one, **read**',
  `\`${POINTER_REL}\` in this directory before acting on it — it`,
  'explains what to write, where, and what not to do.',
  '',
  'In an ordinary interactive session, that file is also where to look if you find',
  'work belonging to another agent, a file they own that needs changing, or a question',
  'only they can answer. You can leave them a message with the `/ledger-note` skill.',
].join('\n');

/**
 * The pointer wording before the current one, frozen as a literal.
 *
 * One wording back, not a version history. The only question an install has to answer
 * is "did I write this block, or has someone edited it?" — replace it in place if it
 * is mine, leave it alone if it is not. Answering that needs the exact text of what is
 * actually installed out there, which is the previous wording and nothing older.
 *
 * A literal, though, and not generated from the current body with the marker swapped.
 * That refactor removes the duplication and shipped once: the day the wording changed,
 * the reconstructed block became the *new* text, matched nothing on any agent's disk,
 * and every upgrade quietly reported the operator's own CLAUDE.md as hand-edited.
 * History cannot be derived from the present.
 *
 * Two consequences worth knowing. Skipping a release degrades the in-place upgrade to
 * `--force`, so bump one at a time. And when the body above changes, this one becomes
 * the outgoing text — replace it and extend the version list below.
 */
const PREVIOUS_POINTER_BODY = [
  '## Working with other agents through the orchestrator',
  '',
  'Some sessions are started by a tool rather than by a person. Those messages say so',
  'and carry a numbered ledger thread. When you see one, **read**',
  `\`${POINTER_REL}\` in this directory before acting on it — it`,
  'explains what to write, where, and what not to do.',
  '',
  'In an ordinary session like this one, that file is also where to look if you find',
  'work belonging to another agent — a file they own that needs changing, or a question',
  'only they can answer. You can leave them a message with the `/ledger-note` skill.',
  'Ask me first.',
].join('\n');

/**
 * The versions carrying `PREVIOUS_POINTER_BODY` that exist on a disk somewhere.
 *
 * The wording did not change between v2 and v5, so the marker is all that separates
 * them — but v2 and v3 were never installed anywhere and are not listed. Recognising
 * a version nothing runs is not compatibility, it is decoration.
 */
const PREVIOUS_POINTER_VERSIONS = ['v4', 'v5'] as const;

/**
 * The v6 pointer, frozen as its own literal.
 *
 * The version is bumped whenever *either* half changes, and the content file changes
 * far more often than the pointer does. v7 changed the protocol document alone, so an
 * agent sitting on v6 has a block on disk that reads identically to the current one —
 * and it still needs its own frozen copy rather than `block('v6', CURRENT_POINTER_BODY)`.
 *
 * The duplication below is the point, and it is the same lesson as `PREVIOUS_POINTER_BODY`
 * one version further on: a historic block reconstructed from the live body follows the
 * live body. Write it that way and the next wording change silently turns every v6 block
 * into v8 text, matches nothing on disk, and reports each operator's CLAUDE.md as
 * hand-edited — which is precisely the failure that made the previous body a literal.
 * History cannot be derived from the present, however identical it looks today.
 */
const V6_POINTER_BODY = [
  '## Working with other agents through the orchestrator',
  '',
  'Some sessions are started by a tool rather than by a person. Those messages say so',
  'and carry a numbered ledger thread. When you see one, **read**',
  '`.claude/orchestrator-protocol.md` in this directory before acting on it — it',
  'explains what to write, where, and what not to do.',
  '',
  'In an ordinary interactive session, that file is also where to look if you find',
  'work belonging to another agent, a file they own that needs changing, or a question',
  'only they can answer. You can leave them a message with the `/ledger-note` skill.',
].join('\n');

function block(version: string, body: string): string {
  return `<!-- ${POINTER_MARKER}:${version} -->\n${body}`;
}

/** The few lines an agent's CLAUDE.md gains. Everything else stays in the file. */
export function pointerBlock(): string {
  return block(PROTOCOL_VERSION, CURRENT_POINTER_BODY);
}

/**
 * The pointer blocks an upgrade can recognise and replace in place.
 *
 * Recognising the old text exactly is the only safe way to replace it. A block that
 * matches none of these has been edited, and is left alone and reported rather than
 * having its boundaries guessed at — CLAUDE.md is the agent, and mangling it is worse
 * than an out-of-date pointer. `--force` is the operator's opt-in for that case.
 */
export function historicPointerBlocks(): string[] {
  return [
    ...PREVIOUS_POINTER_VERSIONS.map((v) => block(v, PREVIOUS_POINTER_BODY)),
    block('v6', V6_POINTER_BODY),
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
  /**
   * The stale pointer is still verbatim as this application wrote it, so `--install`
   * can replace it in place. False means it has been edited since and `--install` will
   * decline — the distinction that matters, because without it a stale pointer and an
   * unfixable one look identical and the offered fix is a silent no-op.
   */
  pointerUpgradable: boolean;
  /**
   * A pointer is present but matches neither the current text nor any version this
   * application has written — someone has edited it. `--install` declines to touch it;
   * `--install --force` appends a current one beside it.
   */
  pointerEdited: boolean;
  /** CLAUDE.md has the whole protocol pasted into it — the older arrangement. */
  legacyInline: boolean;
  claudeMdPresent: boolean;
  /** True when nothing needs doing. */
  ok: boolean;
}

export async function protocolStatus(agent: Agent, config: Config): Promise<ProtocolStatus> {
  const installed = await readTextIfExists(installedPath(agent));
  const claudeMd = await readTextIfExists(path.join(agent.home, 'CLAUDE.md'));
  const template = await renderProtocol(config, agent);

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
  // Verbatim, not merely the right version number. A block edited under a current
  // marker is what "the version is the same, so it refuses to update" looked like from
  // the outside: `ok` said installed, and `--install` agreed and did nothing.
  const pointerVerbatim = claudeMd?.includes(pointerBlock()) ?? false;
  const pointerUpgradable =
    pointerStale && historicPointerBlocks().some((b) => (claudeMd ?? '').includes(b));
  const pointerEdited = pointerPresent && !pointerVerbatim && !pointerUpgradable;

  return {
    fileInstalled: installed !== null,
    fileVersion,
    fileStale,
    pointerPresent,
    pointerVersion,
    pointerStale,
    pointerUpgradable,
    pointerEdited,
    legacyInline,
    claudeMdPresent: claudeMd !== null,
    ok: installed !== null && !fileStale && pointerVerbatim && !legacyInline,
  };
}

export interface InstallResult {
  wroteFile: boolean;
  fileWasUpdated: boolean;
  wrotePointer: boolean;
  removedLegacy: boolean;
  claudeMdMissing: boolean;
  /** A current pointer was appended beside an edited one, which is still there. */
  forced: boolean;
  notes: string[];
}

/**
 * Copies the protocol file into the agent's directory and ensures CLAUDE.md points
 * at it. Idempotent: safe to re-run after pulling a new version of this repository,
 * which is the whole point of the arrangement.
 */
export async function installProtocol(
  agent: Agent,
  config: Config,
  opts: { force?: boolean } = {}
): Promise<InstallResult> {
  const result: InstallResult = {
    wroteFile: false,
    fileWasUpdated: false,
    wrotePointer: false,
    removedLegacy: false,
    claudeMdMissing: false,
    forced: false,
    notes: [],
  };

  const template = await renderProtocol(config, agent);
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

  // Verbatim, not merely the right version number — see `pointerVerbatim` above.
  if (claudeMd.includes(pointerBlock())) return result;

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
    // Edited since it was written. There is no text to match, and no safe way to find
    // where the block ends, so without --force this declines: CLAUDE.md is the agent,
    // and mangling it is worse than an out-of-date pointer.
    const at = claudeMd.indexOf(`<!-- ${POINTER_MARKER}`);
    const line = claudeMd.slice(0, at < 0 ? 0 : at).split('\n').length;
    if (!opts.force) {
      result.notes.push(
        `The CLAUDE.md pointer at line ${line} has been edited since it was written, so it was left alone. Re-run with --force to append a current one beside it, or replace it by hand with:\n\n${pointerBlock()}`
      );
      return result;
    }
    await writeText(claudeMdPath, claudeMd.trimEnd() + '\n\n' + pointerBlock() + '\n');
    result.wrotePointer = true;
    result.forced = true;
    result.notes.push(
      `Appended a ${PROTOCOL_VERSION} pointer at the end. The edited one at line ${line} was left exactly as it is, so this agent now reads two versions of the same section — delete the old one by hand.`
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
