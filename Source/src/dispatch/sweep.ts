/**
 * Sweeping outboxes, validating what is there, appending rows. L2, L5, M7, V2, V3.
 *
 * V2 — "The artefact is the success criterion. A valid message file appeared in the
 * expected outbox, with the fields the application needs. That is the test."
 *
 * This module deliberately takes no `InvocationResult`. It cannot see an exit code,
 * a subtype or an is_error field, because V1 says none of them may decide whether
 * something worked, and the cheapest way to guarantee that is to keep them out of
 * scope. The caller in run.ts combines the two afterwards.
 *
 * D4 — "Sweep on process exit for the machine path; watch the filesystem only for
 * the human path. The application started the agent, so it knows when the
 * invocation finished — no polling, no debounce, no reading a file mid-write."
 */
import path from 'node:path';
import type { Agent, Config } from '../config/load.js';
import { canonicaliseNames, unknownNames } from '../config/load.js';
import { parseMessageFile } from '../ledger/message.js';
import type { MessageDraft } from '../ledger/message.js';
import { appendRow, layout, readIndex } from '../ledger/store.js';
import type { Row } from '../ledger/row.js';
import { ORCHESTRATOR } from '../ledger/row.js';
import { listFiles, moveFile, ensureDir } from '../util/fsx.js';
import { nowIso } from '../util/time.js';

export interface SweptMessage {
  file: string;
  row: Row;
  messageFile: string;
}

export interface RejectedMessage {
  file: string;
  preservedAt: string;
  errors: string[];
  /** The bounce row written back to the author (M7). */
  bounceRow: Row | null;
}

export interface SweepResult {
  agent: string;
  accepted: SweptMessage[];
  rejected: RejectedMessage[];
  /** Files in the outbox that were not message files at all, left untouched. */
  ignored: string[];
}

/** Only these are treated as message files. Anything else is the agent's business. */
const MESSAGE_EXTENSIONS = new Set(['.md', '.markdown']);

/**
 * Sweeps one agent's outbox. Every accepted file is appended to the index and the
 * original removed from the outbox, so a second sweep cannot double-append it —
 * which matters because the watcher (C5, last) and a manual sweep can both run.
 */
export async function sweepOutbox(config: Config, agent: Agent): Promise<SweepResult> {
  const l = layout(config);
  const result: SweepResult = { agent: agent.name, accepted: [], rejected: [], ignored: [] };

  await ensureDir(agent.outbox);
  const files = await listFiles(agent.outbox);

  // Read once. Rows appended during this sweep are tracked alongside, so a message
  // may legitimately reply to one its own sibling created earlier in the same sweep.
  const knownIds = new Set((await readIndex(config)).rows.map((r) => r.id));

  for (const file of files) {
    if (!MESSAGE_EXTENSIONS.has(path.extname(file).toLowerCase())) {
      result.ignored.push(file);
      continue;
    }

    let parsed;
    try {
      parsed = await parseMessageFile(file);
    } catch (err: any) {
      parsed = {
        ok: false as const,
        errors: [`Could not read the file: ${err?.message ?? String(err)}`],
        rawFrontmatter: '',
        sourceFile: file,
      };
    }

    if (!parsed.ok || !parsed.draft) {
      result.rejected.push(await bounce(config, agent, file, parsed.errors));
      continue;
    }

    const draft = parsed.draft;

    // T5 for names, before anything below compares them. An agent typing
    // `To: Coordinator` would otherwise slip past the D3 check just below *and*
    // past dispatch afterwards — a row addressed to nobody, sitting open forever.
    draft.to = canonicaliseNames(config, draft.to);
    draft.needs = canonicaliseNames(config, draft.needs);

    const strangers = unknownNames(config, [...draft.to, ...draft.needs]);
    if (strangers.length) {
      const roster = config.agents.map((a) => a.name).join(', ') || '(none)';
      result.rejected.push(
        await bounce(config, agent, file, [
          `to: nobody is named ${strangers.join(', ')}. On the roster: ${roster}. ` +
            `A row addressed to a name that does not exist is appended and then never dispatched, ` +
            `so it is refused here instead.`,
        ])
      );
      continue;
    }

    // D3 — "Never invoke agent X in response to a row written by X." Enforced at
    // the point the row is created, so a self-addressed row cannot exist to be
    // dispatched from. row.ts asserts the same rule; this catches it earlier and
    // gives the agent a usable reason.
    if (draft.to.includes(agent.name)) {
      result.rejected.push(
        await bounce(config, agent, file, [
          `to: you addressed this to yourself ("${agent.name}"). A row cannot be dispatched back to its own writer (D3). Address it to whoever should act on it.`,
        ])
      );
      continue;
    }

    // The row must reference a real thread, or D10a's walk has nothing to walk.
    if (draft.replyTo) {
      if (!knownIds.has(draft.replyTo)) {
        result.rejected.push(
          await bounce(config, agent, file, [
            `replyTo: "${draft.replyTo}" is not a row in the ledger. Use an ID exactly as it appears in the thread you were shown.`,
          ])
        );
        continue;
      }
    }

    // L2 — the application is the only writer, and this is where it writes. Writer
    // is the outbox owner, never a field the agent supplied.
    const appended = await appendRow(config, { writer: agent.name, draft });
    knownIds.add(appended.row.id);
    result.accepted.push({ file, row: appended.row, messageFile: appended.messageFile });

    // The outbox is a handoff, not an archive. The message itself now lives in the
    // comms root under its ID (L3), so the original is removed rather than left to
    // be swept again.
    await moveFile(file, path.join(l.state, 'swept', agent.name, path.basename(file)));
  }

  return result;
}

/**
 * M7 — "A malformed message file is rejected before its row enters the index, and
 * bounced to its author. The rejected file is preserved, not deleted — a validator
 * bounce is the exact artefact worth looking at."
 *
 * The bounce is itself a ledger row, so the author sees it in the thread on its next
 * cold invocation and the operator sees it in the audit trail. It is written by
 * `orchestrator`, which is the application's own participant name: the ledger has to
 * record who bounced the message, and it was not an agent and not the operator.
 */
async function bounce(
  config: Config,
  agent: Agent,
  file: string,
  errors: string[]
): Promise<RejectedMessage> {
  const l = layout(config);
  const stamp = nowIso().replace(/[:]/g, '-');
  const preservedAt = path.join(l.rejected, agent.name, `${stamp}-${path.basename(file)}`);
  await moveFile(file, preservedAt);

  const body = [
    `Your message file was rejected before it reached the ledger, so no row was created for it.`,
    '',
    `The file is preserved at:`,
    '',
    `    ${preservedAt}`,
    '',
    `What was wrong:`,
    '',
    ...errors.map((e) => `- ${e}`),
    '',
    `Write a corrected file into your outbox. Nothing else has changed — the thread is`,
    `exactly as it was, and whatever was waiting on you is still waiting.`,
  ].join('\n');

  const draft: MessageDraft = {
    to: [agent.name],
    type: 'report',
    replyTo: null,
    needs: [],
    outcome: null,
    summary: `Message file rejected: ${firstLine(errors)}`,
    body,
  };

  let bounceRow: Row | null = null;
  try {
    const appended = await appendRow(config, { writer: ORCHESTRATOR, draft });
    bounceRow = appended.row;
  } catch {
    // A bounce that cannot itself be written must not lose the preserved file or
    // the reason. The caller still reports both.
    bounceRow = null;
  }

  return { file, preservedAt, errors, bounceRow };
}

function firstLine(errors: string[]): string {
  // No character substitution. This used to replace semicolons with commas to keep
  // the summary safe for a delimited index, which meant an error message *about* a
  // semicolon had its semicolon rewritten — a bounce that corrupted itself while
  // explaining the corruption. Under NDJSON there is nothing to protect against.
  const first = (errors[0] ?? 'unknown reason').replace(/\s+/g, ' ').trim();
  return first.length > 120 ? first.slice(0, 117) + '…' : first;
}

/**
 * V3 — "Every invocation resolves to one of three outcomes, not two." This is the
 * classification, made from the artefact and the process outcome together, with the
 * artefact taking precedence in every case where they disagree.
 */
export type InvocationVerdict =
  /** 1. Worked — valid artefact present. */
  | 'worked'
  /** 2. Ran but produced nothing — clean exit, no artefact. The common case. */
  | 'ran-nothing'
  /** 3. Process failed — CLI-level fault. */
  | 'process-failed'
  /** Produced only rejects: it ran, wrote something, and the something was invalid. */
  | 'produced-invalid'
  | 'rate-limited'
  | 'timed-out'
  | 'killed';

export function judge(
  processOutcome: string,
  sweep: SweepResult
): { verdict: InvocationVerdict; why: string } {
  // V2 — the artefact is the success criterion, so it is consulted first. A run
  // that produced a valid message worked, whatever the status fields said (V1).
  if (sweep.accepted.length) {
    return {
      verdict: 'worked',
      why: `${sweep.accepted.length} valid message file(s): ${sweep.accepted.map((a) => a.row.id).join(', ')}`,
    };
  }

  if (processOutcome === 'rate-limited') {
    return { verdict: 'rate-limited', why: 'A rate limit was recognised in the event stream (V5).' };
  }
  if (processOutcome === 'silence-timeout') {
    return {
      verdict: 'timed-out',
      why: 'The process stopped producing output and never returned (V7). Killed by the silence timeout.',
    };
  }
  if (processOutcome === 'wall-timeout') {
    return { verdict: 'timed-out', why: 'The wall-clock timeout was reached.' };
  }
  if (processOutcome === 'killed') {
    return { verdict: 'killed', why: 'Stopped by the kill switch or the operator (C3).' };
  }
  if (processOutcome === 'process-failed') {
    return { verdict: 'process-failed', why: 'A CLI-level fault (V3, outcome 3).' };
  }

  if (sweep.rejected.length) {
    return {
      verdict: 'produced-invalid',
      why: `${sweep.rejected.length} file(s) failed validation and were bounced (M7). Nothing entered the ledger.`,
    };
  }

  // V3 outcome 2 — "Ran but produced nothing. The common case, and the only one
  // requiring judgement." Note that every status field may have said success here.
  return {
    verdict: 'ran-nothing',
    why: 'Clean exit, no artefact in the outbox. Note that the CLI may have reported success on every status field (V1) — the outbox is what decides.',
  };
}
