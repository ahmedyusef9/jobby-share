/** BL-072 — guards: schema validation, budgets, lockout. Pure-logic suite. */
import test from 'node:test';
import assert from 'node:assert/strict';

const g = await import('../scripts/mcp-guards.mjs');

const SCHEMA = {
  type: 'object',
  properties: {
    content: { type: 'string' },
    score: { type: 'number' },
    format: { type: 'string', enum: ['md', 'pdf'] },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['content'],
  additionalProperties: false,
};

test('schema: valid args pass, missing/unknown/wrong-type fail with precise message', () => {
  assert.equal(g.validateAgainstSchema({ content: 'x' }, SCHEMA), null);
  assert.match(g.validateAgainstSchema({}, SCHEMA), /missing required argument: content/);
  assert.match(g.validateAgainstSchema({ content: 'x', zz: 1 }, SCHEMA), /unknown argument: zz/);
  assert.match(g.validateAgainstSchema({ content: 'x', score: 'high' }, SCHEMA), /score must be a number/);
  assert.match(g.validateAgainstSchema({ content: 'x', format: 'doc' }, SCHEMA), /must be one of: md, pdf/);
  assert.match(g.validateAgainstSchema({ content: 'x', tags: [1] }, SCHEMA), /items must be strings/);
});

test('no declared schema = no enforcement', () => {
  assert.equal(g.validateAgainstSchema({ anything: true }, undefined), null);
});

test('per-tool daily budget consumes and exhausts independently', () => {
  g.__resetGuards();
  for (let i = 0; i < 10; i++) assert.equal(g.consumeToolBudget('t1', 'resume_generate'), true);
  assert.equal(g.consumeToolBudget('t1', 'resume_generate'), false); // limit 10 hit
  // other tenants/tools unaffected
  assert.equal(g.consumeToolBudget('t2', 'resume_generate'), true);
  assert.equal(g.consumeToolBudget('t1', 'submit_score'), true);
  const st = g.toolBudgetState('t1', 'resume_generate');
  assert.equal(st.used, 10);
  assert.equal(st.limit, 10);
});

test('auth lockout opens at threshold and clears via reset', () => {
  g.__resetGuards();
  for (let i = 0; i < 19; i++) g.recordAuthFailure('keyA');
  assert.equal(g.isAuthLocked('keyA'), false); // 19 < 20
  g.recordAuthFailure('keyA');
  assert.equal(g.isAuthLocked('keyA'), true); // 20 → locked
  assert.equal(g.isAuthLocked('other'), false); // per-key isolation
  g.clearAuthFailures('keyA');
  assert.equal(g.isAuthLocked('keyA'), false);
});
