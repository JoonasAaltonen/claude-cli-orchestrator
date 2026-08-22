/**
 * Rate-limit recognition (V5) and the back-off it drives (V6).
 *
 * These exist because of a real run: the CLI refused two invocations against the
 * five-hour limit, the log recorded `rate_limit_info.status: "rejected"`, and the
 * detector read straight past it. The verdict came out `process-failed`, so the
 * chain never stopped and the loop dispatched again one second later — into the
 * same closed door, for nothing. The operator saw "a CLI-level fault".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRateLimit, rateLimitResetsAt } from '../src/dispatch/invoke.js';

/** Verbatim from state/invocations.jsonl, the invocation that was refused. */
const REJECTED = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'rejected',
    resetsAt: 1787380800,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'out_of_credits',
    isUsingOverage: false,
  },
  uuid: 'd5f7b865-f34a-4fb1-aa29-bdd4ae41f78d',
  session_id: 'b9b27bd0-f6b2-494e-a804-efafc377a35d',
};

/** Verbatim from the invocation before it, which ran perfectly well. */
const ALLOWED = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: 1787380800,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'out_of_credits',
    isUsingOverage: false,
  },
};

/** And the one at 99% utilisation, which also ran and produced a message. */
const WARNING = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed_warning',
    resetsAt: 1787380800,
    rateLimitType: 'five_hour',
    utilization: 0.99,
    isUsingOverage: false,
    surpassedThreshold: 0.9,
  },
};

test('a rejected rate_limit_event is a limit — the case that was missed', () => {
  assert.equal(detectRateLimit(REJECTED), true);
});

test('an allowed rate_limit_event is not a limit', () => {
  assert.equal(detectRateLimit(ALLOWED), false);
});

test('a 99% warning is not a limit — it still ran and produced a message', () => {
  // Stopping here would end chains that had headroom, and V5 forbids predicting
  // availability from usage numbers. The status field is the only authority.
  assert.equal(detectRateLimit(WARNING), false);
});

test('overageStatus is never mistaken for the limit status', () => {
  // The trap: `overageStatus: "rejected"` is present on healthy invocations too,
  // because it only means overage billing is off. Keying on it would have made
  // every single invocation look rate-limited.
  assert.equal(ALLOWED.rate_limit_info.overageStatus, 'rejected');
  assert.equal(detectRateLimit(ALLOWED), false);
});

test('the typed error shapes still count', () => {
  assert.equal(detectRateLimit({ error: { type: 'rate_limit_error' } }), true);
  assert.equal(detectRateLimit({ error: { status: 429 } }), true);
  assert.equal(detectRateLimit({ type: 'result', subtype: 'usage_limit_reached' }), true);
});

test('ordinary events are not limits', () => {
  assert.equal(detectRateLimit({ type: 'assistant' }), false);
  assert.equal(detectRateLimit({ type: 'result', subtype: 'success', is_error: false }), false);
  assert.equal(detectRateLimit(null), false);
  assert.equal(detectRateLimit('rate limit exceeded'), false);
});

test('no phrase in free text can trigger a limit', () => {
  // V5 — recognised mechanically, not by matching a string. An agent that writes
  // the words must not be able to stop the chain.
  assert.equal(
    detectRateLimit({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'You have hit your session limit, rate_limit_error' }] },
    }),
    false
  );
});

test('the reset time is read off the event so the operator knows when to return', () => {
  assert.equal(rateLimitResetsAt(REJECTED), '2026-08-22T06:40:00.000Z');
});

test('a missing or malformed reset time is null, not a bogus date', () => {
  assert.equal(rateLimitResetsAt({ rate_limit_info: {} }), null);
  assert.equal(rateLimitResetsAt({ rate_limit_info: { resetsAt: 'soon' } }), null);
  assert.equal(rateLimitResetsAt(null), null);
});
