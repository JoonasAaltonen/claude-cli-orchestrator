/**
 * The ledger row — schema, serialisation, validation.
 *
 * M1 fixes the fields:
 *
 *   ID · Time · Writer · To · Type · ReplyTo · Needs · Outcome · Ref · Summary
 *
 * `To` is an operator-approved extension: M1 lists nine fields and no recipient
 * among them, yet §13b row 2 is one agent sending a request another must answer with
 * `Needs` blank throughout, so routing had nowhere to live.
 *
 * **The index is NDJSON, not the delimited text M1 and M6 describe.** That is the
 * larger deviation and it is deliberate. M6's stated purpose is that "free prose in
 * a delimited file is how the format breaks", and its mitigation was positional —
 * put the one free-text field last so a leaked delimiter still leaves the preceding
 * fields readable. That works, but it only makes the breakage survivable rather than
 * impossible, and it was observed breaking in practice: an agent wrote a perfectly
 * ordinary summary containing a semicolon.
 *
 * The reasoning behind M6 argues for this change even though its letter does not.
 * The best way to stop free prose breaking a delimited file is to not have a
 * delimited file. T6 permits it explicitly by putting the index schema in the cheap
 * column — "the application alone" satisfies it, and a breaking change costs "a
 * migration script, or deletion during development".
 *
 * Three properties follow, and all three were the point:
 *
 *   - **Lossless.** An agent's exact words survive. No character is substituted
 *     because of a storage decision, which is what T6 means by pushing structure to
 *     the application side.
 *   - **No hand-rolled parsing.** Escaping is delegated to a standard parser rather
 *     than to splitting rules this module has to keep getting right.
 *   - **M8 for free.** "The message contract is designed as if it were a tool schema
 *     from day one" — JSON *is* that shape, so the deferred MCP server and the
 *     operator view both consume it without a translation layer.
 *
 * Still append-only, still one line per row, still greppable, still openable.
 * See docs/spec-deviations.md.
 */
import { z } from 'zod';

export const MESSAGE_TYPES = ['report', 'request', 'response', 'signoff', 'decision'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const OUTCOMES = ['done', 'deferred', 'rejected', 'blocked'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** M1: `Outcome` appears on `response` and `signoff` rows only. */
export const OUTCOME_TYPES: ReadonlySet<string> = new Set(['response', 'signoff']);

/** Reserved participant names. Neither is an agent; neither is ever a dispatch target. */
export const OPERATOR = 'operator';
/** The application itself, as the writer of M7 validator bounces and guard notices. */
export const ORCHESTRATOR = 'orchestrator';

/**
 * Written as the first line of a new index. Skipped on read.
 *
 * An append-only file that must outlive its own format needs somewhere to say which
 * format it is. One line costs nothing and turns a future migration from guesswork
 * into a version check.
 */
export const SCHEMA_ID = 'claude-cli-orchestrator/ledger';
export const SCHEMA_VERSION = 1;

export function indexHeaderLine(): string {
  return JSON.stringify({
    _schema: SCHEMA_ID,
    _version: SCHEMA_VERSION,
    _fields: ['id', 'time', 'writer', 'to', 'type', 'replyTo', 'needs', 'outcome', 'ref', 'summary'],
  });
}

/**
 * The index is a label, not a document — L3: "The index row is an address label; the
 * substance lives in the file." Long summaries are truncated rather than refused,
 * because the whole text is always in the message file.
 */
export const MAX_SUMMARY = 400;

/**
 * Normalisation, not validation. T6: "Anything the application derives, owns or
 * **normalises** is free to revise; anything an agent must produce correctly is
 * expensive forever."
 *
 * Under NDJSON no character needs substituting — JSON escapes everything, including
 * newlines, without the line breaking. So this only collapses whitespace, because a
 * summary is *semantically* one line, and caps length. Nothing is replaced and
 * nothing is rejected.
 */
export function normaliseSummary(s: string): string {
  let out = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length > MAX_SUMMARY) out = out.slice(0, MAX_SUMMARY - 1).trimEnd() + '…';
  return out;
}

export const ID_PATTERN = /^\d{4,}$/;
/** Agent names key the roster and appear in `+`-separated lists, so both are excluded. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export interface Row {
  id: string;
  time: string;
  writer: string;
  /** One or more participants. */
  to: string[];
  type: MessageType;
  replyTo: string | null;
  /** M2 — blank by default. */
  needs: string[];
  outcome: Outcome | null;
  /** Path to the message file, relative to the comms root, native separators. */
  ref: string | null;
  summary: string;
}

export const rowSchema = z.object({
  id: z.string().regex(ID_PATTERN, 'ID must be a zero-padded sequence of at least four digits'),
  time: z.string().min(1),
  writer: z.string().regex(NAME_PATTERN, 'Writer must be an agent name, "operator" or "orchestrator"'),
  to: z.array(z.string().regex(NAME_PATTERN)).min(1, 'Every row needs at least one recipient'),
  type: z.enum(MESSAGE_TYPES),
  replyTo: z.string().regex(ID_PATTERN).nullable(),
  needs: z.array(z.string().regex(NAME_PATTERN)),
  outcome: z.enum(OUTCOMES).nullable(),
  ref: z.string().min(1).nullable(),
  summary: z.string().min(1),
});

export interface ParsedLine {
  ok: boolean;
  row?: Row;
  errors: string[];
  raw: string;
  lineNumber: number;
  /** True for the schema header and for blank lines — skipped, not an error. */
  skip: boolean;
}

/**
 * Serialise one row. The summary is normalised; nothing else about its content can
 * prevent a row being written.
 *
 * T5, first consequence: "JSON is not [safe for backslashes] — `C:\Users` must be
 * written `C:\\Users`." That warning is about *hand-writing* JSON. `JSON.stringify`
 * performs the escaping itself, which is precisely why paths go through it rather
 * than through string concatenation anywhere in this application.
 */
export function formatRow(row: Row): string {
  const safe: Row = { ...row, summary: normaliseSummary(row.summary) };
  const errs = validateRowShape(safe);
  if (errs.length) throw new Error(`Refusing to write a malformed row: ${errs.join(', ')}`);
  // Key order is fixed so the file reads consistently and diffs cleanly.
  return JSON.stringify({
    id: safe.id,
    time: safe.time,
    writer: safe.writer,
    to: safe.to,
    type: safe.type,
    replyTo: safe.replyTo,
    needs: safe.needs,
    outcome: safe.outcome,
    ref: safe.ref,
    summary: safe.summary,
  });
}

export function parseLine(raw: string, lineNumber = 0): ParsedLine {
  const trimmed = raw.replace(/\r$/, '').trim();
  if (!trimmed) return { ok: false, errors: [], raw, lineNumber, skip: true };

  // A legacy delimited row, from before the format changed. Named explicitly so the
  // failure says what to do rather than "unexpected token".
  if (!trimmed.startsWith('{')) {
    if (trimmed.startsWith('#') || trimmed.includes(' ; ')) {
      return {
        ok: false,
        errors: [
          'This looks like a row from the older semicolon-delimited index. Run `orchestrator migrate-index` to convert it.',
        ],
        raw,
        lineNumber,
        skip: false,
      };
    }
    return { ok: false, errors: ['Not a JSON object'], raw, lineNumber, skip: false };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err: any) {
    return { ok: false, errors: [`Invalid JSON: ${err?.message ?? String(err)}`], raw, lineNumber, skip: false };
  }

  if (parsed && typeof parsed === 'object' && typeof parsed._schema === 'string') {
    return { ok: false, errors: [], raw, lineNumber, skip: true };
  }

  const row: Row = {
    id: str(parsed?.id),
    time: str(parsed?.time),
    writer: str(parsed?.writer),
    to: list(parsed?.to),
    type: str(parsed?.type) as MessageType,
    replyTo: parsed?.replyTo ? str(parsed.replyTo) : null,
    needs: list(parsed?.needs),
    outcome: (parsed?.outcome ? str(parsed.outcome) : null) as Outcome | null,
    ref: parsed?.ref ? str(parsed.ref) : null,
    summary: str(parsed?.summary),
  };

  const errors = validateRowShape(row);
  return { ok: errors.length === 0, row, errors, raw, lineNumber, skip: false };
}

/** Cross-field rules M1 states. Nothing here depends on the *content* of Summary. */
export function validateRowShape(row: Row): string[] {
  const errors: string[] = [];
  const parsed = rowSchema.safeParse(row);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`${issue.path.join('.') || '(row)'}: ${issue.message}`);
    }
  }
  if (row.outcome && !OUTCOME_TYPES.has(row.type)) {
    errors.push(`outcome: only "response" and "signoff" rows carry an outcome (M1), not "${row.type}"`);
  }
  if (!row.outcome && OUTCOME_TYPES.has(row.type)) {
    errors.push(`outcome: a "${row.type}" row must state an outcome (M1)`);
  }
  if (row.to.includes(row.writer)) {
    errors.push(`to: a row addressed to its own writer ("${row.writer}") cannot be dispatched (D3)`);
  }
  return errors;
}

/** ID allocation. Zero-padded sequence, and also the message filename prefix (M1). */
export function nextId(existing: readonly string[], width = 4): string {
  let max = 0;
  for (const id of existing) {
    const n = Number.parseInt(id, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1).padStart(width, '0');
}

/**
 * Reads one row from the older ` ; ` delimited format, for `migrate-index`.
 *
 * M6's positional rule is honoured here exactly as it was designed: split into at
 * most ten parts and rejoin the remainder into Summary, so a row whose summary
 * leaked a delimiter converts without loss. That property is why the old format was
 * recoverable at all.
 */
export function parseLegacyLine(raw: string): Row | null {
  const trimmed = raw.replace(/\r$/, '').trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const parts = trimmed.split(';');
  if (parts.length < 10) return null;
  const head = parts.slice(0, 9).map((p) => p.trim());
  const summary = parts.slice(9).join(';').trim();
  const [id = '', time = '', writer = '', to = '', type = '', replyTo = '', needs = '', outcome = '', ref = ''] = head;
  return {
    id,
    time,
    writer,
    to: to.split('+').map((s) => s.trim()).filter(Boolean),
    type: type as MessageType,
    replyTo: replyTo || null,
    needs: needs.split('+').map((s) => s.trim()).filter(Boolean),
    outcome: (outcome || null) as Outcome | null,
    ref: ref || null,
    summary,
  };
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split('+').map((s) => s.trim()).filter(Boolean);
  return [];
}
