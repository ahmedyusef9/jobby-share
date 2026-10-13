import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BATCH_STATE,
  CONFIG_STATE,
  batchBecameFull,
  canTransitionConfig,
  capacityOf,
  defaultConfig,
  evaluateSignup,
  sealConfig,
  transitionBatch,
  validateConfig,
} from '../scripts/release-state.mjs';

const openBatch = (over = {}) => ({
  batchId: 'alpha-1',
  state: BATCH_STATE.OPEN,
  capacity: 10,
  plan: 'alpha',
  ...over,
});

/* ---------------------------------------------------------------- *
 * Batch lifecycle
 * ---------------------------------------------------------------- */

test('a batch cannot open with no capacity', () => {
  const r = transitionBatch({ state: BATCH_STATE.DRAFT, capacity: 0 }, BATCH_STATE.OPEN);
  assert.equal(r.ok, false);
  assert.match(r.error, /capacity/, 'opening an empty batch would show a form nobody can complete');
});

test('draft opens, fills, and closes', () => {
  assert.equal(transitionBatch({ state: BATCH_STATE.DRAFT, capacity: 10 }, BATCH_STATE.OPEN).ok, true);
  assert.equal(transitionBatch(openBatch(), BATCH_STATE.FULL).ok, true);
  assert.equal(transitionBatch(openBatch({ state: BATCH_STATE.FULL }), BATCH_STATE.CLOSED).ok, true);
});

test('a full batch can reopen when capacity is raised', () => {
  const r = transitionBatch(openBatch({ state: BATCH_STATE.FULL, capacity: 12 }), BATCH_STATE.OPEN);
  assert.equal(r.ok, true, 'two more testers must not require inventing a second batch');
});

test('an archived batch is terminal', () => {
  const r = transitionBatch({ state: BATCH_STATE.ARCHIVED, capacity: 10 }, BATCH_STATE.OPEN);
  assert.equal(r.ok, false);
});

test('a draft batch cannot jump straight to full', () => {
  assert.equal(transitionBatch({ state: BATCH_STATE.DRAFT, capacity: 5 }, BATCH_STATE.FULL).ok, false);
});

test('re-applying the current state is a no-op, not an error', () => {
  assert.equal(transitionBatch(openBatch(), BATCH_STATE.OPEN).ok, true);
});

/* ---------------------------------------------------------------- *
 * Capacity
 * ---------------------------------------------------------------- */

test('capacity is derived from the rows that exist, so no counter can drift', () => {
  assert.deepEqual(capacityOf(2, 10), { total: 10, taken: 2, remaining: 8 });
});

test('remaining never goes negative when capacity is lowered below the head count', () => {
  const c = capacityOf(7, 5);
  assert.equal(c.remaining, 0, 'lowering the limit stops new people, it does not evict anybody');
  assert.equal(c.taken, 7);
});

test('taking the last place reports the batch full', () => {
  assert.equal(batchBecameFull(2, 2), true);
  assert.equal(batchBecameFull(2, 3), false);
});

/* ---------------------------------------------------------------- *
 * Signup decisions — registration is OPEN; capacity is the only gate
 * ---------------------------------------------------------------- */

test('anybody may sign up while the round is open and has room', () => {
  const r = evaluateSignup(openBatch({ plan: 'alpha' }), 3, { email: 'a-stranger@x.com' });
  assert.equal(r.allowed, true, 'no invite, no code, no allow-list — capacity is the gate');
  assert.equal(r.plan, 'alpha');
  assert.equal(r.batchId, 'alpha-1');
  assert.equal(r.remaining, 7);
});

test('nobody is refused for being unknown', () => {
  const first = evaluateSignup(openBatch(), 0, { email: 'never-seen@x.com' });
  const second = evaluateSignup(openBatch(), 0, { email: 'also-new@example.org' });
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
});

test('a missing email is the only thing about the applicant that matters', () => {
  const r = evaluateSignup(openBatch(), 0, { email: '   ' });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /valid email/i);
});

test('the last place is given away, and the one after it is not', () => {
  assert.equal(evaluateSignup(openBatch({ capacity: 10 }), 9, { email: 'me@x.com' }).allowed, true);
  const full = evaluateSignup(openBatch({ capacity: 10 }), 10, { email: 'me@x.com' });
  assert.equal(full.allowed, false);
  assert.match(full.reason, /full/i);
});

test('a full round tells people to come back, and never mentions invitations', () => {
  const r = evaluateSignup(openBatch({ state: BATCH_STATE.FULL }), 10, { email: 'me@x.com' });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /check back/i);
  assert.doesNotMatch(r.reason, /invit/i);
});

test('draft and closed batches refuse with different, honest messages', () => {
  const draft = evaluateSignup(openBatch({ state: BATCH_STATE.DRAFT }), 0, { email: 'me@x.com' });
  const closed = evaluateSignup(openBatch({ state: BATCH_STATE.CLOSED }), 0, { email: 'me@x.com' });
  assert.match(draft.reason, /not opened/i);
  assert.match(closed.reason, /closed/i);
});

test('no batch at all means signups are shut, not that the email is wrong', () => {
  const r = evaluateSignup(null, 0, { email: 'me@x.com' });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /not open/i);
});

/* ---------------------------------------------------------------- *
 * Config versions
 * ---------------------------------------------------------------- */

test('an unknown setting is rejected, never silently dropped', () => {
  const r = validateConfig({ defaultPlan: 'free', sneakySecret: 'x' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown setting/.test(e)));
});

test('a bad plan value is refused', () => {
  assert.equal(validateConfig({ defaultPlan: 'platinum' }).ok, false);
});

test('missing settings fall back to defaults', () => {
  const r = validateConfig({ maxAccounts: 25 });
  assert.equal(r.ok, true);
  assert.equal(r.value.maxAccounts, 25);
  assert.equal(r.value.defaultPlan, defaultConfig().defaultPlan);
});

test('the loaded config cannot be mutated at runtime', () => {
  const cfg = sealConfig({ maxAccounts: 10 });
  assert.throws(() => {
    "use strict";
    cfg.maxAccounts = 9999;
  }, TypeError);
});

test('config versions go draft to active to retired, and never back', () => {
  assert.equal(canTransitionConfig(CONFIG_STATE.DRAFT, CONFIG_STATE.ACTIVE), true);
  assert.equal(canTransitionConfig(CONFIG_STATE.ACTIVE, CONFIG_STATE.RETIRED), true);
  assert.equal(
    canTransitionConfig(CONFIG_STATE.RETIRED, CONFIG_STATE.ACTIVE),
    false,
    'reviving an old version silently changes what a past release meant',
  );
});

test('raising capacity on a full round reopens it, rather than needing a new batch', () => {
  const r = transitionBatch({ state: BATCH_STATE.FULL, capacity: 15 }, BATCH_STATE.OPEN);
  assert.equal(r.ok, true, 'admitting five more people must not require a second cohort');
});
