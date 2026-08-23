/**
 * Editing the roster, and the two grants that were missing from it.
 *
 * Both grants exist because of the same measured failure: an agent asked to research
 * something and write a document could do neither, and *neither refusal was visible*.
 * The web tool was absent from `--tools`, so the agent reported that no web search
 * was available and answered from memory; the write to its own home was denied, so it
 * wrote an apology instead of a file. From the ledger both look like an agent that
 * chose not to do the work.
 *
 * The rules around the edits are tested here rather than in the CLI's own tests
 * because both front-ends now call this module. A rule that held only on the command
 * line would be a write boundary the dashboard could quietly register around (X4).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadConfig, repoRoot } from '../src/config/load.js';
import type { Config } from '../src/config/load.js';
import { writeText } from '../src/util/fsx.js';
import { buildPermissionPlan } from '../src/dispatch/permissions.js';
import { addAgent, removeAgent, updateAgent, RosterError, TOOL_CATALOGUE } from '../src/roster/edit.js';

let n = 0;

/** A base directory with one registered agent and one unregistered directory beside it. */
async function scratch(): Promise<{ config: Config; base: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `orch-roster-${n++}-`));
  const agents = path.join(base, 'agents');
  for (const name of ['worker', 'spare']) {
    await fs.mkdir(path.join(agents, name), { recursive: true });
    await writeText(path.join(agents, name, 'CLAUDE.md'), `# ${name}\n`);
  }
  const configFile = path.join(base, 'orchestrator.config.json');
  await writeText(
    configFile,
    JSON.stringify({
      commsRoot: path.join(base, 'comms'),
      agents: [{ name: 'worker', home: path.join(agents, 'worker') }],
    })
  );
  return { config: await loadConfig(configFile), base };
}

function agentOf(c: Config, name: string) {
  const a = c.agents.find((x) => x.name === name);
  assert.ok(a, `${name} is not in the roster`);
  return a;
}

async function rejects(fn: () => Promise<unknown>, match: RegExp): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof RosterError, `expected a RosterError, got ${String(err)}`);
    assert.match([err.message, ...err.details].join(' '), match);
    return true;
  });
}

// ---------------------------------------------------------------- registration

test('an agent is registered with its outbox derived, not configured', async () => {
  const { config, base } = await scratch();
  const { config: next, agent } = await addAgent(config, {
    name: 'spare',
    home: path.join(base, 'agents', 'spare'),
    description: 'a second one',
  });
  assert.equal(next.agents.length, 2);
  assert.equal(agent.outbox, path.join(base, 'agents', 'spare', 'outbox'));
  assert.equal(agent.description, 'a second one');
  // Defaults, through either front-end. Its own home is writable — an agent that
  // cannot write where it lives cannot do the work it was registered for — and
  // everything that reaches past its home, or past the filesystem, starts closed.
  assert.equal(agent.homeWritable, true);
  assert.equal(agent.shellAllowed, false);
  assert.equal(agent.allowMcp, false);
  assert.equal(agent.allowSubagents, false);
  assert.deepEqual(agent.paths, []);
});

test('a home nested inside a registered agent is refused (X4)', async () => {
  const { config, base } = await scratch();
  const nested = path.join(base, 'agents', 'worker', 'inner');
  await fs.mkdir(nested, { recursive: true });
  await rejects(() => addAgent(config, { name: 'inner', home: nested }), /sits inside "worker"/);
});

test('a home that is the orchestrator itself is refused (P4)', async () => {
  const { config } = await scratch();
  await rejects(() => addAgent(config, { name: 'self', home: repoRoot() }), /overlaps the orchestrator/);
});

test('a home overlapping the comms root is refused (L4)', async () => {
  const { config, base } = await scratch();
  const comms = path.join(base, 'comms');
  await fs.mkdir(comms, { recursive: true });
  await rejects(() => addAgent(config, { name: 'ledgerish', home: comms }), /overlaps the comms root/);
});

test('a directory that does not exist is refused — this tool registers, it does not create', async () => {
  const { config, base } = await scratch();
  await rejects(
    () => addAgent(config, { name: 'ghost', home: path.join(base, 'nowhere') }),
    /does not create them/
  );
});

test('reserved and duplicate names are refused', async () => {
  const { config, base } = await scratch();
  const home = path.join(base, 'agents', 'spare');
  await rejects(() => addAgent(config, { name: 'operator', home }), /reserved for the human/);
  await rejects(() => addAgent(config, { name: 'orchestrator', home }), /reserved for the application/);
  await rejects(() => addAgent(config, { name: 'WORKER', home }), /already in the roster/);
});

test('a missing CLAUDE.md is a warning, not a refusal (X5)', async () => {
  const { config, base } = await scratch();
  const bare = path.join(base, 'bare');
  await fs.mkdir(bare, { recursive: true });
  const { warnings } = await addAgent(config, { name: 'bare', home: bare });
  assert.match(warnings.join(' '), /no CLAUDE\.md/i);
});

// ---------------------------------------------------------------------- edits

test('an update changes only what the patch names', async () => {
  const { config } = await scratch();
  const { config: next } = await updateAgent(config, 'worker', { homeWritable: true });
  const w = agentOf(next, 'worker');
  assert.equal(w.homeWritable, true);
  assert.equal(w.description, '', 'an absent field is left alone, not blanked');
});

test('a blank model clears the override rather than storing an empty string', async () => {
  const { config } = await scratch();
  const set = await updateAgent(config, 'worker', { model: 'haiku' });
  assert.equal(agentOf(set.config, 'worker').model, 'haiku');
  const cleared = await updateAgent(set.config, 'worker', { model: '' });
  assert.equal(agentOf(cleared.config, 'worker').model, undefined);
});

test('an unknown tool name is dropped rather than stored', async () => {
  const { config } = await scratch();
  const { config: next } = await updateAgent(config, 'worker', {
    tools: ['Read', 'WebSearch', 'Bash', 'NotARealTool'],
  });
  const tools = agentOf(next, 'worker').tools;
  assert.deepEqual(tools, ['Read', 'WebSearch']);
  assert.ok(!tools.includes('Bash'), 'shell is governed by its own flag, not by this list');
});

test('removing an agent leaves its directory and its rows alone', async () => {
  const { config, base } = await scratch();
  const home = path.join(base, 'agents', 'worker');
  const { config: next, removed } = await removeAgent(config, 'WORKER');
  assert.equal(removed.name, 'worker', 'the roster spelling comes back, not the caller\'s');
  assert.equal(next.agents.length, 0);
  assert.ok(await fs.stat(path.join(home, 'CLAUDE.md')), 'the directory is untouched');
});

test('removing something that is not there says so', async () => {
  const { config } = await scratch();
  await rejects(() => removeAgent(config, 'nobody'), /not in the roster/);
});

// ------------------------------------------------------- what the grants do

test('without homeWritable an agent can write only into its outbox', async () => {
  const { config } = await scratch();
  // Asked for explicitly: home-writable is the default, and this is the agent that
  // was deliberately confined.
  const { config: next } = await updateAgent(config, 'worker', { homeWritable: false });
  const allow = buildPermissionPlan(next, agentOf(next, 'worker')).settings.permissions.allow;
  assert.ok(allow.some((r) => r.startsWith('Write(outbox/')), 'the outbox rule is there');
  assert.ok(!allow.includes('Write(**)'), 'and nothing wider');
});

test('homeWritable grants the whole home in both spellings', async () => {
  const { config } = await scratch();
  const { config: next } = await updateAgent(config, 'worker', { homeWritable: true });
  const agent = agentOf(next, 'worker');
  const allow = buildPermissionPlan(next, agent).settings.permissions.allow;

  // Both forms for the reason the outbox rule carries both: the relative form is the
  // one measured to match on this CLI, the absolute one is what a later version is
  // most likely to standardise on.
  assert.ok(allow.includes('Write(**)'));
  assert.ok(
    allow.includes(`Write(${agent.home.split(path.sep).join('/')}/**)`),
    'the absolute form names the home exactly, with no prefix — a prefixed rule matches nothing'
  );
  for (const tool of ['Edit', 'MultiEdit', 'NotebookEdit']) {
    assert.ok(allow.includes(`${tool}(**)`), `${tool} is granted alongside Write`);
  }
});

test('homeWritable does not reopen the self-grant paths — deny beats allow', async () => {
  const { config } = await scratch();
  const { config: next } = await updateAgent(config, 'worker', { homeWritable: true });
  const plan = buildPermissionPlan(next, agentOf(next, 'worker'));
  const deny = plan.settings.permissions.deny;
  for (const p of ['.claude/settings.json', '.mcp.json', '.claude/agents/**', '.claude/orchestrator.settings.json']) {
    assert.ok(deny.includes(`Write(${p})`), `${p} is still denied`);
  }
});

test('the comms root stays read-only however wide the home grant is', async () => {
  const { config } = await scratch();
  const { config: next } = await updateAgent(config, 'worker', { homeWritable: true });
  const plan = buildPermissionPlan(next, agentOf(next, 'worker'));
  assert.ok(
    plan.settings.permissions.deny.some((r) => r.startsWith('Write(') && r.includes('comms')),
    'T6/L2 — only the application writes the ledger'
  );
});

/**
 * The measured one. WebSearch present in `--tools` and absent from `--allowed-tools`
 * is denied under `--permission-mode dontAsk`, because a tool with no allow rule
 * needs a prompt and there is nobody to answer it. Every other tool an agent uses is
 * either path-scoped or covered by workspace confinement; these two reach outside it
 * and so have neither.
 */
test('a network tool in the tool list is also granted by name', async () => {
  const { config } = await scratch();
  const { config: next } = await updateAgent(config, 'worker', {
    tools: ['Read', 'Write', 'WebSearch'],
  });
  const plan = buildPermissionPlan(next, agentOf(next, 'worker'));
  assert.ok(plan.tools.includes('WebSearch'), 'it is in --tools');
  assert.ok(
    plan.settings.permissions.allow.includes('WebSearch'),
    'and in --allowed-tools, without which it is silently refused on use'
  );
  assert.ok(!plan.settings.permissions.allow.includes('WebFetch'), 'and only the one asked for');
});

test('a network tool nobody asked for is granted nowhere', async () => {
  const { config } = await scratch();
  const plan = buildPermissionPlan(config, agentOf(config, 'worker'));
  assert.ok(!plan.settings.permissions.allow.includes('WebSearch'));
  assert.ok(!plan.tools.includes('WebSearch'));
});

test('every catalogue entry that reaches the network says so', async () => {
  for (const t of TOOL_CATALOGUE) {
    if (t.group === 'network') {
      assert.ok(t.caution, `${t.name} is a network tool and must carry a caution`);
    }
  }
  assert.ok(
    !TOOL_CATALOGUE.some((t) => ['Bash', 'Task', 'Agent'].includes(t.name)),
    'shell and subagents are governed by their own flags and must not appear twice'
  );
});
