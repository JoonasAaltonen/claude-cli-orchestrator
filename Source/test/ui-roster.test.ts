/**
 * The roster endpoints, over HTTP, against a real server.
 *
 * Worth doing at this level rather than by calling the action functions: the things
 * most likely to be wrong here are the wiring, not the rules — a route that is not
 * reached, a body field read under the wrong name, and above all the config the
 * handlers hold. That last one used to be captured in a closure, which was correct
 * while the dashboard only read; an edit that does not reach the next request is
 * exactly the kind of failure that looks like the edit not having been saved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import vm from 'node:vm';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadConfig } from '../src/config/load.js';
import type { Config } from '../src/config/load.js';
import { initCommsRoot } from '../src/ledger/store.js';
import { startUiServer } from '../src/ui/server.js';
import type { UiServer } from '../src/ui/server.js';
import { MESSAGE_TYPES, OUTCOMES } from '../src/ledger/row.js';
import { GRANT_FIELDS } from '../src/roster/edit.js';
import { INVOCATION_VERDICTS } from '../src/dispatch/sweep.js';
import { writeText } from '../src/util/fsx.js';

const TOKEN = 'test-token-roster';
let n = 0;

async function scratch(): Promise<{ config: Config; base: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `orch-uiroster-${n++}-`));
  for (const name of ['worker', 'spare']) {
    await fs.mkdir(path.join(base, 'agents', name), { recursive: true });
    await writeText(path.join(base, 'agents', name, 'CLAUDE.md'), `# ${name}\n`);
  }
  const configFile = path.join(base, 'orchestrator.config.json');
  await writeText(
    configFile,
    JSON.stringify({
      commsRoot: path.join(base, 'comms'),
      ports: { bindAddress: '127.0.0.1' },
      agents: [{ name: 'worker', home: path.join(base, 'agents', 'worker') }],
    })
  );
  const config = await loadConfig(configFile);
  await initCommsRoot(config);
  return { config, base };
}

async function serve(config: Config): Promise<UiServer> {
  // Port 0: the OS picks one, so two test files can run at once.
  return startUiServer(config, TOKEN, 0);
}

async function get(s: UiServer, route: string): Promise<any> {
  // The token is a query parameter, so a route that already carries one needs `&`.
  const sep = route.includes('?') ? '&' : '?';
  const res = await fetch(`http://127.0.0.1:${s.port}${route}${sep}t=${TOKEN}`);
  return { status: res.status, body: await res.json() };
}

async function post(s: UiServer, route: string, body: unknown): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${s.port}${route}?t=${TOKEN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('the agents payload carries what the config form needs to render', async () => {
  const { config } = await scratch();
  const s = await serve(config);
  try {
    const { body } = await get(s, '/api/agents');
    assert.equal(body.agents.length, 1);
    const w = body.agents[0];
    // Every one of these is read by a form control. A missing key renders as an
    // unticked box rather than an error, so the shape is asserted rather than eyeballed.
    for (const key of ['homeWritable', 'tools', 'paths', 'rationale', 'outbox', 'maxBudgetUsd']) {
      assert.ok(key in w, `${key} is missing from the agents payload`);
    }
    assert.ok(body.defaultModel, 'the model field shows the default as its placeholder');
  } finally {
    await s.close();
  }
});

test('an agent added over HTTP is visible to the very next request', async () => {
  const { config, base } = await scratch();
  const s = await serve(config);
  try {
    const added = await post(s, '/api/agents/add', {
      name: 'spare',
      home: path.join(base, 'agents', 'spare'),
      description: 'registered from the dashboard',
      homeWritable: true,
      tools: ['Read', 'Write', 'WebSearch'],
    });
    assert.equal(added.status, 200, JSON.stringify(added.body));

    // The point of the test: the handlers must be reading the reloaded config.
    const { body } = await get(s, '/api/agents');
    const spare = body.agents.find((a: any) => a.name === 'spare');
    assert.ok(spare, 'the new agent is not in the next response');
    assert.equal(spare.homeWritable, true);
    assert.deepEqual(spare.tools, ['Read', 'Write', 'WebSearch']);
    assert.match(spare.rationale.join(' '), /WebSearch is allowed/);

    // The dashboard shows this text verbatim, so it must be prose an operator can
    // read. The internal requirement identifiers stay on the server side.
    assert.ok(
      spare.rationale.every((r: unknown) => typeof r === 'string'),
      'the payload sends the explanation, not the {what, requirement} pair'
    );
    for (const line of spare.rationale) {
      assert.doesNotMatch(
        line,
        /\b[A-Z][0-9][0-9a-z]?\b/,
        `a requirement identifier reached the dashboard: ${line}`
      );
    }

    // L5 — the outbox is created at registration, because the sweep reads it.
    assert.ok((await fs.stat(path.join(base, 'agents', 'spare', 'outbox'))).isDirectory());
    // X6 — and the permission file is written where the agent lives.
    assert.ok(
      (await fs.stat(path.join(base, 'agents', 'spare', '.claude', 'orchestrator.settings.json'))).isFile()
    );
  } finally {
    await s.close();
  }
});

test('a refused registration comes back as a 400 carrying the requirement', async () => {
  const { config, base } = await scratch();
  const s = await serve(config);
  try {
    const nested = path.join(base, 'agents', 'worker', 'inner');
    await fs.mkdir(nested, { recursive: true });
    const r = await post(s, '/api/agents/add', { name: 'inner', home: nested });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /sits inside "worker"/);
    // The argument travels with the refusal, not just the verdict — but as an
    // argument, not as a citation of an internal document nobody reading this has.
    assert.match(r.body.error, /cannot both be confined/);
    assert.doesNotMatch(r.body.error, /\b[A-Z][0-9][0-9a-z]?\b/);
  } finally {
    await s.close();
  }
});

test('a home is required, and saying so is not a stack trace', async () => {
  const { config } = await scratch();
  const s = await serve(config);
  try {
    const r = await post(s, '/api/agents/add', { name: 'homeless' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /home directory is required/i);
  } finally {
    await s.close();
  }
});

test('an update reaches the generated settings file, not only the config', async () => {
  const { config, base } = await scratch();
  const s = await serve(config);
  try {
    const r = await post(s, '/api/agents/update', { name: 'worker', homeWritable: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const settings = JSON.parse(
      await fs.readFile(path.join(base, 'agents', 'worker', '.claude', 'orchestrator.settings.json'), 'utf8')
    );
    assert.ok(
      settings.permissions.allow.includes('Write(**)'),
      'the file dispatch passes with --settings is regenerated on save'
    );
  } finally {
    await s.close();
  }
});

test('installing the contract writes the protocol file and the skills', async () => {
  const { config, base } = await scratch();
  const s = await serve(config);
  try {
    const r = await post(s, '/api/agents/install', { name: 'worker' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const home = path.join(base, 'agents', 'worker');
    assert.ok((await fs.stat(path.join(home, '.claude', 'orchestrator-protocol.md'))).isFile());
    assert.match(await fs.readFile(path.join(home, 'CLAUDE.md'), 'utf8'), /orchestrator-protocol-ref/);
    assert.ok(r.body.skills.length >= 2, 'both ledger skills are installed together, or one ends up not installed');
  } finally {
    await s.close();
  }
});

test('removing an agent removes the entry and leaves the directory', async () => {
  const { config, base } = await scratch();
  const s = await serve(config);
  try {
    const r = await post(s, '/api/agents/remove', { name: 'worker' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.removed, 'worker');

    const { body } = await get(s, '/api/agents');
    assert.equal(body.agents.length, 0);
    assert.ok(
      (await fs.stat(path.join(base, 'agents', 'worker', 'CLAUDE.md'))).isFile(),
      'the directory belongs to the operator, not to us'
    );
  } finally {
    await s.close();
  }
});

test('the roster endpoints still want the token', async () => {
  const { config } = await scratch();
  const s = await serve(config);
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/api/agents/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'worker' }),
    });
    assert.equal(res.status, 401, 'N4 — loopback authenticates nobody, and this one can delete');
  } finally {
    await s.close();
  }
});

test('the directory picker is reachable, and answers with absolute paths', async () => {
  const { config, base } = await scratch();
  const s = await serve(config);
  try {
    // No path: the roots, so the picker has somewhere to open onto.
    const top = await get(s, '/api/fs');
    assert.equal(top.status, 200);
    assert.ok(top.body.entries.length, 'nothing to start browsing from');

    const listing = await get(s, `/api/fs?path=${encodeURIComponent(base)}`);
    assert.equal(listing.status, 200);
    assert.ok(
      listing.body.entries.some((e: { name: string }) => e.name === 'agents'),
      'the subdirectory that is actually there is not listed'
    );
    for (const e of listing.body.entries) {
      assert.ok(path.isAbsolute(e.path), `${e.path} is not absolute — a rule cannot be built from it`);
    }
  } finally {
    await s.close();
  }
});

test('the picker needs the token like everything else', async () => {
  const { config, base } = await scratch();
  const s = await serve(config);
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/api/fs?path=${encodeURIComponent(base)}`);
    assert.equal(res.status, 401, 'it lists directory names, and that is nobody else\'s business');
  } finally {
    await s.close();
  }
});

/**
 * The page and the payload, checked against each other.
 *
 * This exists because renaming `readPaths` to `paths` broke the Agents tab and no
 * test noticed. Nothing here is type-checked: the page reads `g.readPaths.length`,
 * gets `undefined`, and throws at render time — which showed up as an error banner
 * on every tab and a blank Agents tab, with the payload tests all still green.
 *
 * `g` is the agent variable in both renderers, so every `g.<field>` in the template
 * is a claim about the payload's shape. Here the two are made to agree.
 */
test('every agent field the dashboard reads is one the payload sends', async () => {
  const { config } = await scratch();
  const s = await serve(config);
  try {
    const { body } = await get(s, '/api/agents');
    const sent = new Set(Object.keys(body.agents[0]));

    const html = await fs.readFile(
      path.join(process.cwd(), 'templates', 'ui', 'index.html'),
      'utf8'
    );
    const used = new Set<string>();
    for (const m of html.matchAll(/\bg\.([a-zA-Z_]\w*)/g)) used.add(m[1]!);

    assert.ok(used.size > 10, 'the accesses were not found — has the renderer been rewritten?');
    const missing = [...used].filter((f) => !sent.has(f)).sort();
    assert.deepEqual(
      missing,
      [],
      `the page reads ${missing.join(', ')}, which the payload does not send — every one of those renders as undefined and throws`
    );
  } finally {
    await s.close();
  }
});

// ------------------------------------------------- the vocabulary the page renders
//
// Every menu, checkbox and chip on the dashboard is built from /api/meta. These
// tests are what make that worth doing: they fail if a backend enumeration grows a
// member the page could not offer, which is the failure the arrangement replaced.
// Adding `information` to MESSAGE_TYPES reached the ledger, the validator, the CLI
// and the MCP tool, and stopped one short of the only control an operator can use.

test('/api/meta offers every message type, outcome and grant the backend defines', async () => {
  const { config } = await scratch();
  const s = await serve(config);
  try {
    const { body } = await get(s, '/api/meta');

    assert.deepEqual(
      body.messageTypes.map((t: any) => t.name),
      [...MESSAGE_TYPES],
      'the type menu is the ledger type list, in its order'
    );
    assert.deepEqual(body.outcomes.map((o: any) => o.name), [...OUTCOMES]);
    assert.deepEqual(body.grants.map((g: any) => g.field), [...GRANT_FIELDS]);
    assert.deepEqual(body.verdicts.map((v: any) => v.name), [...INVOCATION_VERDICTS]);

    // Each entry has to carry enough to render with. A name alone would put the
    // labels back in the page, which is where they were.
    for (const t of body.messageTypes) {
      assert.ok(t.what, `${t.name} has no description`);
      assert.ok(t.outcome === 'required' || t.outcome === 'forbidden');
    }
    for (const g of body.grants) {
      assert.ok(g.label && g.hint, `${g.field} has no label or hint`);
      assert.equal(typeof g.fallback, 'boolean');
      assert.ok(g.chip && g.chip.label, `${g.field} has no chip`);
    }
    for (const v of body.verdicts) assert.ok(['ok', 'warn', 'bad'].includes(v.tone));

    // Every tool must render under a heading. One whose group has no label would
    // silently not be offered at all.
    const groups = new Set(body.toolGroups.map((g: any) => g.group));
    for (const t of body.tools) assert.ok(groups.has(t.group), `${t.name} is in an unnamed group`);
  } finally {
    await s.close();
  }
});

test('every grant in the vocabulary is a field the agents payload sends', async () => {
  const { config } = await scratch();
  const s = await serve(config);
  try {
    const meta = (await get(s, '/api/meta')).body;
    const agent = (await get(s, '/api/agents')).body.agents[0];
    for (const g of meta.grants) {
      assert.ok(g.field in agent, `${g.field} is offered as a checkbox but never sent`);
      assert.equal(typeof agent[g.field], 'boolean');
    }
  } finally {
    await s.close();
  }
});

/**
 * The page must not name a grant itself.
 *
 * `grantChips` and `grantBoxes` read `x.field` out of the vocabulary, so a literal
 * `g.shellAllowed` anywhere in the template means someone has started a sixth copy
 * of the list. Cheaper to fail here than to discover it when the seventh flag is
 * added and shows up everywhere but the roster.
 */
test('the dashboard names no grant field of its own', async () => {
  const html = await fs.readFile(
    path.join(process.cwd(), 'templates', 'ui', 'index.html'),
    'utf8'
  );
  const named = GRANT_FIELDS.filter((f) => html.includes('g.' + f) || html.includes("'" + f + "'"));
  assert.deepEqual(named, [], `the page hardcodes ${named.join(', ')} instead of reading /api/meta`);
});

test('the dashboard hardcodes no message type in its markup', async () => {
  const html = await fs.readFile(
    path.join(process.cwd(), 'templates', 'ui', 'index.html'),
    'utf8'
  );
  const hardcoded = MESSAGE_TYPES.filter((t) => html.includes('<option value="' + t + '"'));
  assert.deepEqual(hardcoded, [], `${hardcoded.join(', ')} is typed into the page rather than served`);
});

/**
 * The page's own script, parsed.
 *
 * Nothing compiles this file. A stray edit to it is a blank dashboard discovered by
 * loading the dashboard, and the error appears in a browser console the operator may
 * never open. `vm.Script` parses without executing, so this costs nothing and catches
 * the whole class. It caught its first one the day it was written.
 */
test('the dashboard script parses', async () => {
  const html = await fs.readFile(
    path.join(process.cwd(), 'templates', 'ui', 'index.html'),
    'utf8'
  );
  const script = /<script>([\s\S]*)<\/script>/.exec(html);
  assert.ok(script, 'the page has no script block — has it been restructured?');
  assert.doesNotThrow(() => new vm.Script(script![1]!), 'the dashboard script has a syntax error');
});
