/**
 * §7 — the permission model. These assert the *denials*, because the rule
 * underneath all of §7 is that an allow list shapes the easy path and only a deny
 * rule enforces a boundary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPermissionPlan, SHELL_TOOLS, rulePath } from '../src/dispatch/permissions.js';
import { buildArgv, FORBIDDEN_FLAGS } from '../src/dispatch/invoke.js';
import type { Config, Agent } from '../src/config/load.js';
import { MCP_TOOL_ID, SKILL_NAME, SKILL_COMMAND } from '../src/contract/names.js';
import { mcpConfigPathFor } from '../src/mcp/config.js';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SKILLS } from '../src/contract/names.js';
import { PROTOCOL_VERSION, renderProtocol } from '../src/cli/protocol.js';

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

test('the protocol names the comms root, so an agent can find status.md', async () => {
  const rendered = await renderProtocol('C:\\YourDirectory\\claude-comms');
  assert.match(rendered, /C:\/YourDirectory\/claude-comms\/status\.md/);
  assert.doesNotMatch(rendered, /\{\{COMMS_ROOT\}\}/, 'every placeholder must be filled');
  // T5: forward slashes, because this goes into prose an agent may quote back.
  assert.doesNotMatch(rendered, /C:\\YourDirectory/);
});
