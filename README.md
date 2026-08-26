# claude-cli-orchestrator

A local application that lets several Claude Code agents pass work to each other,
keeps an auditable record of what was passed and what came back, and invokes agents
to continue a chain of work a human started.

---

## What it is, and is not

One machine, one operator, a handful of agents. Local storage. Nothing is hosted and
nothing is reachable from the network. There are two operator interfaces — this CLI,
and a dashboard that binds **loopback only**, behind a token, and only for as long as
you leave `orchestrator ui` running. There is an MCP server, but it speaks over stdio
to a process the CLI spawns; no socket is involved.

**It ships no agents.** You point it at directories that already exist and belong to
you, and it becomes a channel between them. Registering an agent writes a handful of
files into its `.claude/` directory and one pointer line in its CLAUDE.md — and only if
you ask for them.

It is not autonomous: it acts only on a chain the operator starts, and every chain
carries a finite budget. It is not a general agent framework, and that constraint is
what permits serial dispatch and a single-writer data model.

The one thing worth internalising before using it: **an agent's report that something
worked is not evidence that it worked.** A run that achieved nothing has been measured
reporting `exit 0`, `subtype: success`, `is_error: false` — every status field green.
So this application judges every invocation by whether a valid message file appeared in
the expected outbox, and nowhere in the codebase does an exit code decide anything.

---

## Requirements

- Node.js 22+
- Claude Code CLI on `PATH` (verified against 2.1.239), installed from the
  [native installer](https://claude.com/download) — **not** the npm package. On Windows
  npm installs a `claude.cmd` batch shim, and Node cannot start one without a shell, so
  every dispatch fails before the agent runs. `init` and `doctor` both check this and
  say so.
- Windows, macOS or Linux. The reference target is Windows, and the path handling is
  written for it.

## Install

The node project lives in `Source/`; the checkout root holds only documentation and
your `orchestrator.config.json`.

```bash
cd Source
npm install
npm run build          # optional; `npm run orchestrator` runs from source via tsx
```

Every command below is run from `Source/`.

## Quickstart

```bash
# 1. Create an installation: a comms root and a config with an EMPTY roster.
#    This tool ships no agents. Every path is configuration — nothing is hardcoded.
npm run orchestrator -- init

# 2. Register directories that already exist. `add` does not create them.
#    --write-protocol installs the protocol file, one pointer line in CLAUDE.md,
#    and the ledger skill. Leave it off and nothing of yours is touched.
npm run orchestrator -- agent add coordinator --home C:/YourDirectory/coordinator \
  --description "Breaks work down and routes it" --write-protocol
npm run orchestrator -- agent add writer --home C:/YourDirectory/writer \
  --description "Drafts long-form copy" --write-protocol

# 3. Check everything before spending anything.
npm run orchestrator -- doctor

# 4. Two cheap live invocations, and they are the point of this section.
#    probe:          does the CLI honour an external working directory, load that
#                    directory's CLAUDE.md, write to the outbox, stay out of the shell?
#    probe-contract: does the skill resolve and is the MCP tool actually reachable?
npm run orchestrator -- probe coordinator
npm run orchestrator -- probe-contract coordinator

# 5. Start a chain. Address it wherever you like — there is no obligation to go
#    through a coordinator if two other agents can just get on with it.
npm run orchestrator -- write --to coordinator \
  --summary "How did Q3 go and what should we do about it" \
  --body "Get whatever figures you need, then one paragraph and one recommendation."

# 6. See exactly what would be sent. Spends nothing.
npm run orchestrator -- run --dry-run

# 7. Run it.
npm run orchestrator -- run

# 8. Or do all of it from the dashboard, which is the same functions behind a page.
npm run orchestrator -- ui --open
```

To get `orchestrator <command>` on your PATH instead of typing
`npm run orchestrator --`, link it once:

```bash
cd Source
npm run build      # the linked command runs dist/, so it must exist
npm link
```

The linked command runs the **built** output, so re-run `npm run build` after
changing code. `npm run orchestrator -- <command>` always runs from source via tsx
and needs no build.

> **Do step 4 before step 7.** Two cheap invocations, and they are the difference
> between a working install and a confusing one. `probe` caught, on its first run
> against this repository, a permission rule that silently denied an agent the right
> to write into its own outbox — with every status field still reporting success.
> `probe-contract` covers three more mechanisms that fail the same silent way, and
> neither touches the ledger.

---

## The five-row chain

The target the whole thing is built to pass:

| # | Row | Writer | Type | ReplyTo | Invocation |
|---|---|---|---|---|---|
| 1 | Operator asks for something | operator | `request` | — | none — written by hand |
| 2 | Coordinator delegates a sub-question | coordinator | `request` | 1 | **cold** |
| 3 | Worker answers | worker | `response` | 2 | **cold** |
| 4 | Coordinator reports, using the answer | coordinator | `response` | 1 | **cold — again** |
| 5 | Operator reads it | — | — | — | none |

Rows 2 and 4 are the same agent, invoked twice, cold both times. **The agent writing
row 4 does not remember writing row 2.** Whether it can pick up a thread it started
and has no memory of is the actual question the ledger exists to answer — and a
single-hop test passes without ever asking it.

So every invocation receives the *whole thread*, walked back through `ReplyTo`, with
the agent's own earlier rows marked:

```
#### 0002 · coordinator → worker · request · replying to 0001  ← you wrote this
```

Every prompt actually sent is written to `<commsRoot>/state/prompts/`, so you can read
a real one rather than take this description for it.

### Acceptance

Three runs of the same chain. It passes when:

1. All five rows appear, in order, with correct `ReplyTo` links.
2. **Row 4's content answers row 1's question, not row 3's.**
3. No invocation is judged successful on anything but its artefact.
4. The chain stops on its own — it does not continue past row 4 looking for more to do.
5. It behaves the same all three times. One successful run of an LLM pipeline is an anecdote.

Criteria 1, 3 and 4 are structural and covered by the test suite. **Criteria 2 and 5
need live runs**, because they are properties of the model's behaviour rather than of
this code.

---

## Commands

`orchestrator <command> --help` is the authoritative list of flags; this is the map.
Every command takes `-c, --config <file>` — otherwise `orchestrator.config.json` in the
working directory, or `$ORCHESTRATOR_CONFIG`.

### Setting up

| Command | What it does |
|---|---|
| `init [--comms-root <dir>] [--force]` | Create a comms root and a config with an **empty** roster. `--force` overwrites an existing config |
| `agent add <name> --home <dir>` | Register a directory that already exists. It refuses one that does not |
| `agent list` | The roster, with whatever each agent's grants come to and whether it knows the protocol |
| `agent remove <name>` | Drop it from the roster. Its directory is not touched, and its rows stay in the ledger |
| `agent protocol [name] [--install] [--all] [--force]` | Print the protocol, show where an agent stands, or install it. `--all` is the update path after pulling a new version; `--force` appends a current pointer beside one that has been edited by hand |
| `agent skills [name] [--install] [--all]` | Show or install the two ledger skills. Agents' own skills are never touched |
| `doctor [--fix-hooks-audit]` | Check paths, roster, prompt template, guards, and verify every flag against the installed CLI. `--fix-hooks-audit` records the permission-hook audit for each agent directory |
| `migrate-index` | Convert a pre-NDJSON `index.txt`. The old file is left untouched |

`agent add` takes the same grants the dashboard shows as checkboxes —
`--no-home-writable`, `--shell-allowed`, `--allow-subagents`, `--allow-mcp`,
`--dispatch-excluded` — plus `--description`, `--model`, `--read-path`, `--write-path`,
`--tool`, `--web`, and `--write-protocol` to install the agent-side contract at
registration.

Optional skills ship in [`Source/templates/optional-skills/`](Source/templates/optional-skills/)
and are installed by hand, not by any command.

### Proving it works before spending anything

| Command | What it does |
|---|---|
| `probe [agent] [-y]` | One live invocation that proves cwd, outbox writes, and the shell denial |
| `probe-contract [agent] [-y]` | One live invocation proving the skill resolves and the MCP tool is reachable. Nothing reaches the ledger |
| `probe-slash [agent] [-y]` | Whether a slash command resolves in `--print` at all. Only needed if `probe-contract` fails |

### Working the ledger

| Command | What it does |
|---|---|
| `write` | Write a row as the operator — including `decision` rows. `--to`, `--type`, `--summary`, `--body`/`--body-file`, `--reply-to`, `--needs`, `--outcome`, `--hop-budget`, `--invocation-ceiling` |
| `inbox [--for who]` | What is waiting on you |
| `status` | Open threads, stale threads, halted threads, recent decisions. Also rewrites `status.md`, the copy agents read |
| `ledger [--thread ID] [--raw]` | The index, or one thread root-first |
| `relay` | Rows queued for manual relay to a dispatch-excluded agent |

### Running agents

| Command | What it does |
|---|---|
| `sweep [agent]` | Sweep outboxes, validate, append valid rows, bounce invalid ones |
| `dispatch <agent> [-n]` | Manual dispatch. `--dry-run` prints the prompt and spends nothing |
| `run [--sweep] [-n] [--max-iterations n]` | Drive the chain serially until nothing is outstanding. `--sweep` adopts notes agents left in their outboxes first |
| `watch [--outboxes] [-n]` | React to new work. `--outboxes` also watches agent outboxes, not just the index |

### Seeing what happened, and stopping it

| Command | What it does |
|---|---|
| `log [--last n] [--json]` | The invocation log — verdict, cost, wall time, denials, prompt path |
| `budget` | What each chain has left, and the global caps |
| `stop [reason]` / `resume` | Set and clear the kill switch |
| `problems [-n limit] [--browser] [--server] [--file <path>]` | Failures recorded by the dashboard and its server, newest last |

### The dashboard

| Command | What it does |
|---|---|
| `ui [--port n] [--open] [--new-token] [--log-file <file>]` | Serve the operator dashboard on loopback until Ctrl+C |

---

## The dashboard

```bash
npm run orchestrator -- ui --open
```

It binds `ports.bindAddress:ports.operatorView` — `127.0.0.1:43818` unless you change
it — and prints a URL carrying a token. **The URL is stable across restarts**, because
the token is stored beside your config rather than minted per launch: bookmark it, or
make a shortcut for `orchestrator ui --open` and never see the URL at all. Rotate with
`--new-token`, which invalidates every existing bookmark, and that is the point of it.

A loopback bind authenticates nobody — any process on this machine can reach
127.0.0.1, and this server can spend your quota — so the token is not decoration. It
lives beside `orchestrator.config.json` and deliberately **not** in the comms root,
which every dispatched agent can read.

Five tabs, and each is a view of the same functions the CLI calls rather than a second
implementation:

- **Now** — open threads, and the two ways a run starts. *Start with instructions*
  writes your request to the ledger and then runs it; *Pick up pending work* sweeps
  every outbox first and runs whatever is outstanding, with no message from you. The
  invocation streams into the console as it goes, and *Stop everything* is the kill
  switch.
- **Ledger** — the index, and any thread opened root-first with the message bodies,
  not just the rows.
- **Agents** — where each agent stands on the protocol file, the CLAUDE.md pointer and
  the two ledger skills, and the button that installs them into **every** registered
  directory at once. That is `agent protocol --all --install` and `agent skills --all
  --install` in one press, and it is what to do after pulling a new version of this
  repository — a stale `ledger-invocation` skill is injected into every prompt and
  quietly changes how each agent is handed its job. A CLAUDE.md pointer you have
  edited by hand is reported and left alone unless you tick the box that appends a
  current one beside it.
- **Runs** — the invocation log: verdict, cost, wall time, denials.
- **Config** — the roster. The same grants, paths and per-agent limits `agent add`
  takes, with a directory picker, and each agent's install button beside its entry.

Roster edits and contract installs are refused while a run is in progress: an agent's
boundaries and its delivery instructions are read per dispatch, and changing either
between two invocations of one chain would give the second half different rules from
the first with nothing in the ledger saying so.

Failures on both sides — the page's own exceptions and the server's — are printed to
the terminal and appended to `state/problems.jsonl`, readable later with
`orchestrator problems`.

---

## How it is laid out

The application is a generic repository. An installation's data lives elsewhere, and
every path is configuration:

```
<checkout>/                  this repository
  README.md                  and LICENSE
  Source/                    the node project; run every command from here
    src/  test/  templates/  package.json  tsconfig.json
  orchestrator.config.json   written by `init` — your paths, never committed
```

```
<commsRoot>/                 the ledger — a channel, not a document collection
  index.jsonl                append-only NDJSON, one JSON object per message
  status.md                  the fold, rendered — what agents read to see the whole picture
  messages/<ID>-<slug>.md    one file per message
  rejected/<agent>/          malformed files, preserved rather than deleted
  state/                     dispatch state, invocation log, prompts, snapshots
  KILL                       the kill switch

<agentHome>/                 one per agent, each with its own instructions
  CLAUDE.md                  the agent *is* this file
  outbox/                    where messages land — usually written by the tool, not the agent
  .claude/orchestrator.settings.json   generated deny rules, refreshed each dispatch
  .claude/orchestrator.mcp.json        generated MCP config, naming exactly one server
  .claude/orchestrator-protocol.md     the protocol, pointed at from CLAUDE.md
  .claude/skills/ledger-invocation/    the skill dispatch enters; your own skills untouched
```

The index is newline-delimited JSON — one object per line, a schema marker on the first:

```json
{"id":"0002","time":"2026-08-21T09:05:00Z","writer":"coordinator","to":["worker"],"type":"request","replyTo":"0001","needs":[],"outcome":null,"ref":"messages\\0002-....md","summary":"Pull the Q3 figures"}
```

It started out semicolon-delimited, and a real agent broke it on the first day by
writing a semicolon in a summary. **No character an agent can write is refused,
substituted or truncated now** — escaping is a standard parser's job rather than a
splitting rule's. `orchestrator migrate-index` converts an old `index.txt`; the old
file is left where it is, because nothing here is edited in place.

It also formats cleanly in any editor, which is what you want when debugging by eye.

**Nothing is ever edited in place.** Status, thread state and consensus are derived by
replaying rows. A correction is a new row referencing the old one. There is no update
method and no delete method in the store — that absence is the enforcement mechanism.

### How an agent delivers a message

The message format is the one contract that is expensive to get wrong: every agent has
to satisfy it from prose instructions, and agents get formats wrong. So by default the
agent never writes the format at all — it calls a tool:

```
mcp__orchestrator__submit_message
  to: ["coordinator"]     type: "response"    replyTo: "0002"
  outcome: "done"         summary: "Q3 figures — revenue 4.2M, margin 61%, headcount 34"
  body:    "The substance goes here."
```

The application writes the file. The agent supplies six fields and nothing else; `ID`,
`Time`, `Ref` and `Writer` are derived — `Writer` from *which outbox the file landed
in*, never from a field, so an agent cannot sign as someone else.

The reason this is worth a whole MCP server is the failure path. A malformed file is
bounced: one invocation spent discovering the problem, another spent fixing it. A
rejected **tool call** returns the same reasons in the same session, with the agent's
context intact, and costs nothing:

```
Not delivered. Nothing was written, so fix these and call the tool again:
  - replyTo: "0009" is not a message in the ledger.
    The most recent are: 0003 (response from worker), 0004 (request from coordinator)
```

An agent can still write the file by hand — the outbox sweep is unchanged and accepts
it. That fallback is exactly what makes the tool safe to depend on, and `contract.mcp:
false` turns the whole thing off.

The prompt itself is delivered through a skill (`/ledger-invocation`) installed in each
agent's directory. Measured: the slash command and `$ARGUMENTS` are both expanded
client-side, before the model sees anything — so the delivery instructions are injected
rather than being something the model reads on its way past. Install with
`orchestrator agent skills --all --install`, or from the Agents tab of the dashboard;
your agents' own skills are never touched.

### Messages that start in an ordinary session

Chains do not have to start with you. An agent you are talking to interactively can
notice that work belongs to someone else — a file another agent owns is out of date, a
question needs their knowledge — and leave a message about it. That is the second
installed skill, **`/ledger-note`**:

```bash
orchestrator run --sweep        # adopt whatever agents left, then dispatch
orchestrator watch --outboxes   # or react to it as it appears
```

`--sweep` and `--outboxes` are opt-in because sweeping also adopts anything left over
from a run that died between invoking and sweeping — usually a wanted recovery, and
occasionally a surprise.

Three properties carry over unchanged, and they are what make this safe rather than a
side door:

- **`Writer` still comes from which outbox the file was in.** An interactive agent
  cannot sign as another one.
- **The budget still binds.** Nothing recorded a chain budget, so `chainSpend` falls
  back to the configured defaults — an agent-opened chain is not the one path without a
  ceiling.
- **Malformed notes are still bounced.** One goes back to the agent that wrote it, as
  a ledger row it sees on its next cold invocation.

The skill tells the agent to **ask you before writing**. A message queues a real
invocation of another agent against the same quota, and the person in the room has not
agreed to that work.

Verify the whole path with `orchestrator probe-contract <agent>` before trusting it —
one invocation, and nothing reaches the ledger.

---

## The permission model

The rule underneath all of it: **an allow list shapes the easy path; only a deny rule
enforces a boundary.** Blocked on `Write`, a capable agent will reach for the shell —
not misbehaviour, just competence — which is why boundaries are denials.

Three layers, in decreasing order of how much they are trusted:

1. **Workspace confinement.** Another agent's home is not in the workspace at all.
   Stronger than a denial, because a file tool cannot address it.
2. **Deny rules**, written into the agent's own directory and passed with `--settings`.
3. **Tool-level denials** on argv, plus a constrained `--tools` set. A tool removed
   here cannot be reached even by a hook that returns an allow decision.

Every path rule is emitted in **both** spellings — working-directory-relative and
absolute. This is not belt-and-braces for its own sake: the absolute form alone was
measured not to match, and *a deny rule that fails to match is a boundary that is not
there*.

Denied by default for every dispatched agent: `Bash`, `BashOutput`, `KillShell`,
`KillBash`, `Task`, `Agent`; writes to `settings.json`, `settings.local.json`,
`.mcp.json`, `.claude/agents/`; writes anywhere in the comms root; and MCP entirely.

`.claude/skills/` and `.claude/commands/` stay **writable** in the agent's own
directory — they are instructions the model reads, not code the harness executes, and
the worst case is a bad instruction. That is safe *because the shell is denied*, not on
its own. Allowing a shell for an agent flips skill-write to denied automatically; the
two hold each other up and neither is relaxed without the other.

Changes to those directories are diffed mechanically on every invocation and reported
to the operator — not because an agent might lie, but because an agent's own account of
what it did is unreliable even when it is trying. Never ask an agent whether something
happened when the filesystem can be inspected instead.

---

## Guards

- **Chain budget.** Every chain carries a hop count and an invocation ceiling, recorded
  once when it is created. A later record cannot raise it. At zero the application
  stops and writes a row rather than asking for more.
- **Global caps** — per hour, and per thread. These count *invocations, not successes*,
  because a failed invocation costs more than a successful one. Measured here at
  $0.133 against $0.101 for the same work.
- **Kill switch** — a file, checked before every dispatch and polled during one, so the
  system is stoppable without finding the terminal.
- **Silence timeout** as well as a wall clock, because there is a documented
  unrecoverable hang where the process stops producing output but never returns. Any
  byte on either pipe resets it, so a legitimately long run is not killed.
- **Rate limits** are recognised from typed fields, never a string match, and treated
  as a possible response to any invocation. On one: stop the chain, write a row, and
  never retry into it — a retry loop against a rate limit consumes the next window too.

Cost habit: the prompt cache refreshes at no cost on every hit, so it is a *sliding*
window. Work spread across a day at short gaps stays warm; the cliff is a long gap, not
a spread-out schedule. Caches are per-agent, since each agent is a different directory
and a different instruction file.

---

## Development

```bash
cd Source
npm test           # 266 tests, no network, no invocations
npm run typecheck
```

The test suite runs the five-row chain above as hand-written fixture rows, so the fold, the
thread walk, the rejection ceiling and the stop condition are all verified with nothing
else built and nothing spent. `Source/test/permissions.test.ts` asserts the *denials*
specifically, since those are the boundaries. Two suites run real processes, because
the bugs they pin are invisible to any other kind of test: `Source/test/mcp.test.ts`
speaks JSON-RPC at the MCP server over a real pipe, and `Source/test/watch.test.ts` starts the
watcher and touches the filesystem underneath it.

### Adding an agent

`orchestrator agent add <name> --home <dir>` is the supported route — it refuses a
directory that does not exist, checks the boundaries, and generates the permission
plan. What it produces is just a config entry, and you can write one by hand. There is
no code change and no per-agent branch anywhere in the application:

```jsonc
{
  "name": "reviewer",
  "home": "C:\\YourDirectory\\agents\\reviewer",   // doubled backslashes: this is JSON
  "dispatchExcluded": false,                 // true if you work in this directory yourself
  "shellAllowed": false,                     // true makes its file boundaries advisory
  "readPaths": ["C:\\YourDirectory\\docs"]          // read-only document stores
}
```

Then `orchestrator doctor --fix-hooks-audit`, which audits the directory for
permission-granting hooks and records the result. Audit before dispatching: an agent
directory may already carry hooks installed for unrelated reasons, and a hook that
returns an allow decision overrides the rules this application writes.

### Changing the prompt

`Source/templates/prompt/v1.md`. It is a versioned file rather than a string in code because
it is the actual interface — a cold agent sees its `CLAUDE.md` and this, and nothing
else. When it is wrong, every agent misbehaves identically. Every constructed prompt is
written to `<commsRoot>/state/prompts/` so you can diff what was sent against what you
think is sent.

`doctor` fails if the template drops the thread block, because that failure looks like
the agent being stupid rather than the prompt being short.
