<!-- orchestrator-protocol:v7 -->
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

**Your chat reply is not recorded anywhere.** What reaches the ledger is the message
you deliver, and nothing else. Reply in chat with one line saying what you did — not
nothing, because a silent run and a crashed run look identical from outside.

**The ledger message is how you report, not necessarily what you produce.** If the
work is an answer, an opinion or a decision, the message is the whole of it. If the
work is an artifact — a document, a review, a ticket, a draft, code — write the
artifact where that work belongs, within what you are permitted below, and let the
message carry the pointer, the verdict, and anything the reader must not miss. A
review that exists only as a message body has no path to be re-reviewed against; a
draft nobody can open is not a draft.

**Never invent a fact to complete a task.** If a figure, a source or a file you were
told to use is not there, that is a `blocked` result, not a gap to fill. A confident
wrong answer costs more than a refusal, because nobody catches it.

### What you are permitted here

{{WORKSPACE_BLOCK}}

### The file you write

```markdown
---
to: <recipient name, or several joined with +>
type: request | response | deliverable | report | signoff | decision | information
replyTo: <the row ID you are answering, if any — e.g. 0002>
outcome: done | partial | deferred | rejected | blocked
summary: One line saying what this is. Any punctuation is fine.
---

The substance. Write it for someone who has not read the thread, because whoever
reads it next may be as cold as you were.
```

- `outcome` is required on `response`, `deliverable` and `signoff`, and must not appear
  on anything else.
- `replyTo` is required whenever you are answering something.
- A **`deliverable`** is a `response` that produced something — a document, a draft, a
  review, code. Everything a response needs, plus a body that says **where the artefact
  is**. Use it whenever the work exists somewhere other than the message itself; that
  is what tells the reader there is a file to open.
- **`outcome: partial`** is for a request you satisfied some of. Say which parts are
  done, which are not, and why not for each. It closes the row exactly as `done` does,
  so you will not be asked again — what it changes is that the person who asked can see
  the gap now rather than discovering it later and asking from scratch. Reporting
  `done` on work you only partly did is the failure this exists to prevent.
  Be exact about the reason, because it decides what happens next: *"I did not
  understand what was wanted"* invites a better-worded second ask, and *"I do not have
  that tool"* does not, because no rewording will fix it.
- An `information` message is delivered to whoever it is addressed to and stays open
  until they reply. If one arrives for you, no work is being asked: decide whether the
  fact is worth keeping, then close it with a one-line `report`. A report carries no
  `outcome`, so that line is the whole of your answer, and it says one of two things —
  **kept it**, and where you put it, or **not kept**, and why. "We already hold this"
  and "this contradicts what we hold" are worth very different follow-ups from the
  sender, so say which. If it is worth keeping but you have nowhere to write it — see
  *What you are permitted here* — quote the fact in the report, so it is at least in
  the thread rather than lost.
- Leave `needs` out entirely unless the work is outward-facing, makes a checkable
  claim of fact, or crosses a publication boundary. Every name in it costs another
  agent a full invocation.
- `outcome: rejected` requires a body stating the **specific change** that would make
  it pass. A bare rejection is refused by the validator.

Messages go in your outbox, one file each — that is the only place the orchestrator
looks. Anything else you write goes where the work it belongs to lives. The
orchestrator assigns each message its ID, timestamp and author; you do not supply
them, and cannot.

### When the work needs someone else

**Ask each agent once.** Set `replyTo` to the row you were given — not a new thread —
then **leave that row unanswered**.

One message may name several recipients (`to: marketing+pr`) when the ask is genuinely
the same for each. It stays outstanding until every one of them has answered, exactly
as separate messages would, so either form works and the choice is yours. What you must
not do is send the same agent two messages about one thing: that is two invocations of
them for one question, and their two replies have no single place to land.

Leaving the row unanswered is what keeps the work yours. The orchestrator sees your
requests hanging below the row, so it will not invoke you again while they are
outstanding, and when the last one is answered it hands you the whole thread — your
instructions, your requests and every reply — so you can write the answer that closes
it.

A recipient discharges your request by answering it with a `response` or a
`deliverable` carrying an outcome — or a `signoff`, where you asked for one. Their
`report` does not: the row still waits on them.

**This is also true of a thread you started yourself.** If you send a request that is
not a reply to anything — something you decided to ask on your own initiative — you
will be invoked again once it is answered, handed your own request and the reply
together. That invocation is not a repeat of the work: it is the point at which the
answer gets used. See *When something you asked for comes back*, below.

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

### When something you asked for comes back

You will sometimes be invoked with a row **you wrote yourself**, marked *your own
request*, alongside the answer to it. You are cold and will not remember writing it.

**It is not new work and you must not do it again.** You are being invoked because the
answer arrived and nothing has been done with it — that is the only reason the thread
is still moving. Read it, do whatever you asked for it in order to do, and write one
message into the thread. That is what closes it; write nothing and you will be invoked
again with the same answer.

What that message should be depends on the outcome the answer carried:

- **`done`** — use it. Say what you did with it and where that landed.
- **`partial`** — take what is there, and read why the rest is not. If the reason was
  that the ask was not understood, re-state it differently; do not send it back
  unchanged. If the reason was something they cannot get past, do not send that part
  back to them at all.
- **`blocked`** — **do not send this back to the same agent.** If what stopped them was
  a tool, a path or a permission they do not hold, no rewording of the request will
  change it: the fix is configuration, and neither of you can apply it. Send it to an
  agent that does hold what is missing, or report it to `operator` naming exactly what
  was missing and who needed it. Asking twice more after a wall stops the thread
  entirely and escalates it to the human.
- **`rejected`** — the body names the specific change that would make it pass. That
  change is the only thing to act on.
- **`deferred`** — not refused, and not now. Note what it is waiting for and move
  whatever does not depend on it.

If the work it fed is finished and nobody else is waiting, the closing message is a
`report` to `operator`. A chain that finishes without ever addressing the human is a
chain whose result nobody was told about.

---

## Seeing the state of the ledger

You do not run the orchestrator, whatever tools you hold — it is the thing that
invoked you. What you read instead is the file it keeps up to date for exactly this
purpose:

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
