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

export const MESSAGE_TYPES = ['report', 'request', 'response', 'deliverable', 'signoff', 'decision', 'information'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const OUTCOMES = ['done', 'partial', 'deferred', 'rejected', 'blocked'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * What each type is for, and what it obliges — one line per type, in one place.
 *
 * This is a `Record` keyed by `MessageType` rather than a list, and that is the
 * whole point of it: adding a name to `MESSAGE_TYPES` without saying what it means
 * does not compile. The dashboard's type menu, the MCP tool's field description and
 * the rules below are all built from this, so a new type arrives in all three at
 * once or not at all. Adding `information` cost five hand-edits in five files, which
 * is the mistake this closes.
 *
 * Agent-facing prose in `templates/prompt/v1.md` and `templates/agent-protocol.md` is
 * deliberately *not* generated from here. D8 makes those a versioned interface an
 * operator may rewrite; a generated block inside one would be overwritten or, worse,
 * silently disagree with the prose around it.
 *
 * They are checked instead, in test/vocabulary.test.ts: every name in the enumerations
 * below must appear somewhere in both templates. Weak on purpose — presence, not
 * wording, because the wording is the operator's. It exists because "not generated"
 * had been read as "not checked", and both templates were listing six types and four
 * outcomes that no longer matched this file.
 */
export interface MessageTypeInfo {
  /** One line, for whoever is choosing a type — an agent or the operator. */
  what: string;
  /** M1 — whether this type carries an Outcome. */
  outcome: 'required' | 'forbidden';
  /** Whether it must name the row it answers. */
  replyTo: 'required' | 'optional';
  /**
   * Does a row of this type, addressed to an agent, cause that agent to be invoked?
   *
   * True for three different reasons, which is why this is documentation rather than
   * the thing the fold switches on: a `request` is outstanding until answered, an
   * `information` until acknowledged, and an answering type until the agent that
   * asked has read it. The fold implements all three separately.
   */
  dispatched: boolean;
  /**
   * Does a row of this type discharge a request addressed to its writer?
   *
   * The fold reads this rather than naming types, because a new answering type that
   * the fold does not recognise fails in the worst possible way: the answer lands,
   * the requester is never released, and the thread reads as open forever with the
   * work already done.
   */
  answers: boolean;
}

export const MESSAGE_TYPE_INFO: Readonly<Record<MessageType, MessageTypeInfo>> = {
  request: {
    what: 'Asking someone else to do work. Stays open until they answer.',
    outcome: 'forbidden',
    replyTo: 'optional',
    dispatched: true,
    answers: false,
  },
  response: {
    what: 'Answering a request addressed to you.',
    outcome: 'required',
    replyTo: 'required',
    dispatched: true,
    answers: true,
  },
  deliverable: {
    what: 'Answering a request by producing something. Same as a response, and names where the artefact is.',
    outcome: 'required',
    replyTo: 'required',
    dispatched: true,
    answers: true,
  },
  report: {
    what: 'Stating what happened. Closes nothing, expects no answer.',
    outcome: 'forbidden',
    replyTo: 'optional',
    dispatched: false,
    answers: false,
  },
  signoff: {
    what: "Approving or rejecting someone else's work, where a `needs` field asked for it.",
    outcome: 'required',
    replyTo: 'required',
    dispatched: true,
    answers: true,
  },
  decision: {
    what: 'Settling something future work should not re-open. Shown to every agent afterwards.',
    outcome: 'forbidden',
    replyTo: 'optional',
    dispatched: false,
    answers: false,
  },
  information: {
    what: 'A fact worth keeping, for the recipient to record in their own notes.',
    outcome: 'forbidden',
    replyTo: 'optional',
    dispatched: true,
    answers: false,
  },
};

/** M1: `Outcome` appears on the answering types only. Derived, not restated. */
export const OUTCOME_TYPES: ReadonlySet<string> = new Set(
  MESSAGE_TYPES.filter((t) => MESSAGE_TYPE_INFO[t].outcome === 'required')
);

/** The types that discharge a request. Derived, so a new one cannot be forgotten. */
export const ANSWERING_TYPES: ReadonlySet<string> = new Set(
  MESSAGE_TYPES.filter((t) => MESSAGE_TYPE_INFO[t].answers)
);

/** A readable list of the answering types, for error text and agent-facing prose. */
export function answeringTypeList(): string {
  const names = MESSAGE_TYPES.filter((t) => MESSAGE_TYPE_INFO[t].answers);
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export interface OutcomeInfo {
  /** What the outcome claims. Shown beside the field wherever one is chosen. */
  what: string;
  /**
   * Does it discharge the request? Every outcome does today, and the field exists so
   * that a future one which does not cannot be added silently — an outcome wrongly
   * assumed to close leaves the answerer holding a row it believes it has finished.
   */
  closes: boolean;
  /**
   * Must the body justify it? M4 is the original case — "a bare rejection costs a
   * full invocation and returns the same problem" — and the same reasoning applies
   * to every outcome that reports work not done. Without the reason, the requester's
   * only move is to ask again.
   */
  requiresBody: boolean;
  /**
   * What the agent that asked should do on receiving an answer that closes this way.
   *
   * This is the point of the requester's invocation. It is per-outcome because the
   * right move differs sharply: an answer that came back `blocked` must not be
   * re-sent to the same agent, and one that came back `partial` often should be, in
   * different words. A cold requester has no way to work that out for itself.
   */
  onReceipt: string;
}

export const OUTCOME_INFO: Readonly<Record<Outcome, OutcomeInfo>> = {
  done: {
    what: 'The work is finished.',
    closes: true,
    requiresBody: false,
    onReceipt: 'Use it. Say what you did with it, or what happens next.',
  },
  partial: {
    what: 'Some of it is done and some is not. The body must say which parts, and why the rest is not.',
    closes: true,
    requiresBody: true,
    onReceipt:
      'Take what is there and read why the rest is not. If the reason was that the ask was'
      + ' not understood, re-state it differently — do not repeat it unchanged. If the reason'
      + ' was something the agent cannot get past, do not send that part back to them at all.',
  },
  deferred: {
    what: 'Not now, and not refused — say in the body what it is waiting for.',
    closes: true,
    requiresBody: true,
    onReceipt:
      'Not refused, and not now. The body says what it is waiting for. Do not restart it —'
      + ' note what it waits on and move whatever does not depend on it.',
  },
  rejected: {
    what: 'Refused. The body must state the specific change that would make it pass.',
    closes: true,
    requiresBody: true,
    onReceipt:
      'The body names the specific change that would make it pass. That change is the only'
      + ' thing to act on; re-sending it unchanged returns the same refusal.',
  },
  blocked: {
    what: 'Something stopped it. The body must say precisely what.',
    closes: true,
    requiresBody: true,
    onReceipt:
      'Do not send this back to the same agent. The body names what stopped it, and if that'
      + ' is a tool, a path or a permission they do not hold, no rewording of the request will'
      + ' change it — the fix is configuration, and neither of you can apply it. Re-route to an'
      + ' agent that holds what is missing, or report it to the operator naming exactly what'
      + ' was missing and who needed it.',
  },
};

/**
 * The outcomes that discharge a request. Derived from OUTCOME_INFO so that adding an
 * outcome without saying whether it closes does not compile.
 */
export const CLOSING_OUTCOMES: ReadonlySet<string> = new Set(
  OUTCOMES.filter((o) => OUTCOME_INFO[o].closes)
);

/** The outcomes whose body must justify them. Derived for the same reason. */
export const BODY_REQUIRED_OUTCOMES: ReadonlySet<string> = new Set(
  OUTCOMES.filter((o) => OUTCOME_INFO[o].requiresBody)
);

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
