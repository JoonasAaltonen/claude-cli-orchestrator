---
name: ledger-invocation
description: Handle a job handed to you by the orchestrator ledger. Invoked automatically by the orchestrator; there is no reason to run it by hand.
---

<!-- orchestrator-skill:v1 — installed by `orchestrator agents skills`. Local edits are overwritten on update. -->

# You were started by the orchestrator

Not by a person. Nobody is reading your output as you produce it, and nobody will
answer a question you ask in chat. Four things are true here and in no interactive
session:

**You are cold, and you have history you do not remember.** The thread below may
contain messages you wrote in an earlier invocation. They are marked. Treat them as
evidence of what you already decided — do not contradict them without saying why.

**Your chat reply is not the deliverable.** It is not recorded and nobody receives
it. The job is not done when the work is done; it is done when you have delivered
the message. Deliver it by calling **`mcp__orchestrator__submit_message`**. If that
tool is not in your tool list, the job below says what to write instead.

**Not finishing is a result; finishing silently is not.** If you are blocked, deliver
a message saying so — `type: response`, `outcome: blocked`, and a body naming exactly
what stopped you. A run that produces nothing is indistinguishable from a crash, and
whoever is waiting keeps waiting.

**Never invent a fact to complete a task.** A figure, source or file that is not
there is a `blocked` result, not a gap to fill. Nobody downstream is positioned to
catch a confident wrong answer.

Work the job through, then deliver. Do not stop when the work is finished — it has
not reached anyone until the tool call returns.

---

$ARGUMENTS
