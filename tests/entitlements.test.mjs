import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAP, PLAN, PLAN_LIMITS, ROLE, HOST_ENGINE_DENIAL, HOST_SCORE_DEFERRED, assertSelfFundedEngine, can, defaultPlan, denialReason, isOperator, mayUseEngine, planLimits } from '../scripts/entitlements.mjs';
import { unknownAccount } from '../scripts/accounts.mjs';

const operator = { role: ROLE.OPERATOR, plan: PLAN.ADVANCED, status: 'active' };
const alphaUser = { role: ROLE.MEMBER, plan: PLAN.ALPHA, status: 'active' };
const freeUser = { role: ROLE.MEMBER, plan: PLAN.FREE, status: 'active' };

test('the operator can reach the admin console and no member can', () => {
  assert.equal(can(operator, CAP.ADMIN_CONSOLE), true);
  assert.equal(can(alphaUser, CAP.ADMIN_CONSOLE), false);
  assert.equal(
    can({ role: ROLE.MEMBER, plan: PLAN.ADVANCED, status: 'active' }, CAP.ADMIN_CONSOLE),
    false,
    'the top plan is still not the operator — role and plan are different questions',
  );
});

test('POC users get CV and search; host Score is deferred (D-029)', () => {
  assert.equal(can(alphaUser, CAP.SCORE_JOB), false);
  assert.equal(can(alphaUser, CAP.GENERATE_CV), true);
  assert.equal(can(alphaUser, CAP.CV_CHAT), true);
  assert.equal(can(alphaUser, CAP.MANAGE_OWN_KEYS), true);
  assert.equal(can(operator, CAP.SCORE_JOB), true, 'operator Score may still run');
});

test('the free plan is the later switch: scanning stays, spending stops', () => {
  assert.equal(can(freeUser, CAP.SEARCH_JOBS), true, 'scanning is zero-token, so it stays free');
  assert.equal(can(freeUser, CAP.SCORE_JOB), false);
  assert.equal(can(freeUser, CAP.GENERATE_CV), false);
});

test('a suspended account can do nothing except take its data', () => {
  const suspended = { role: ROLE.MEMBER, plan: PLAN.ALPHA, status: 'suspended' };
  assert.equal(can(suspended, CAP.SCORE_JOB), false);
  assert.equal(can(suspended, CAP.SEARCH_JOBS), false);
  assert.equal(
    can(suspended, CAP.EXPORT_DATA),
    true,
    'locking someone out must not also strip their right to their own files',
  );
});

test('a suspended operator is still suspended', () => {
  const suspendedOperator = { role: ROLE.OPERATOR, plan: PLAN.ADVANCED, status: 'suspended' };
  assert.equal(
    can(suspendedOperator, CAP.ADMIN_CONSOLE),
    false,
    'the status check must come before the role bypass, or suspension means nothing',
  );
});

test('no account means no capability', () => {
  assert.equal(can(null, CAP.SEARCH_JOBS), false);
  assert.equal(can(undefined, CAP.EXPORT_DATA), false);
});

test('an unknown plan falls back to alpha rather than locking a user out', () => {
  const odd = { role: ROLE.MEMBER, plan: 'enterprise-platinum', status: 'active' };
  assert.equal(can(odd, CAP.GENERATE_CV), true);
  assert.equal(can(odd, CAP.SCORE_JOB), false, 'host Score is deferred for every member');
});

test('the POC default is alpha, and one env var closes it for new signups', () => {
  assert.equal(defaultPlan({}), PLAN.ALPHA);
  assert.equal(defaultPlan({ JOBBY_DEFAULT_PLAN: 'free' }), PLAN.FREE);
  assert.equal(defaultPlan({ JOBBY_DEFAULT_PLAN: 'nonsense' }), PLAN.ALPHA);
});

test('isOperator does not treat a plan as a role', () => {
  assert.equal(isOperator(operator), true);
  assert.equal(isOperator({ role: ROLE.MEMBER, plan: PLAN.ADVANCED }), false);
});

test('zero-key rule (BL-058): members may spawn NO engine, on any credentials', () => {
  // Their own keys included — all intelligence happens in the member's own
  // assistant through MCP, never through jobby.
  assert.equal(mayUseEngine(alphaUser, 'openrouter'), false);
  assert.equal(mayUseEngine(alphaUser, 'ollama'), false);
  assert.equal(mayUseEngine(alphaUser, 'api-key'), false);
  assert.equal(mayUseEngine(alphaUser, 'opencode'), false);
  assert.equal(mayUseEngine(alphaUser, 'claude'), false);
  assert.equal(mayUseEngine(alphaUser, 'codex'), false);
  assert.equal(mayUseEngine(alphaUser, 'cursor'), false);
  assert.equal(
    mayUseEngine({ role: ROLE.MEMBER, plan: PLAN.ADVANCED, status: 'active' }, 'openrouter'),
    false,
    'even the top plan runs nothing — zero-key is a role rule, not a plan rule',
  );
  assert.equal(mayUseEngine(operator, 'opencode'), true, 'the operator may use the host CLIs — they are the host');
});

test('assertSelfFundedEngine is the spawn-path 403, not a Config-card hide', () => {
  assert.doesNotThrow(() => assertSelfFundedEngine(operator, 'opencode'));
  assert.throws(
    () => assertSelfFundedEngine(alphaUser, 'openrouter'),
    (err) =>
      err instanceof Error &&
      err.message === HOST_ENGINE_DENIAL &&
      err.status === 403 &&
      err.code === 'HOST_ENGINE',
  );
  assert.throws(
    () => assertSelfFundedEngine(alphaUser, 'opencode'),
    (err) => err instanceof Error && err.message === HOST_ENGINE_DENIAL,
  );
});

/* ------------------------------------------------------------------ *
 * Fail closed on an account the index cannot resolve (JOBBY-BL-049)
 * ------------------------------------------------------------------ */

test('an unknown account may run no engine at all', () => {
  const unknown = unknownAccount('t_missing');
  assert.equal(mayUseEngine(unknown, 'opencode'), false, 'the host engine, obviously');
  assert.equal(
    mayUseEngine(unknown, 'openrouter'),
    false,
    'and not even a self-funded one — we do not know whose key that would be',
  );
});

test('an unknown account is a member, never the operator', () => {
  const unknown = unknownAccount('t_missing');
  assert.equal(isOperator(unknown), false, 'the old fallback answered "operator" here');
  assert.equal(can(unknown, CAP.ADMIN_CONSOLE), false);
  assert.equal(can(unknown, CAP.SCORE_JOB), false);
});

test('an unknown account can still take its data and leave', () => {
  assert.equal(
    can(unknownAccount('t_missing'), CAP.EXPORT_DATA),
    true,
    'failing closed must not trap somebody out of their own files',
  );
});

test('a suspended operator cannot run an engine either', () => {
  const suspended = { role: ROLE.OPERATOR, plan: PLAN.ADVANCED, status: 'suspended' };
  assert.equal(mayUseEngine(suspended, 'opencode'), false, 'status is checked before the bypass');
});

test('plan meters match the $0/$5/$10/$20 table (D-033)', () => {
  assert.equal(PLAN_LIMITS[PLAN.FREE].priceUsd, 0);
  assert.equal(PLAN_LIMITS[PLAN.BASIC].priceUsd, 5);
  assert.equal(PLAN_LIMITS[PLAN.PLUS].priceUsd, 10);
  assert.equal(PLAN_LIMITS[PLAN.ADVANCED].priceUsd, 20);
  assert.equal(planLimits(alphaUser)?.scans, PLAN_LIMITS[PLAN.ALPHA].scans);
  assert.equal(planLimits(freeUser)?.mcp, PLAN_LIMITS[PLAN.FREE].mcp);
  assert.equal(planLimits(operator), null, 'operator is uncapped');
  assert.equal(denialReason(alphaUser, CAP.SCORE_JOB), HOST_SCORE_DEFERRED);
});
