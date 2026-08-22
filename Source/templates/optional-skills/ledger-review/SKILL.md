---
name: ledger-review
description: Review the orchestrator ledger for work that stalled, was never finished, or finished without anyone being told — then chase the specific agents who can unstick it. For a coordinator or overseer agent, not for every agent.
---

<!-- orchestrator-skill:optional-v1 — NOT installed automatically. Copy it yourself; see the README. -->

# Review the ledger

Go through what the orchestrator is tracking, find the things that will not resolve on
their own, and chase exactly those. Then tell me what you found.

You are looking for three failures, and they look nothing alike:

1. **Stalled** — a thread is open, somebody is able to act, and nothing has happened.
2. **Stuck** — a thread has gone stale or hit the rejection ceiling. It will not move
   again without a decision.
3. **Done but silent** — work finished and nobody told the human. The result exists in
   the ledger and the person who wanted it has no idea.

## Step 1 — read the status file, do not reconstruct it

The path is in `.claude/orchestrator-protocol.md` in this directory. Read that first if
you do not already know it, then read `status.md`.

**Do not work any of this out from `index.jsonl`.** Deciding what is unresolved means
walking `replyTo`, matching responses to requests, and telling "blocked behind a
sub-request" from "genuinely waiting on someone" — the application already does it, the
same way every time, and its answer is in that file. Re-deriving it by reading rows is
how you produce a confident wrong list.

If you cannot read the file — an ordinary session may not have that directory in its
workspace — **stop and say so**. Do not guess at the contents and do not substitute the
raw index. Tell me to re-open the session with `--add-dir <that path>`, or to add it to
`additionalDirectories` in this directory's `.claude/settings.json`.

Check the freshness note at the top. If the row count it claims does not match
`index.jsonl`, say so and stop — a stale picture produces chases for things already
finished.

## Step 2 — decide what actually needs chasing

Most of what you see needs nothing. Be strict, because every chase costs a real
invocation of another agent.

**Do not chase:**

- Anything listed as blocked behind a sub-request. It is waiting correctly, and the
  agent it is on cannot act yet.
- A thread that simply has not been run. If items are actionable and nothing has gone
  wrong, the answer is `orchestrator run`, not a message. Say that instead.
- A side chain between two agents that closed cleanly and was never meant to reach the
  human.
- Anything you already chased. **Check the ledger first** — if a recent message from
  you says the same thing, the chase is outstanding, not ignored. Chasing twice wastes
  an invocation and tells the recipient nothing new.

**Do chase:**

- A thread stale for days with an actionable item on a named agent.
- A halted thread — but the outcome here is usually a decision from *me*, not a message
  to an agent. Two rejections mean the disagreement is real.
- Finished work that never reached the human, where the human plainly wanted the
  result. Ask the agent that did the work to report it, and say who to.
- A chain that stopped mid-flight — an agent that delegated and never came back to
  compile the answer.

## Step 3 — ask me before sending anything

Tell me what you found and what you propose, in a few lines. One line per thing:

```
0004  stale 5 days, worker can act on 0006  → ask worker to finish or say what blocks it
0011  finished, nothing addressed to you    → ask archivist to send you the summary
0013  halted after 2 rejections             → your call, not something I should chase
```

Then wait. Do not send until I say so, and drop anything I do not agree to.

If nothing needs chasing, say that in one line and stop. That is the expected outcome
most of the time and it is a real result, not a non-answer.

## Step 4 — send the chases

Use the `ledger-note` skill for each one you were told to send. It has the format and
the rules.

Make each message stand on its own. The agent receiving it will be **cold** — it has
not seen this review, does not know a review happened, and cannot ask you. So:

- name the thread and row IDs you are talking about
- say what state you found them in and how long they have been there
- say precisely what you want back, and who it should be addressed to
- if the point is to report to the human, say `to: operator` explicitly, or the answer
  comes back to you and the human still hears nothing

One message per thread. Do not batch unrelated chases into one, and do not send the
same chase to several agents hoping one of them acts.

## Step 5 — tell me what you sent

A short list: which threads, which agents, what you asked for. Then note that nothing
happens until the orchestrator next runs — the messages are queued, not delivered.
