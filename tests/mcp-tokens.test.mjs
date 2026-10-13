import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installAppwriteMemory } from './appwrite-memory.mjs';

const mem = installAppwriteMemory();
const {
  TOKEN_PREFIX,
  MAX_MCP_KEYS,
  createToken,
  hashToken,
  listTokens,
  looksLikeToken,
  mintSecret,
  normalizeKeyName,
  renameToken,
  resolveToken,
  revokeToken,
  serverNameFromLabel,
  normalizeKeyScope,
  normalizeExpiryOption,
  expiryDate,
  isTokenExpired,
  keyStatus,
  tokenDocumentId,
} = await import('../scripts/mcp-tokens.mjs');

test('minted secret looks like jb_ plus 48 hex', () => {
  const token = mintSecret();
  assert.equal(looksLikeToken(token), true);
  assert.equal(token.startsWith(TOKEN_PREFIX), true);
  assert.equal(token.length, TOKEN_PREFIX.length + 48);
  assert.equal(looksLikeToken('not-a-key'), false);
});

test('document id stays inside Appwrite\'s 36-char limit', () => {
  const id = tokenDocumentId(hashToken(mintSecret()));
  assert.match(id, /^mt\.[a-f0-9]{32}$/);
  assert.ok(id.length <= 36);
});

test('normalizeKeyName defaults and sanitizes', () => {
  assert.equal(normalizeKeyName(''), 'jobby');
  assert.equal(normalizeKeyName('  ChatGPT  '), 'ChatGPT');
  assert.equal(serverNameFromLabel('My Cursor'), 'My-Cursor');
});

test('resolveToken returns tenant, scope and expiry that minted it', async () => {
  mem.reset();
  const a = await createToken('t_alice', { name: 'Cursor', scope: 'read', expires: '7d' });
  const hit = await resolveToken(a.token);
  assert.equal(hit?.tenantId, 't_alice');
  assert.equal(hit?.scope, 'read');
  assert.equal(hit?.expiresAt, a.expiresAt);
  assert.equal(hit?.expired, false);
  assert.equal(a.name, 'Cursor');
  assert.equal(await resolveToken(mintSecret()), null);
});

test('scope and expiry normalize safely', () => {
  assert.equal(normalizeKeyScope('read'), 'read');
  assert.equal(normalizeKeyScope('admin'), 'read-write');
  assert.equal(normalizeExpiryOption('30d'), '30d');
  assert.equal(normalizeExpiryOption('forever'), 'never');
  const from = new Date('2026-01-01T00:00:00.000Z');
  assert.equal(expiryDate('7d', from), '2026-01-08T00:00:00.000Z');
  assert.equal(expiryDate('never', from), null);
  assert.equal(isTokenExpired('2026-01-01T00:00:00.000Z', from.getTime()), true);
  assert.equal(keyStatus('2026-01-08T00:00:00.000Z', from.getTime()), 'live');
});

test('adding a second named key keeps the first', async () => {
  mem.reset();
  const first = await createToken('t_bob', { name: 'ChatGPT' });
  const second = await createToken('t_bob', { name: 'Cursor' });
  assert.equal((await resolveToken(first.token))?.tenantId, 't_bob');
  assert.equal((await resolveToken(second.token))?.tenantId, 't_bob');
  const listed = await listTokens('t_bob');
  assert.equal(listed.length, 2);
  assert.deepEqual(
    listed.map((r) => r.name).sort(),
    ['ChatGPT', 'Cursor'],
  );
});

test('rotate: true retires every prior key', async () => {
  mem.reset();
  const first = await createToken('t_dan', { name: 'Old' });
  const second = await createToken('t_dan', { name: 'New', rotate: true });
  assert.equal(await resolveToken(first.token), null, 'old URL must die');
  assert.equal((await resolveToken(second.token))?.tenantId, 't_dan');
  assert.equal((await listTokens('t_dan')).length, 1);
});

test('cap rejects a sixth live key', async () => {
  mem.reset();
  for (let i = 0; i < MAX_MCP_KEYS; i++) {
    await createToken('t_eve', { name: `Key${i}` });
  }
  await assert.rejects(() => createToken('t_eve', { name: 'Overflow' }), /At most/);
});

test('expired keys stay visible for cleanup but do not consume the live-key cap', async () => {
  mem.reset();
  const expired = await createToken('t_expiry', { name: 'Short', expires: '7d' });
  await fetch(`https://appwrite.test/v1/databases/db/collections/mcp_tokens/documents/${expired.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: { expiresAt: '2000-01-01T00:00:00.000Z' } }),
  });
  for (let i = 0; i < MAX_MCP_KEYS; i++) {
    await createToken('t_expiry', { name: `Live${i}` });
  }
  const listed = await listTokens('t_expiry');
  assert.equal(listed.find((row) => row.id === expired.id)?.status, 'expired');
  await assert.rejects(() => createToken('t_expiry', { name: 'Overflow' }), /At most/);
});

test('renameToken updates the label only', async () => {
  mem.reset();
  const a = await createToken('t_frank', { name: 'jobby' });
  const updated = await renameToken('t_frank', a.id, 'ChatGPT');
  assert.equal(updated.name, 'ChatGPT');
  assert.equal((await resolveToken(a.token))?.tenantId, 't_frank');
  assert.equal((await listTokens('t_frank'))[0]?.name, 'ChatGPT');
});

test('revoke by id drops one key; bare revoke drops all', async () => {
  mem.reset();
  const a = await createToken('t_cara', { name: 'A' });
  await createToken('t_cara', { name: 'B' });
  const one = await revokeToken('t_cara', a.id);
  assert.equal(one.revoked, 1);
  assert.equal((await listTokens('t_cara')).length, 1);
  const all = await revokeToken('t_cara');
  assert.equal(all.revoked, 1);
  assert.equal((await listTokens('t_cara')).length, 0);
});

test('listTokens returns empty when Appwrite times out', async () => {
  mem.reset();
  const backing = globalThis.fetch;
  globalThis.fetch = async () => {
    const err = new Error('aborted');
    err.name = 'TimeoutError';
    throw err;
  };
  try {
    assert.deepEqual(await listTokens('t_timeout'), []);
  } finally {
    globalThis.fetch = backing;
  }
});
