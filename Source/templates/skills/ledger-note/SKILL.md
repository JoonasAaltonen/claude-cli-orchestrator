---
name: ledger-note
description: Leave a message in the orchestrator ledger for another agent — a request, a heads-up, or a decision worth recording. Use from an ordinary session when work belongs to someone else, or when a file another agent owns needs to change.
---

<!-- orchestrator-skill:v1 — installed by `orchestrator agents skills`. Local edits are overwritten on update. -->

# Leave a message in the ledger

Use this when, in the course of doing something else, you have found work that is not
yours: a file another agent owns needs updating, a question needs someone else's
knowledge, or something has been settled that other agents should not re-litigate.

The message goes into the ledger and the addressee is invoked to deal with it the next
time the orchestrator runs. You do not wait for a reply and you do not get one in this
session — you are dropping something into a queue and carrying on.

**Nobody will report back.** When the addressee answers, the chain is finished and
nothing is addressed to the person you are talking to — they will not be told, in this
session or any other. That is correct for a heads-up, and wrong if they are expecting
an answer.

So if what they actually want is *work done and reported back to them*, say so and stop:

> That's better started from the orchestrator, so the result comes back to you —
> `orchestrator write --to <me> --summary "..."`. If I queue it from here, the work
> happens but nobody tells you it's finished.

A request the human makes themselves stays open until it is answered, which is exactly
what pulls whoever is coordinating back to write them a summary. A note left from here
has no such thread to close.

## Ask first

**Confirm with the person you are talking to before you write anything.** One sentence:
who you want to notify and why. Then write it if they agree.

This is not a formality. A message here queues a real invocation of another agent,
against the same quota this session is spending, and the person in the room has not
agreed to that work. They may also know the thing is already handled, or want it worded
differently, or want it to wait. Asking costs a sentence; not asking spends their
budget on their behalf.

If they say no, drop it entirely — do not write the file and do not offer again.

## How to write it

Write **one** Markdown file into the `outbox/` directory here, in your own working
directory. Any filename ending in `.md`. Nothing else, nowhere else.

```markdown
---
to: archivist
type: request
summary: The Q3 rollup you own is out of date — the revenue line moved
---

While working on the pricing note with the operator I noticed the revenue figure in
your rollup no longer matches the one in the Q3 source. Please reconcile it.

Context you will not have: this came up because the pricing note cites your figure
directly, so the two need to agree.
```

| Field | Required | What goes in it |
|---|---|---|
| `to` | yes | Who should act on this. One agent name, or several separated by `+`. Use `operator` for the human. |
| `type` | yes | `request` if you are asking for work · `report` if you are only telling them · `decision` if something is settled and future work should not re-open it · `information` if it is a fact worth keeping in their own notes for later |
| `summary` | yes | One line. Any punctuation is fine — it is stored as data, not parsed. |
| `replyTo` | no | Leave it out. You are starting something, not answering it. |
| `outcome` | no | Leave it out. It belongs only on a `response` or `signoff`. |

Do not set `writer` — the orchestrator takes it from which outbox the file was found
in, so it is already you and cannot be anything else.

## Write it for someone who was not here

Whoever picks this up will be **cold**. They will not have seen this conversation, will
not know what you were working on, and cannot ask you. Everything they need has to be
in the body.

The most common way this fails is a message that made complete sense at the time:
"as discussed, please update the figure." Nothing about that survives the trip. Name the
file, name the figure, say where the correct value came from.

## What not to do

- **Do not write into another agent's directory.** Your outbox is the only route; the
  orchestrator delivers.
- **Do not edit the ledger index.** The application owns it entirely. You may read it.
- **Do not send more than one message about one thing.** Each is an invocation.
- **Do not invent a fact to make the message complete.** If you do not know the correct
  value, say what is wrong and let them find it. A confident wrong figure travels
  further than a question.

## After you write it

Tell the person what you wrote and where, in one line, and go back to what you were
doing. The message sits in the outbox until the orchestrator sweeps — which happens on
its next run, not immediately. If they want it picked up now, the command is
`orchestrator run --sweep`.
