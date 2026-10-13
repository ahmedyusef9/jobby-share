/**
 * BL-054 — runtime plan-capability overrides and the RBAC matrix.
 * The gate must keep honoring structural rules no matter what an override says.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAP,
  PLAN,
  ROLE,
  applyPlanCapOverrides,
  can,
  currentPlanCapOverrides,
  rbacMatrix,
} from '../scripts/entitlements.mjs';

const member = (plan) => ({ role: ROLE.MEMBER, plan, status: 'active' });

test('defaults: free plan cannot generate CV', () => {
  applyPlanCapOverrides(null);
  assert.equal(can(member(PLAN.FREE), CAP.GENERATE_CV), false);
});

test('override grants a capability live, reset restores defaults', () => {
  applyPlanCapOverrides({ [PLAN.FREE]: [CAP.SEARCH_JOBS, CAP.GENERATE_CV] });
  assert.equal(can(member(PLAN.FREE), CAP.GENERATE_CV), true);

  applyPlanCapOverrides(null);
  assert.equal(can(member(PLAN.FREE), CAP.GENERATE_CV), false);
});

test('override cannot grant operator-only capabilities', () => {
  assert.throws(
    () => applyPlanCapOverrides({ [PLAN.FREE]: [CAP.ADMIN_CONSOLE] }),
    /operator-only/,
  );
  assert.throws(
    () => applyPlanCapOverrides({ [PLAN.FREE]: [CAP.ADMIN_RBAC] }),
    /operator-only/,
  );
});

test('override rejects unknown plans and capabilities', () => {
  assert.throws(() => applyPlanCapOverrides({ enterprise: [CAP.SEARCH_JOBS] }), /unknown plan/);
  assert.throws(() => applyPlanCapOverrides({ [PLAN.FREE]: ['fly_to_the_moon'] }), /unknown capability/);
  assert.throws(() => applyPlanCapOverrides([CAP.SEARCH_JOBS]), /must be an object/);
});

test('operator bypasses plan gating even under overrides', () => {
  applyPlanCapOverrides({ [PLAN.ADVANCED]: [CAP.SEARCH_JOBS] });
  assert.equal(can({ role: ROLE.OPERATOR, plan: PLAN.ADVANCED, status: 'active' }, CAP.GENERATE_CV), true);
  applyPlanCapOverrides(null);
});

test('rbacMatrix reports shape and override state', () => {
  applyPlanCapOverrides(null);
  const m = rbacMatrix();
  assert.deepEqual(m.plans, Object.values(PLAN));
  assert.deepEqual(m.roles, Object.values(ROLE));
  assert.equal(m.overridden, false);
  assert.ok(m.planCaps[PLAN.FREE].includes(CAP.SEARCH_JOBS));

  applyPlanCapOverrides({ [PLAN.FREE]: [CAP.SEARCH_JOBS] });
  assert.equal(rbacMatrix().overridden, true);
  assert.ok(currentPlanCapOverrides());
  applyPlanCapOverrides(null);
});
