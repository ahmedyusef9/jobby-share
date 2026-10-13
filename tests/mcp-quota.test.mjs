import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installAppwriteMemory } from './appwrite-memory.mjs';
import { PLAN, ROLE } from '../scripts/entitlements.mjs';

process.env.JOBBY_MCP_DAILY_LIMIT = '2';
const mem = installAppwriteMemory();
const { MCP_DAILY, consumeMcpCall, mcpDailyLimit, mcpSlotId, mcpUsageToday } = await import('../scripts/mcp-quota.mjs');

const member = { role: ROLE.MEMBER, plan: PLAN.FREE, status: 'active' };
const operator = { role: ROLE.OPERATOR, plan: PLAN.ADVANCED, status: 'active' };
const TENANT = 't_mcpquota01';

test('mcp slot ids are valid Appwrite document ids', () => {
  const id = mcpSlotId(TENANT, '20260818', 0);
  assert.match(id, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/);
});

test('env override wins over the plan table, for tests', () => {
  assert.equal(mcpDailyLimit(process.env, member), 2);
});

test('a member is capped; the third call of the day is 429', async () => {
  mem.reset();
  await consumeMcpCall(member, TENANT);
  await consumeMcpCall(member, TENANT);
  await assert.rejects(
    () => consumeMcpCall(member, TENANT),
    (err) => err.code === MCP_DAILY && err.status === 429 && err.limit === 2,
  );
});

test('the operator is recorded and not capped', async () => {
  mem.reset();
  for (let i = 0; i < 5; i += 1) {
    const slot = await consumeMcpCall(operator, TENANT);
    assert.equal(slot.operator, true);
    assert.equal(slot.limit, null);
  }
});

test('an established tenant allocates the next daily slot without replaying every occupied slot', async () => {
  mem.reset();
  const originalLimit = process.env.JOBBY_MCP_DAILY_LIMIT;
  process.env.JOBBY_MCP_DAILY_LIMIT = '20';
  for (let i = 0; i < 12; i += 1) await consumeMcpCall(member, TENANT);

  const backingFetch = globalThis.fetch;
  let createAttempts = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (init.method === 'POST' && url.pathname.endsWith('/collections/usage_events/documents')) {
      createAttempts += 1;
    }
    return backingFetch(input, init);
  };

  try {
    const slot = await consumeMcpCall(member, TENANT);
    assert.equal(slot.used, 13);
    assert.equal(createAttempts, 1, 'occupied slots should be listed once, not retried as POST conflicts');
  } finally {
    globalThis.fetch = backingFetch;
    process.env.JOBBY_MCP_DAILY_LIMIT = originalLimit;
  }
});

test('operator default tenant does not wait on Appwrite for usage', async () => {
  const backing = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = async () => {
    hits += 1;
    throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
  };
  try {
    const usage = await mcpUsageToday('default', operator);
    const slot = await consumeMcpCall(operator, 'default');
    assert.equal(usage.used, 0);
    assert.equal(usage.limit, null);
    assert.equal(slot.operator, true);
    assert.equal(hits, 0);
  } finally {
    globalThis.fetch = backing;
  }
});
