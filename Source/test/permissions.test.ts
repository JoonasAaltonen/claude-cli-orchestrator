/**
 * §7 — the permission model. These assert the *denials*, because the rule
 * underneath all of §7 is that an allow list shapes the easy path and only a deny
 * rule enforces a boundary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPermissionPlan, deadWriteGrants, SHELL_TOOLS, rulePath } from '../src/dispatch/permissions.js';
import { buildArgv, FORBIDDEN_FLAGS } from '../src/dispatch/invoke.js';
import type { Config, Agent } from '../src/config/load.js';
import { MCP_TOOL_ID, SKILL_NAME, SKILL_COMMAND } from '../src/contract/names.js';
import { mcpConfigPathFor } from '../src/mcp/config.js';
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SKILLS } from '../src/contract/names.js';
import { SKILL_VERSION } from '../src/cli/skills.js';
import {
  PROTOCOL_VERSION,
  historicPointerBlocks,
  installProtocol,
  pointerBlock,
  protocolStatus,
  renderProtocol,
  templatePath,
} from '../src/cli/protocol.js';

function agent(over: Partial<Agent> = {}): Agent {
  const home = 'C:\\YourDirectory\\agents\\worker';
  return {
    name: 'worker',
    home,
    outbox: home + '\\outbox',
    description: '',
    model: undefined,
    dispatchExcluded: false,
    hasPermissionHooks: false,
    hooksAuditedAt: null,
    shellAllowed: false,
    allowMcp: false,
    allowSubagents: false,
    paths: [],
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite'],
    silenceTimeoutMs: undefined,
    wallClockTimeoutMs: undefined,
    maxBudgetUsd: undefined,
    ...over,
  };
}

function config(agents: Agent[], over: Partial<Config> = {}): Config {
  return {
    configFile: 'C:\\YourDirectory\\claude-cli-orchestrator\\orchestrator.config.json',
    repoRoot: 'C:\\YourDirectory\\claude-cli-orchestrator',
    commsRoot: 'C:\\YourDirectory\\claude-comms',
    claudeBin: 'claude',
    promptTemplate: 'C:\\YourDirectory\\claude-cli-orchestrator\\templates\\prompt\\v1.md',
    auth: { mode: 'subscription', apiKeyEnvVar: 'ANTHROPIC_API_KEY' },
    defaults: {
      model: 'sonnet', hopBudget: 8, invocationCeiling: 12,
      silenceTimeoutMs: 180000, wallClockTimeoutMs: 1800000,
      maxBudgetUsd: 2, maxAttemptsPerRow: 2, permissionMode: 'dontAsk',
    },
    contract: { mcp: true, skill: true },
    caps: { perHourInvocations: 30, perThreadInvocations: 12 },
    staleThreadDays: 3, maxRejectionsPerThread: 2, decisionsDigestLimit: 15,
    ports: { bindAddress: '127.0.0.1', mcp: 43817, operatorView: 43818 },
    agents,
    warnings: [],
    ...over,
  };
}

test('X1: every shell tool is denied, not merely absent from the allow list', () => {
  const a = agent();
  const plan = buildPermissionPlan(config([a]), a);
  for (const t of SHELL_TOOLS) {
    assert.ok(plan.settings.permissions.deny.includes(t), `${t} must be in the deny list`);
    assert.ok(plan.disallowedTools.includes(t), `${t} must be on --disallowed-tools`);
    assert.ok(!plan.tools.includes(t), `${t} must also be absent from the built-in tool set`);
  }
});

test('X3: the four self-granting paths are deny-write for every write tool', () => {
  const a = agent();
  const plan = buildPermissionPlan(config([a]), a);
  const deny = plan.settings.permissions.deny.join('\n');
  for (const p of [
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.mcp.json',
    '.claude/agents/**',
    // The generated settings file carries the deny rules themselves.
    '.claude/orchestrator.settings.json',
  ]) {
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      assert.ok(
        deny.includes(`${tool}(${rulePath(a.home, '/' + p)})`),
        `${tool} on ${p} must be denied`
      );
    }
  }
});

test('X3: subagent tools are denied by default', () => {
  const a = agent();
  const plan = buildPermissionPlan(config([a]), a);
  assert.ok(plan.disallowedTools.includes('Task'));
  assert.ok(plan.disallowedTools.includes('Agent'));
});

test('X3 table: skills and commands stay writable while shell is denied', () => {
  const a = agent({ shellAllowed: false });
  const deny = buildPermissionPlan(config([a]), a).settings.permissions.deny.join('\n');
  assert.ok(!deny.includes('.claude/skills'), 'skills are instructions, not code the harness executes');
  assert.ok(!deny.includes('.claude/commands'));
});

test('X3a: allowing a shell flips skill-write to denied — the two hold each other up', () => {
  const a = agent({ shellAllowed: true });
  const plan = buildPermissionPlan(config([a]), a);
  const deny = plan.settings.permissions.deny.join('\n');
  assert.ok(deny.includes('.claude/skills/**'), 'with a shell, a self-written skill becomes an escalation path');
  assert.ok(deny.includes('.claude/commands/**'));
  // And X2 is recorded rather than glossed. The identifier lives in its own field
  // now, so it can be asserted without the prose having to carry it.
  const x2 = plan.rationale.find((r) => r.requirement === 'X2');
  assert.ok(x2, 'X2 must be recorded explicitly');
  assert.match(x2.what, /shell is ALLOWED/);
  assert.ok(
    !plan.rationale.some((r) => /[A-Z][0-9][0-9a-z]?/.test(r.what)),
    'no requirement identifier may appear in the prose — the dashboard shows that text verbatim'
  );
});

test('T6/L2: the comms root is readable and never writable', () => {
  const a = agent();
  const c = config([a]);
  const plan = buildPermissionPlan(c, a);
  const deny = plan.settings.permissions.deny.join('\n');
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    assert.ok(deny.includes(`${tool}(${rulePath(c.commsRoot, '/**')})`));
  }
  assert.ok(plan.settings.permissions.allow.includes(`Read(${rulePath(c.commsRoot, '/**')})`));
  assert.ok(plan.addDirs.includes(c.commsRoot), 'the ledger must be readable, so it is in the workspace');
});

test('L5/X4: another agent home is outside the workspace, which is stronger than a denial', () => {
  const worker = agent();
  const coordinator = agent({
    name: 'coordinator',
    home: 'C:\\YourDirectory\\agents\\coordinator',
    outbox: 'C:\\YourDirectory\\agents\\coordinator\\outbox',
  });
  const plan = buildPermissionPlan(config([worker, coordinator]), worker);
  assert.ok(
    !plan.addDirs.some((d) => d.toLowerCase().includes('coordinator')),
    'the other agent home must not be in the workspace at all'
  );
});

test('X4: a read-only path is deny-write; the same path with write ticked is granted', () => {
  const DOCS = 'C:\\YourDirectory\\docs';

  const ro = agent({ paths: [{ path: DOCS, read: true, write: false }] });
  const plan = buildPermissionPlan(config([ro]), ro);
  assert.ok(plan.addDirs.includes(DOCS), 'it has to be in the workspace to be reachable at all');
  assert.ok(plan.settings.permissions.allow.includes(`Read(${rulePath(DOCS, '/**')})`));
  assert.ok(plan.settings.permissions.deny.includes(`Write(${rulePath(DOCS, '/**')})`));

  // The same directory with write ticked. The denial has to be *gone*, not merely
  // outvoted: a denial beats a permission, so leaving both in place grants nothing
  // while looking on screen exactly like a grant.
  const rw = agent({ paths: [{ path: DOCS, read: true, write: true }] });
  const p2 = buildPermissionPlan(config([rw]), rw);
  assert.ok(p2.settings.permissions.allow.includes(`Write(${rulePath(DOCS, '/**')})`));
  assert.ok(
    !p2.settings.permissions.deny.some((r) => r.startsWith('Write(') && r.includes('YourDirectory/docs')),
    'a write grant that is also denied is not a grant'
  );
  assert.ok(
    p2.settings.permissions.allow.includes(`Read(${rulePath(DOCS, '/**')})`),
    'write implies read — the filesystem offers no other arrangement'
  );
});

test('X4: a writable subdirectory of a read-only path is dead, and is reported as dead', () => {
  // The shape an operator reaches for to avoid ticking every subfolder: read the
  // whole tree, write one directory inside it. The rule language cannot express it —
  // the read-only parent's deny covers the child and a deny beats an allow — so the
  // requirement is that nobody is allowed to believe it worked.
  const SITE = 'C:\\YourDirectory\\site';
  const ISSUES = 'C:\\YourDirectory\\site\\Issues';
  const a = agent({
    paths: [
      { path: SITE, read: true, write: false },
      { path: ISSUES, read: true, write: true },
    ],
  });
  const c = config([a]);

  const plan = buildPermissionPlan(c, a);
  assert.ok(
    plan.settings.permissions.deny.includes(`Write(${rulePath(SITE, '/**')})`),
    'the read-only parent still denies — that half is correct and is the boundary'
  );

  const dead = deadWriteGrants(c, a.paths);
  assert.equal(dead.length, 1, 'exactly the one grant that does not take effect');
  assert.equal(dead[0]!.path, ISSUES);
  assert.match(dead[0]!.why, /deny beats an allow/);
  assert.match(dead[0]!.why, /YourDirectory.site"/, 'it names the grant to remove, not just the symptom');

  assert.ok(
    plan.rationale.some((r) => r.what.includes('DOES NOT HOLD') && r.what.includes(ISSUES)),
    'the dry run and the dashboard both read the rationale, so it has to be in there'
  );
});

test('X4: the reverse nesting is a deliberate narrowing and is not reported', () => {
  // Read-only *inside* writable is the case deny-precedence gets right. Warning
  // about it would train the operator to ignore the warning that matters.
  const SITE = 'C:\\YourDirectory\\site';
  const SECRETS = 'C:\\YourDirectory\\site\\secrets';
  const a = agent({
    paths: [
      { path: SITE, read: true, write: true },
      { path: SECRETS, read: true, write: false },
    ],
  });
  const c = config([a]);
  assert.deepEqual(deadWriteGrants(c, a.paths), []);
  assert.ok(
    buildPermissionPlan(c, a).settings.permissions.deny.includes(`Write(${rulePath(SECRETS, '/**')})`),
    'and it genuinely narrows'
  );
});

test('a write grant inside the comms root is reported as dead, because T6 is unconditional', () => {
  const a = agent({ paths: [{ path: 'C:\\YourDirectory\\claude-comms\\messages', read: true, write: true }] });
  const c = config([a]);
  const dead = deadWriteGrants(c, a.paths);
  assert.equal(dead.length, 1);
  assert.match(dead[0]!.why, /comms root/);
});

test('X2: an allowed shell is granted by name, or `dontAsk` refuses it on first use', () => {
  // The failure this exists for: Bash appeared in the agent's tool list, the agent
  // reported having a shell, and the first command was refused because no allow rule
  // matched it. An agent refused mid-task reports the task as impossible.
  const off = agent();
  const planOff = buildPermissionPlan(config([off]), off);
  for (const t of SHELL_TOOLS) {
    assert.ok(planOff.settings.permissions.deny.includes(t), `${t} denied when the shell is off`);
    assert.ok(!planOff.settings.permissions.allow.includes(t));
  }

  const on = agent({ shellAllowed: true });
  const planOn = buildPermissionPlan(config([on]), on);
  for (const t of SHELL_TOOLS) {
    assert.ok(planOn.settings.permissions.allow.includes(t), `${t} allowed by name when the shell is on`);
    assert.ok(!planOn.settings.permissions.deny.includes(t), 'and not also denied');
  }
  assert.ok(planOn.tools.includes('Bash'), 'and present in the built-in set it may draw from');
});

test('X5/F2: no context-stripping flag is ever built into argv', () => {
  const a = agent();
  const c = config([a]);
  const argv = buildArgv(c, a, buildPermissionPlan(c, a));
  for (const f of FORBIDDEN_FLAGS) {
    assert.ok(!argv.includes(f), `${f} strips the instruction files this design rests on`);
  }
  // X5 positively: setting sources are pinned rather than inherited.
  assert.ok(argv.includes('--setting-sources'));
  assert.equal(argv[argv.indexOf('--setting-sources') + 1], 'user,project,local');
});

test('D1: argv asks for a cold run and leaves no session behind', () => {
  const a = agent();
  const c = config([a]);
  const argv = buildArgv(c, a, buildPermissionPlan(c, a));
  assert.ok(argv.includes('--no-session-persistence'));
  assert.ok(!argv.includes('--resume'));
  assert.ok(!argv.includes('--continue'));
});

test('the prompt is never placed on argv, because a thread exceeds the Windows limit', () => {
  const a = agent();
  const c = config([a]);
  const argv = buildArgv(c, a, buildPermissionPlan(c, a));
  const total = argv.join(' ').length;
  assert.ok(total < 4000, `argv is ${total} chars; the prompt must go on stdin`);
});

test('X3: with MCP disallowed, no ambient .mcp.json server can be connected', () => {
  const a = agent({ allowMcp: false });
  const c = config([a]);
  assert.ok(buildArgv(c, a, buildPermissionPlan(c, a)).includes('--strict-mcp-config'));

  const b = agent({ allowMcp: true });
  assert.ok(!buildArgv(c, b, buildPermissionPlan(c, b)).includes('--strict-mcp-config'));
});

test('rulePath produces a bare absolute rule — forward slashes, no prefix', () => {
  // The absent prefix is the whole point of this assertion. Measured on 2.1.239: a
  // `//`-prefixed rule matches nothing, as an allow *or* as a deny, so a regression
  // here would quietly turn every absolute denial back into decoration while every
  // other test in this file kept passing.
  assert.equal(rulePath('C:\\YourDirectory\\agents\\worker'), 'C:/YourDirectory/agents/worker');
  assert.equal(rulePath('C:\\YourDirectory\\agents\\worker', '/**'), 'C:/YourDirectory/agents/worker/**');
  assert.ok(!rulePath('C:\\x').startsWith('/'), 'a leading slash is what made these inert');
});

// ---- the message contract: MCP tool and skill ------------------------------
//
// Every assertion below is about a string matching in two places at once. Nothing
// here fails loudly at runtime: a tool id that does not match the permission rule is
// a tool the model never sees, and a skill command that does not match the installed
// file arrives as stray text at the head of the prompt. Both look like an agent
// declining to cooperate.

test('T6: the MCP tool is allowed by its fully-qualified name, and only when enabled', () => {
  const a = agent();
  const on = buildPermissionPlan(config([a]), a);
  assert.ok(on.settings.permissions.allow.includes(MCP_TOOL_ID));
  assert.ok(on.allowedTools.includes(MCP_TOOL_ID), 'and it reaches --allowed-tools');

  const off = buildPermissionPlan(config([a], { contract: { mcp: false, skill: true } }), a);
  assert.ok(!off.settings.permissions.allow.includes(MCP_TOOL_ID));
});

test('the MCP tool is not smuggled into --tools, which selects from the built-in set', () => {
  const a = agent();
  const plan = buildPermissionPlan(config([a]), a);
  assert.ok(!plan.tools.includes(MCP_TOOL_ID));
  assert.ok(!plan.tools.some((t) => t.startsWith('mcp__')));
});

test('X3: the generated MCP config is deny-write — it names a command to execute', () => {
  const a = agent();
  const deny = buildPermissionPlan(config([a]), a).settings.permissions.deny;
  // Both spellings, for the same reason as every other rule in this table: a deny
  // rule that fails to match is a boundary that is not there.
  assert.ok(deny.includes('Write(.claude/orchestrator.mcp.json)'));
  assert.ok(deny.includes(`Write(${rulePath(a.home, '/.claude/orchestrator.mcp.json')})`));
});

test('argv names our MCP config, and --strict-mcp-config still excludes the agent\'s own', () => {
  const a = agent();
  const c = config([a]);
  const argv = buildArgv(c, a, buildPermissionPlan(c, a));

  const i = argv.indexOf('--mcp-config');
  assert.ok(i >= 0, '--mcp-config must be passed');
  assert.equal(argv[i + 1], mcpConfigPathFor(a));
  // The pairing is the point: strict alone connects nothing, strict plus ours
  // connects exactly one server, and dropping strict would connect .mcp.json too.
  assert.ok(argv.includes('--strict-mcp-config'));
});

test('with the contract off, no MCP server is named at all', () => {
  const a = agent();
  const c = config([a], { contract: { mcp: false, skill: false } });
  const argv = buildArgv(c, a, buildPermissionPlan(c, a));
  assert.ok(!argv.includes('--mcp-config'));
  assert.ok(argv.includes('--strict-mcp-config'), 'X3 holds regardless');
});

test('the tool id the prompt names is the one the permission rule allows', async () => {
  // The failure this prevents: renaming the tool in one place. The prompt would ask
  // for a tool that is not allowed, or allow one that is never mentioned, and in
  // both cases the agent falls back to writing a file and nothing looks wrong.
  const template = await readFile(
    new URL('../templates/skills/ledger-invocation/SKILL.md', import.meta.url),
    'utf8'
  );
  assert.ok(template.includes(MCP_TOOL_ID), 'the shipped skill must name the real tool id');
});

test('the skill the dispatcher enters is the one the shipped template declares', async () => {
  const template = await readFile(
    new URL('../templates/skills/ledger-invocation/SKILL.md', import.meta.url),
    'utf8'
  );
  // A skill is addressed by its frontmatter `name`, not by its directory.
  assert.match(template, new RegExp(`^name: ${SKILL_NAME}$`, 'm'));
  assert.equal(SKILL_COMMAND, `/${SKILL_NAME}`);
  assert.ok(template.includes('$ARGUMENTS'), 'the job has nowhere to land without it');
});

// ---- the two skill directories must not blur together ----------------------

test('optional skills are shipped but never installed by anything', async () => {
  const optional = fileURLToPath(new URL('../templates/optional-skills/', import.meta.url));
  const shipped = (await readdir(optional, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  assert.ok(shipped.includes('ledger-review'), 'ledger-review ships in the repository');

  // SKILLS is what `agent skills --install` iterates. Anything in it is written into
  // every registered agent's directory, which is exactly wrong for a skill meant for
  // one overseer agent.
  for (const name of shipped) {
    assert.ok(
      !(SKILLS as readonly string[]).includes(name),
      `${name} is in templates/optional-skills but also in SKILLS, so it would be installed everywhere`
    );
  }

  // And each one is a real skill, addressed by its frontmatter name rather than its
  // directory — a mismatch means the slash command silently does not resolve.
  for (const name of shipped) {
    const body = await readFile(path.join(optional, name, 'SKILL.md'), 'utf8');
    assert.match(body, new RegExp(`^name: ${name}$`, 'm'), `${name} declares a mismatched name`);
  }
});

test('the protocol version constant matches the shipped template', async () => {
  // Caught a real mismatch: the template content marker was bumped and the constant
  // was not, so `pointerStale` compared against the old version and reported an
  // out-of-date pointer as current.
  const template = await readFile(
    new URL('../templates/agent-protocol.md', import.meta.url),
    'utf8'
  );
  assert.match(
    template,
    new RegExp(`orchestrator-protocol:${PROTOCOL_VERSION}\\b`),
    `the template's marker and PROTOCOL_VERSION (${PROTOCOL_VERSION}) disagree`
  );
});

test('every skill template carries the current version marker', async () => {
  // The same mismatch the protocol test above pins, one file further along, and with a
  // worse failure: `agent skills` reads the version out of the *installed* copy, so a
  // template whose marker was not bumped reports every agent as carrying the current
  // skill while the text underneath it has changed. Staleness itself is decided by
  // comparing content, which is why this went unnoticed — the marker is what an
  // operator reads.
  for (const name of SKILLS) {
    const template = await readFile(
      new URL(`../templates/skills/${name}/SKILL.md`, import.meta.url),
      'utf8'
    );
    assert.match(
      template,
      new RegExp(`orchestrator-skill:${SKILL_VERSION}\\b`),
      `${name}'s marker and SKILL_VERSION (${SKILL_VERSION}) disagree`
    );
  }
});

test('the protocol names the comms root, so an agent can find status.md', async () => {
  const a = agent();
  const rendered = await renderProtocol(config([a]), a);
  assert.match(rendered, /C:\/YourDirectory\/claude-comms\/status\.md/);
  assert.doesNotMatch(rendered, /\{\{COMMS_ROOT\}\}/, 'every placeholder must be filled');
  assert.doesNotMatch(rendered, /\{\{WORKSPACE_BLOCK\}\}/, 'every placeholder must be filled');
});

test('the previous pointer wording is frozen, not regenerated from the current one', () => {
  // The mistake this guards: the old blocks were generated from the live body with
  // only the marker swapped. It looks like deduplication and it is, right until the
  // wording changes — then every "historic" block silently becomes the new text,
  // matches nothing on any agent's disk, and the upgrade reports the operator's own
  // CLAUDE.md as hand-edited. So the previous body must differ from the current one.
  const historic = historicPointerBlocks();
  assert.ok(historic.length > 0, 'an upgrade needs something to recognise');

  const bodyOf = (b: string) => b.split('\n').slice(1).join('\n');
  const current = bodyOf(pointerBlock());

  // The check is per-version, not blanket, because the version is bumped whenever
  // either half changes and the protocol document changes far more often than the
  // pointer. v7 moved the document alone, so v6's frozen text is *identical* to the
  // current text and must be — an agent on v6 has exactly that on disk. What keeps it
  // honest is the pin below, not an inequality: if someone rewrites the current body
  // and the v6 entry follows it, the pinned text fails here.
  for (const b of historic) {
    if (b.startsWith('<!-- orchestrator-protocol-ref:v6 -->')) continue;
    assert.notEqual(
      bodyOf(b),
      current,
      'a frozen body equals the current one — it was probably generated from it'
    );
  }

  // Pinned against what v6 installed. It reads the same as the current wording today;
  // the pin is what stops it silently becoming tomorrow's.
  const v6 = historic.find((b) => b.startsWith('<!-- orchestrator-protocol-ref:v6 -->'));
  assert.ok(v6, 'v6 is installed on real agents and must stay recognisable');
  assert.ok(
    v6.endsWith(
      'In an ordinary interactive session, that file is also where to look if you find\n'
        + 'work belonging to another agent, a file they own that needs changing, or a question\n'
        + 'only they can answer. You can leave them a message with the `/ledger-note` skill.'
    ),
    'the v6 block must end exactly as it was installed'
  );

  // Pinned against what was read back off a live agent at v5.
  const v5 = historic.find((b) => b.startsWith('<!-- orchestrator-protocol-ref:v5 -->'));
  assert.ok(v5, 'v5 is installed on real agents and must stay recognisable');
  assert.ok(
    v5.endsWith('You can leave them a message with the `/ledger-note` skill.\nAsk me first.'),
    'the v5 block must end exactly as it was installed, "Ask me first." included'
  );

  // The current version is what an upgrade writes, never what it looks for.
  assert.ok(!historic.some((b) => b.includes(`orchestrator-protocol-ref:${PROTOCOL_VERSION}`)));
  assert.match(pointerBlock(), new RegExp(`orchestrator-protocol-ref:${PROTOCOL_VERSION}\\b`));
});

/** An agent home with a CLAUDE.md, for the install paths. */
async function agentWithClaudeMd(claudeMd: string): Promise<{ a: Agent; c: Config; file: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'orch-protocol-'));
  const home = path.join(base, 'agent');
  await mkdir(path.join(home, '.claude'), { recursive: true });
  const file = path.join(home, 'CLAUDE.md');
  await writeFile(file, claudeMd, 'utf8');
  const a = agent({ name: 'installed', home, outbox: path.join(home, 'outbox') });
  return { a, c: config([a]), file };
}

test('a pointer still verbatim from an older version is upgraded in place', async () => {
  // The ordinary update path, and the one that has to keep working: the operator's own
  // sections stay exactly where they are and only the block between them moves version.
  const old = historicPointerBlocks().find((b) =>
    b.startsWith(`<!-- orchestrator-protocol-ref:v${Number(PROTOCOL_VERSION.slice(1)) - 1} -->`)
  );
  assert.ok(old, 'the immediately previous version must be recognisable');

  const { a, c, file } = await agentWithClaudeMd(`# Agent\n\nMine.\n\n${old}\n\n## Shared documents\n\nAlso mine.\n`);
  const r = await installProtocol(a, c);
  assert.equal(r.wrotePointer, true);
  assert.equal(r.forced, false);

  const after = await readFile(file, 'utf8');
  assert.ok(after.includes(pointerBlock()), 'the current block replaces the old one');
  assert.ok(!after.includes(old), 'and the old one is gone, not duplicated');
  assert.ok(after.startsWith('# Agent\n\nMine.'), "the operator's text above survives");
  assert.ok(after.includes('## Shared documents'), "and below");
  assert.equal((await protocolStatus(a, c)).ok, true);

  await rm(path.dirname(a.home), { recursive: true, force: true });
});

test('an edited pointer is declined without --force, and appended beside with it', async () => {
  // COO's case, reduced: a block this application wrote, then reworded by hand. There
  // is no text to match and no safe way to find where it ends, so the choice is to
  // decline or to add beside — never to guess the boundaries.
  const edited = historicPointerBlocks()
    .find((b) => b.startsWith('<!-- orchestrator-protocol-ref:v5 -->'))!
    .replace('In an ordinary session like this one,', 'In an ordinary interactive session,');
  const original = `# Agent\n\nMine.\n\n${edited}\n\n## Shared documents\n\nAlso mine.\n`;
  const { a, c, file } = await agentWithClaudeMd(original);

  const s = await protocolStatus(a, c);
  assert.equal(s.pointerPresent, true);
  assert.equal(s.pointerEdited, true, 'it matches neither the current text nor any past one');
  assert.equal(s.pointerUpgradable, false);
  assert.equal(s.ok, false);

  const declined = await installProtocol(a, c);
  assert.equal(declined.wrotePointer, false);
  assert.equal(await readFile(file, 'utf8'), original, 'declining must not touch the file');
  assert.match(declined.notes.join('\n'), /has been edited since it was written/);

  const forced = await installProtocol(a, c, { force: true });
  assert.equal(forced.forced, true);
  const after = await readFile(file, 'utf8');
  assert.ok(after.includes(edited), 'the edited block survives verbatim — that was the promise');
  assert.ok(after.includes('## Shared documents'), "the operator's own sections survive");
  assert.ok(after.trimEnd().endsWith(pointerBlock()), 'and a current block follows at the end');
  assert.match(forced.notes.join('\n'), /delete the old one by hand/);

  // Idempotent: the second forced run finds its own block verbatim and adds nothing.
  const again = await installProtocol(a, c, { force: true });
  assert.equal(again.wrotePointer, false);
  assert.equal(await readFile(file, 'utf8'), after);

  await rm(path.dirname(a.home), { recursive: true, force: true });
});

test('a pointer edited under a current marker is not mistaken for installed', async () => {
  // The report that started this: the wording was changed, the version was not, and
  // `--install` said "already current" and did nothing. Presence of the right marker is
  // not the test — the block has to be the text this application writes.
  const { a, c } = await agentWithClaudeMd(
    `# Agent\n\n${pointerBlock().replace('Some sessions are started', 'Some sessions here are started')}\n`
  );
  const s = await protocolStatus(a, c);
  assert.equal(s.pointerVersion, PROTOCOL_VERSION);
  assert.equal(s.pointerStale, false, 'the marker really is current');
  assert.equal(s.pointerEdited, true, 'but the text is not, and that has to show');
  assert.equal(s.ok, false);

  await rm(path.dirname(a.home), { recursive: true, force: true });
});

test('no shipped template states a capability — capabilities differ per agent', async () => {
  // The defect this guards: `agent-protocol.md` was installed byte-identical into
  // five directories asserting "you have no shell, and that is deliberate" and "do
  // not write anything anywhere except that one file", while the roster had granted
  // one of them a shell and all five of them write access. Agents believed the
  // document over their own tool list and reported their work as impossible.
  //
  // A phrase list is a blunt instrument, and it is the right one here: the failure
  // mode is somebody writing a confident sentence about tools into a file that
  // cannot know which agent will read it.
  const banned = [
    /you have no shell/i,
    /except (that|those) one file/i,
    /except those files/i,
    /you cannot run the orchestrator/i,
  ];
  for (const file of [templatePath(), path.join(path.dirname(templatePath()), 'prompt', 'v1.md')]) {
    const text = await readFile(file, 'utf8');
    for (const phrase of banned) {
      assert.doesNotMatch(text, phrase, `${path.basename(file)} states a capability it cannot know`);
    }
  }
});

test('two agents in one roster get materially different protocol files', async () => {
  const plain = agent({ name: 'plain' });
  const armed = agent({
    name: 'armed',
    home: 'C:\\YourDirectory\\agents\\armed',
    outbox: 'C:\\YourDirectory\\agents\\armed\\outbox',
    shellAllowed: true,
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite', 'WebSearch', 'WebFetch'],
    paths: [{ path: 'C:\\YourDirectory\\shared', read: true, write: true }],
  });
  const c = config([plain, armed]);

  const a = await renderProtocol(c, plain);
  const b = await renderProtocol(c, armed);
  assert.notEqual(a, b, 'one file for every agent is what caused this');

  assert.match(a, /\*\*A shell:\*\* no/);
  assert.match(b, /\*\*A shell:\*\* yes/);
  assert.match(a, /\*\*The network:\*\* no/);
  assert.match(b, /WebSearch and WebFetch/);
  assert.match(b, /YourDirectory.shared/, 'a granted path is named, so the agent knows it has it');
  assert.doesNotMatch(a, /YourDirectory.shared/, 'and an agent without it is not told it has it');
});

test('a write grant that does not take effect is never promised to the agent', async () => {
  // The two fixes meeting: a dead grant is reported to the operator and withheld
  // from the agent. Telling an agent it may write where it will be refused is the
  // failure this whole pass exists to remove.
  const a = agent({
    paths: [
      { path: 'C:\\YourDirectory\\site', read: true, write: false },
      { path: 'C:\\YourDirectory\\site\\Issues', read: true, write: true },
    ],
  });
  const rendered = await renderProtocol(config([a]), a);
  const writeLine = rendered.split('\n').find((l) => l.startsWith('- **Write:**'))!;
  assert.doesNotMatch(writeLine, /Issues/, 'the dead grant must not appear as a write it has');
});
