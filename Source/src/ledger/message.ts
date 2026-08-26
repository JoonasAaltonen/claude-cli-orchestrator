/**
 * The message file: one file per message (L3), written by an agent into its own
 * outbox (L5), validated before its row enters the index (M7).
 *
 * T6 governs the design. The message file format is the *expensive* contract —
 * every agent satisfies it from prose instructions, and agents get formats wrong —
 * so it asks the agent for as little as possible. Everything the application can
 * derive, the application derives:
 *
 *   Agent supplies : to, type, replyTo, needs, outcome, summary, body
 *   App derives    : ID (sequence), Time (append time), Writer (whose outbox it
 *                    was found in), Ref (where the app filed it)
 *
 * Writer in particular is deliberately not asked for. An agent misreporting its own
 * name would forge a ledger row; the outbox it wrote into cannot be misreported,
 * because the application chose the directory it swept.
 *
 * T5, first consequence: frontmatter is YAML, and "plain and single-quoted scalars
 * pass backslashes through; double-quoted scalars do not." Nothing here asks an
 * agent to write a path, and the writer below emits plain or single-quoted scalars
 * only, so no message file this application produces carries a double-quoted scalar.
 */
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import {
  MESSAGE_TYPES,
  OUTCOMES,
  OUTCOME_TYPES,
  OUTCOME_INFO,
  BODY_REQUIRED_OUTCOMES,
  NAME_PATTERN,
  answeringTypeList,
  normaliseSummary,
} from './row.js';
import type { MessageType, Outcome } from './row.js';
import { readText } from '../util/fsx.js';

export interface MessageDraft {
  to: string[];
  type: MessageType;
  replyTo: string | null;
  needs: string[];
  outcome: Outcome | null;
  summary: string;
  body: string;
}

export interface ParsedMessage {
  ok: boolean;
  errors: string[];
  /** True when strict YAML parsing failed and the lenient reader salvaged the fields. */
  lenient?: boolean;
  draft?: MessageDraft;
  /** The raw frontmatter, kept so a bounce can quote what the agent actually wrote. */
  rawFrontmatter: string;
  sourceFile: string;
}

const listField = z
  .union([z.string(), z.array(z.string()), z.null(), z.undefined()])
  .transform((v) => {
    if (v == null) return [] as string[];
    const parts = Array.isArray(v) ? v : String(v).split(/[+,]/);
    return parts.map((s) => String(s).trim()).filter(Boolean);
  });

const optionalString = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v) => (v == null ? '' : String(v).trim()));

/**
 * M8 — "designed as if it were a tool schema from day one". This object is that
 * schema. When §12's validating MCP server arrives it accepts these same fields as
 * typed tool arguments, and the file format becomes internal.
 */
export const frontmatterSchema = z.object({
  to: listField,
  type: optionalString,
  replyTo: optionalString,
  needs: listField,
  outcome: optionalString,
  summary: optionalString,
});

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const BOM = '﻿';

export function parseMessageText(text: string, sourceFile: string): ParsedMessage {
  const errors: string[] = [];
  // A BOM is invisible and would otherwise make the opening delimiter fail to match.
  const clean = text.startsWith(BOM) ? text.slice(1) : text;
  const m = FRONTMATTER_RE.exec(clean);
  if (!m) {
    return {
      ok: false,
      errors: [
        'No YAML frontmatter found. The file must begin with a line containing exactly ---, then the fields, then a line containing exactly ---.',
      ],
      rawFrontmatter: '',
      sourceFile,
    };
  }

  const rawFrontmatter = m[1] ?? '';
  const body = (m[2] ?? '').trim();

  // Strict parse first, lenient fallback second.
  //
  // T6 puts the message file format in the *expensive* column: every agent satisfies
  // it from prose instructions, and agents get formats wrong. So the reading of it
  // has to be as forgiving as it can be without becoming ambiguous.
  //
  // Measured: `summary: Q3: what happened` is not valid YAML — nor is a value
  // starting with a quote or a dash. Every one of those is an ordinary thing to write
  // in a one-line summary, and bouncing the message for it costs a full invocation to
  // recover something we could simply have read. The fallback treats each line as
  // key-then-rest-of-line, which is unambiguous for the flat, single-line fields this
  // contract actually uses.
  let doc: unknown;
  let usedFallback = false;
  try {
    doc = YAML.parse(rawFrontmatter);
  } catch {
    doc = lenientFrontmatter(rawFrontmatter);
    usedFallback = true;
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    const salvaged = lenientFrontmatter(rawFrontmatter);
    if (Object.keys(salvaged).length) {
      doc = salvaged;
      usedFallback = true;
    }
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return {
      ok: false,
      errors: ['Frontmatter must be a set of key: value fields.'],
      rawFrontmatter,
      sourceFile,
    };
  }

  const parsed = frontmatterSchema.safeParse(doc);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`${issue.path.join('.') || '(frontmatter)'}: ${issue.message}`);
    }
    return { ok: false, errors, rawFrontmatter, sourceFile };
  }
  const f = parsed.data;

  // Closed enumerations (M1). Every error names the full legal set rather than
  // only saying the value was wrong: a cold agent gets one shot at reading this.
  if (!f.type) {
    errors.push(`type: required. One of: ${MESSAGE_TYPES.join(', ')}`);
  } else if (!(MESSAGE_TYPES as readonly string[]).includes(f.type)) {
    errors.push(`type: "${f.type}" is not a message type. One of: ${MESSAGE_TYPES.join(', ')}`);
  }

  if (f.outcome && !(OUTCOMES as readonly string[]).includes(f.outcome)) {
    errors.push(`outcome: "${f.outcome}" is not an outcome. One of: ${OUTCOMES.join(', ')}`);
  }
  if (f.type && OUTCOME_TYPES.has(f.type) && !f.outcome) {
    errors.push(`outcome: required on a "${f.type}" message. One of: ${OUTCOMES.join(', ')}`);
  }
  if (f.outcome && f.type && !OUTCOME_TYPES.has(f.type)) {
    errors.push(`outcome: only ${answeringTypeList()} messages carry an outcome, not "${f.type}"`);
  }

  if (!f.to.length) {
    errors.push('to: required. The name of the agent or "operator" this message is addressed to.');
  }
  for (const name of f.to) {
    if (!NAME_PATTERN.test(name)) errors.push(`to: "${name}" is not a valid participant name`);
  }
  for (const name of f.needs) {
    if (!NAME_PATTERN.test(name)) errors.push(`needs: "${name}" is not a valid participant name`);
  }

  // Presence is the only rule. Length and whitespace are normalised by the
  // application on the way into the index, and no character in it is forbidden —
  // the index is NDJSON, so nothing an agent can write breaks the format (T6).
  if (!f.summary) errors.push('summary: required. One line describing what this message is.');

  if (f.replyTo && !/^\d+$/.test(f.replyTo)) {
    errors.push(
      `replyTo: "${f.replyTo}" is not a message ID. Use the ID exactly as it appears in the index, e.g. 0002.`
    );
  }

  // M4 generalised — an outcome that reports work not done is invalid unless the body
  // says why. The original rule was for `rejected` alone, and its reasoning ("a bare
  // rejection costs a full invocation and returns the same problem") is not specific
  // to refusal: an unexplained `blocked` or `partial` leaves the agent that asked with
  // no move except to ask again, which is the same wasted invocation.
  if (f.outcome && BODY_REQUIRED_OUTCOMES.has(f.outcome) && body.length < 40) {
    const info = OUTCOME_INFO[f.outcome as Outcome];
    errors.push(
      `outcome "${f.outcome}" requires a body (M4). ${info.what} Without that, whoever asked can`
        + ' only ask again, which costs a full invocation and returns the same problem.'
    );
  }

  // A deliverable claims something was produced, so it has to say where. The rule is
  // presence, not shape: T6 puts anything an agent must format correctly in the
  // expensive column, and demanding a labelled field here would bounce messages over
  // punctuation. The protocol asks for the path; this only refuses an empty claim.
  if (f.type === 'deliverable' && body.length < 40) {
    errors.push(
      'a "deliverable" message must say in the body where the artefact is — the path, or the'
        + ' thing itself if it is short enough to carry. A deliverable nobody can open is a'
        + ' response; send it as one.'
    );
  }

  if (errors.length) return { ok: false, errors, rawFrontmatter, sourceFile };

  return {
    ok: true,
    errors: [],
    rawFrontmatter,
    sourceFile,
    draft: {
      to: f.to,
      type: f.type as MessageType,
      replyTo: f.replyTo ? f.replyTo.padStart(4, '0') : null,
      needs: f.needs,
      outcome: (f.outcome || null) as Outcome | null,
      summary: normaliseSummary(f.summary),
      body,
    },
    lenient: usedFallback,
  };
}

/**
 * Reads flat `key: value` frontmatter without a YAML parser.
 *
 * Used only when strict parsing fails. Everything after the first colon is the
 * value, verbatim — which is exactly what makes `summary: Q3: what happened` work,
 * and what a YAML parser cannot do because it has richer syntax to honour.
 *
 * Deliberately limited to flat single-line fields. It cannot read nested structures
 * or block scalars, and it should not try: this contract has neither, and guessing
 * at more would trade a clear failure for an ambiguous success.
 */
function lenientFrontmatter(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(trimmed);
    if (!m) continue;
    let value = (m[2] ?? '').trim();
    // Strip a wrapping quote pair the agent added, but leave inner quotes alone.
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[m[1]!] = value;
  }
  return out;
}

export async function parseMessageFile(file: string): Promise<ParsedMessage> {
  const text = await readText(file);
  return parseMessageText(text, file);
}

/**
 * Renders a message file the application itself writes — operator rows (J2) and
 * orchestrator bounces (M7).
 */
export function renderMessageFile(draft: MessageDraft): string {
  const fm: string[] = ['---'];
  fm.push(`to: ${draft.to.join('+')}`);
  fm.push(`type: ${draft.type}`);
  if (draft.replyTo) fm.push(`replyTo: ${draft.replyTo}`);
  if (draft.needs.length) fm.push(`needs: ${draft.needs.join('+')}`);
  if (draft.outcome) fm.push(`outcome: ${draft.outcome}`);
  fm.push(`summary: ${yamlPlainScalar(draft.summary)}`);
  fm.push('---', '');
  return fm.join('\n') + draft.body.trim() + '\n';
}

/**
 * T5: plain and single-quoted YAML scalars pass backslashes through; double-quoted
 * scalars do not. So this never emits a double-quoted scalar. When a value cannot
 * be plain it is single-quoted, which is still backslash-transparent.
 */
export function yamlPlainScalar(s: string): string {
  const needsQuoting =
    s === '' ||
    s !== s.trim() ||
    /^[\s>|*&!%@`'"#-]/.test(s) ||
    /:\s/.test(s) ||
    /\s#/.test(s) ||
    s.endsWith(':');
  if (!needsQuoting) return s;
  return "'" + s.replace(/'/g, "''") + "'";
}

/** L3 — one file per message, named with its ID. The ID is the filename prefix (M1). */
export function messageFilename(id: string, summary: string, slugger: (s: string) => string): string {
  return `${id}-${slugger(summary)}.md`;
}

export function messageRelPath(
  id: string,
  summary: string,
  slugger: (s: string) => string
): string {
  return path.join('messages', messageFilename(id, summary, slugger));
}
