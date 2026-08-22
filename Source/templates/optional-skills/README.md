# Optional skills

Skills that ship with this repository and are **not installed by anything**. Copy the
ones you want, into the agents you want them in.

`orchestrator agent skills --install` never touches this directory. It installs
`templates/skills/`, which every dispatched agent needs — the delivery contract. What
is here is different: useful to *some* agent, in *some* setups, and wrong to put
everywhere by default.

## Installing one

Copy the whole directory into the agent's home:

```bash
# Windows
xcopy /E /I templates\optional-skills\ledger-review ^
  C:\path\to\agent\.claude\skills\ledger-review

# macOS / Linux
cp -r templates/optional-skills/ledger-review \
  /path/to/agent/.claude/skills/ledger-review
```

The skill is then available in that agent's sessions as `/ledger-review`.

Nothing tracks these afterwards. `orchestrator agent skills` lists them under "this
agent's own skills, untouched" and leaves them exactly as it found them, so pulling a
new version of this repository will **not** update a copy you made. Re-copy if you want
the newer one.

---

## `ledger-review`

Reviews the ledger for work that stalled, was never finished, or finished without
anyone being told, and chases the specific agents who can unstick it.

**Put it on one agent, not all of them.** Whichever one you treat as the coordinator or
overseer. Several agents all reviewing and chasing the same threads produces duplicate
messages and duplicate invocations, and each one sees the same picture — the second
review adds nothing the first did not already say.

**It needs to read the comms root.** A dispatched invocation already can; the
orchestrator puts it in the workspace. An ordinary interactive session does not, because
nothing added it. Two ways to fix that, and the second is the one worth doing once:

```bash
# per session
claude --add-dir C:/YourDirectory/claude-comms

# permanently, in the agent's own .claude/settings.json
{ "permissions": { "additionalDirectories": ["C:/YourDirectory/claude-comms"] } }
```

That file belongs to you, not to this application — the orchestrator denies *agents*
writing it (X3), and never writes it itself. The exact path for your installation is in
each agent's `.claude/orchestrator-protocol.md`.

If the read is refused the skill stops and says so rather than guessing, which is the
behaviour you want: a review built on a picture it could not actually see is worse than
no review.

### What it will not do

It asks before sending anything, and it is deliberately reluctant. It does not chase
work that is blocked behind a sub-request and waiting correctly, a thread that simply
has not been run yet (that is `orchestrator run`, not a message), a clean agent-to-agent
side chain, or anything it already chased.

Most of the time the honest answer is "nothing needs chasing", and it is told to say
that in one line rather than manufacture findings.

### What it does not solve

**Quota interruptions.** If a chain dies mid-flight because you ran out of quota, it
resumes for free — state is derived by replay, so `orchestrator run` recomputes what is
outstanding and picks up where it stopped. No agent required, no message needed.

The review is for judgement the fold cannot make: *this closed but the output is thin*,
*this has sat three days, chase it*. Not recovery.
