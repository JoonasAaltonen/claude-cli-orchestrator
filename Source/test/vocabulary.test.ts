/**
 * The two agent-facing templates hand-list the message types and outcomes, and nothing
 * used to check that the lists still matched the code.
 *
 * D8 is why they are not generated: the prompt template is "a versioned interface an
 * operator may rewrite", and a generated block inside it would be overwritten by the
 * operator or, worse, silently disagree with the prose around it. Both files are meant
 * to be edited by hand.
 *
 * But "not generated" was quietly being read as "not checked". Both templates carried
 * `report · request · response · signoff · decision · information` and `done ·
 * deferred · rejected · blocked` as literal text, so adding a type or an outcome left
 * every agent reading a list that did not contain it — and an agent cannot use a value
 * it has never been shown. `row.ts` claimed `doctor` cross-checked the two. It did not.
 * This does.
 *
 * The check is deliberately weak: presence of each name somewhere in the file. Anything
 * stronger would be asserting the prose, which is the operator's to write.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { appRoot } from '../src/config/load.js';
import { MESSAGE_TYPES, OUTCOMES, MESSAGE_TYPE_INFO, OUTCOME_INFO, OUTCOME_TYPES, CLOSING_OUTCOMES, ANSWERING_TYPES } from '../src/ledger/row.js';
import { OUTSTANDING_REASONS, REASON_INFO } from '../src/ledger/fold.js';

const TEMPLATES = [
  path.join(appRoot(), 'templates', 'agent-protocol.md'),
  path.join(appRoot(), 'templates', 'prompt', 'v1.md'),
];

for (const file of TEMPLATES) {
  test(`every message type is named in ${path.basename(path.dirname(file))}/${path.basename(file)}`, async () => {
    const text = await readFile(file, 'utf8');
    for (const t of MESSAGE_TYPES) {
      assert.ok(
        text.includes(t),
        `"${t}" is a legal message type but is never mentioned in ${file}. An agent cannot use a value it has not been shown.`
      );
    }
  });

  test(`every outcome is named in ${path.basename(path.dirname(file))}/${path.basename(file)}`, async () => {
    const text = await readFile(file, 'utf8');
    for (const o of OUTCOMES) {
      assert.ok(
        text.includes(o),
        `"${o}" is a legal outcome but is never mentioned in ${file}.`
      );
    }
  });
}

test('the derived sets stay in step with the tables they come from', () => {
  // These exist so that adding a type or an outcome cannot silently skip a rule. If one
  // is ever hand-maintained again, this is where it shows.
  for (const t of MESSAGE_TYPES) {
    assert.equal(
      OUTCOME_TYPES.has(t),
      MESSAGE_TYPE_INFO[t].outcome === 'required',
      `OUTCOME_TYPES disagrees with the type table about ${t}`
    );
    assert.equal(
      ANSWERING_TYPES.has(t),
      MESSAGE_TYPE_INFO[t].answers,
      `ANSWERING_TYPES disagrees with the type table about ${t}`
    );
  }
  for (const o of OUTCOMES) {
    assert.equal(CLOSING_OUTCOMES.has(o), OUTCOME_INFO[o].closes, `CLOSING_OUTCOMES disagrees about ${o}`);
  }
});

test('an answering type both carries an outcome and names the row it answers', () => {
  // Discharging a request without saying which one, or without saying how it went,
  // would leave the fold unable to tell whether the request is finished.
  for (const t of MESSAGE_TYPES) {
    if (!MESSAGE_TYPE_INFO[t].answers) continue;
    assert.equal(MESSAGE_TYPE_INFO[t].outcome, 'required', `${t} answers a request, so it needs an outcome`);
    assert.equal(MESSAGE_TYPE_INFO[t].replyTo, 'required', `${t} answers a request, so it must name it`);
  }
});

test('every outcome tells a cold requester what to do with it', () => {
  // The requester's invocation is the point of the return leg, and a cold agent has no
  // way to work out for itself that `blocked` must not be re-sent while `partial`
  // often should be. An empty string here would produce an invocation with no guidance.
  for (const o of OUTCOMES) {
    assert.ok(OUTCOME_INFO[o].onReceipt.length > 30, `${o} has no usable onReceipt guidance`);
    assert.ok(OUTCOME_INFO[o].what.length > 10, `${o} has no description`);
  }
});

test('every outstanding reason says what it means on both surfaces', () => {
  // Three separate switches over this union existed before it became a record, and a
  // reason with a missing arm falls through to whichever branch is last — telling an
  // agent the wrong thing about why it was invoked.
  for (const r of OUTSTANDING_REASONS) {
    assert.ok(REASON_INFO[r].short.length > 3, `${r} has no short label`);
    assert.ok(REASON_INFO[r].onYou.length > 10, `${r} has nothing to say to the agent`);
  }
});
