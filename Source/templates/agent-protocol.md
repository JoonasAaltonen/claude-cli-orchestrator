<!-- orchestrator-protocol:v4 -->
## Working through the orchestrator

Some of your sessions are started by a tool, not by a person typing at you. You can
tell which: **an orchestrated session opens with a message headed "You are
<your-name>, working in your own directory"** and contains a thread of numbered
ledger rows. An interactive session does not.

The difference matters, because in an orchestrated session:

**You are cold, and you have history you do not remember.** You may have written
messages in the thread you are shown. They are marked. Treat them as evidence of what
you previously decided, not as something you recall — and do not contradict them
without saying why.

**Your chat reply is not the deliverable.** It is not recorded anywhere. The
deliverable is a single Markdown file written into your outbox directory, which the
orchestrating message names. Reply in chat with one line saying what you wrote and
where — not nothing, because a silent run and a crashed run look identical from
outside.

**You have no shell, and that is deliberate.** If a task appears to need one, do not
look for another route. Write a file with `outcome: blocked` saying what you needed.

**Never invent a fact to complete a task.** If a figure, a source or a file you were
told to use is not there, that is a `blocked` result, not a gap to fill. A confident
wrong answer costs more than a refusal, because nobody catches it.

### The file you write

```markdown
---
to: <recipient name, or several joined with +>
type: request | response | report | signoff | decision | information
replyTo: <the row ID you are answering, if any — e.g. 0002>
outcome: done | deferred | rejected | blocked
summary: One line saying what this is. Any punctuation is fine.
---

The substance. Write it for someone who has not read the thread, because whoever
reads it next may be as cold as you were.
```

- `outcome` is required on `response` and `signoff`, and must not appear on anything else.
- `replyTo` is required whenever you are answering something.
- An `information` message is delivered to whoever it is addressed to and stays open
  until they reply. If one arrives for you, no work is being asked: record what is
  worth recording in your own notes, then close it with a one-line `report`.
- Leave `needs` out entirely unless the work is outward-facing, makes a checkable
  claim of fact, or crosses a publication boundary. Every name in it costs another
  agent a full invocation.
- `outcome: rejected` requires a body stating the **specific change** that would make
  it pass. A bare rejection is refused by the validator.

Do not write the ledger index, do not write into another agent's directory, and do not
write anything anywhere except those files. The orchestrator assigns the message its
ID, timestamp and author — you do not supply them, and cannot.

### When the work needs someone else

Write **one request per agent you are asking**, each with `replyTo` set to the row you
were given — not a new thread. Then **leave that row unanswered**.

That is what keeps the work yours. The orchestrator sees your requests hanging below
the row, so it will not invoke you again while they are outstanding, and when the last
one is answered it hands you the whole thread — your instructions, your requests and
every reply — so you can write the answer that closes it.

Answering the row now is what breaks this. Any `response` closes it, including
`outcome: deferred`, and the replies you asked for then arrive with nobody left to
read them. `deferred` means *stop, come back to this deliberately*, not *I am waiting
on other people*.

To say what you have set in motion without closing anything, write a `report`. A
report closes nothing.

If sign-off is what you need rather than work, put the names in `needs` instead and
answer normally — the row stays open until each one signs off.

If your file is malformed the orchestrator rejects it before it reaches the ledger,
preserves it, and sends you back a message naming exactly what was wrong. Nothing is
lost, and whatever was waiting on you is still waiting.

---

## Seeing the state of the ledger

You cannot run the orchestrator — you have no shell, deliberately. What you can do is
read the file the application keeps up to date for exactly this purpose:

```
{{COMMS_ROOT}}/status.md
```

That is this installation's comms root. It is rewritten every time the ledger changes. It is the orchestrator's own view, not something to be worked out from
the raw index:

- which threads are open, who each one is waiting on, and which items are actionable
  now versus blocked behind a sub-request
- which threads have gone stale or halted and will not resume by themselves
- which finished chains never addressed the operator, so nobody was told the result

Read that rather than reconstructing it from `index.jsonl`, which lives beside it. Working out what is
resolved means walking `replyTo`, matching responses to requests and deciding what is
blocked — the application already does it, and does it the same way every time.

The file names the row count it was built from and how many lines `index.jsonl` should
therefore have. If those disagree, it is stale: say so rather than acting on it.

**In an orchestrated invocation you can already read that directory** — the orchestrator
puts it in your workspace. In an ordinary session you may not be able to, because
nothing added it. If the read is refused, say so plainly rather than guessing at the
contents; the human can re-open the session with `--add-dir {{COMMS_ROOT}}`, or add it
to `additionalDirectories` in this directory's `.claude/settings.json` once and for all.

## Reaching the ledger from an ordinary session

The above is about sessions the orchestrator started. The ledger also works the other
way round, and this part applies **in any session, including this one**.

When you notice, in the middle of doing something else, that work belongs to another
agent — a file they own is out of date, a question needs their knowledge, something has
been settled that they should not re-open — you can leave them a message. Use the
**`/ledger-note`** skill. It explains the format and writes the file for you.

Two things about it:

- **Ask the person you are talking to first.** A message queues a real invocation of
  another agent against the same quota this session is spending, and they have not
  agreed to that. One sentence: who you want to notify and why. If they say no, drop it.
- **It is not delivered immediately.** The message waits in your outbox until the
  orchestrator next sweeps. You will not get a reply in this session, so do not wait
  for one or plan around it.

You do not need this skill during an orchestrated invocation — there, delivering your
reply *is* the job, and the invoking message says how.
