import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

/**
 * The store resolves paths through CAREER_OPS_ROOT at call time, so each test
 * points it at a scratch tree. Import once; the module holds no cached root.
 */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'jobby-keys-'));
process.env.CAREER_OPS_ROOT = ROOT;
process.env.JOBBY_MASTER_KEY = crypto.randomBytes(32).toString('base64');

const {
  getKeyForJob,
  keyStorePath,
  listTenantKeys,
  masterKey,
  setTenantKey,
  deleteTenantKey,
  deleteAllTenantKeys,
  tenantSecretEnv,
} = await import('../scripts/key-store.mjs');

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('a key saved by one tenant is invisible to another', () => {
  setTenantKey('alice', 'openrouter', 'sk-or-alice-secret-1234');

  assert.equal(getKeyForJob('alice', 'openrouter'), 'sk-or-alice-secret-1234');
  assert.equal(getKeyForJob('bob', 'openrouter'), null, "bob must not see alice's key");
  assert.deepEqual(listTenantKeys('bob'), [], 'bob has no keys at all');
});

test('saving a key never writes it into process.env', () => {
  delete process.env.ANTHROPIC_API_KEY;
  setTenantKey('carol', 'anthropic', 'sk-ant-carol-9999');
  assert.equal(
    process.env.ANTHROPIC_API_KEY,
    undefined,
    'the shared global must stay empty — this is the leak that started BL-021',
  );
});

test("a store file copied into another tenant's directory fails to decrypt", () => {
  setTenantKey('dave', 'openai', 'sk-dave-abcd');
  const stolen = fs.readFileSync(keyStorePath('dave'), 'utf8');

  const victimPath = keyStorePath('erin');
  fs.mkdirSync(path.dirname(victimPath), { recursive: true });
  fs.writeFileSync(victimPath, stolen);

  assert.equal(
    getKeyForJob('erin', 'openai'),
    null,
    'AAD binds ciphertext to its tenant, so a moved blob is undecryptable, not mis-attributed',
  );
});

test('metadata exposes last4 and never the key', () => {
  setTenantKey('frank', 'gemini', 'AIza-frank-secret-tail');
  const [entry] = listTenantKeys('frank');
  assert.equal(entry.provider, 'gemini');
  assert.equal(entry.last4, 'tail');
  const serialized = JSON.stringify(listTenantKeys('frank'));
  assert.ok(!serialized.includes('AIza-frank-secret-tail'), 'listing must not carry the secret');
});

test('the key at rest is ciphertext, not the plaintext key', () => {
  setTenantKey('grace', 'openrouter', 'sk-or-grace-plain-text');
  const onDisk = fs.readFileSync(keyStorePath('grace'), 'utf8');
  assert.ok(!onDisk.includes('sk-or-grace-plain-text'), 'file must not contain the raw key');
});

test('multi-tenant mode ignores provider keys in the server environment', () => {
  withEnv({ AUTH_SINGLE_TENANT: '0', OPENROUTER_API_KEY: 'sk-operator-key' }, () => {
    const env = tenantSecretEnv('heidi');
    assert.equal(
      env.OPENROUTER_API_KEY,
      undefined,
      "one operator key must not become every tenant's key",
    );
  });
});

test('single-tenant mode still honours the operator environment', () => {
  withEnv({ AUTH_SINGLE_TENANT: '1', OPENROUTER_API_KEY: 'sk-operator-key' }, () => {
    const env = tenantSecretEnv('default');
    assert.equal(env.OPENROUTER_API_KEY, 'sk-operator-key', 'local single-user install keeps working');
  });
});

test("a tenant's own stored key wins over the environment", () => {
  setTenantKey('ivan', 'openrouter', 'sk-ivan-own');
  withEnv({ AUTH_SINGLE_TENANT: '1', OPENROUTER_API_KEY: 'sk-operator-key' }, () => {
    assert.equal(tenantSecretEnv('ivan').OPENROUTER_API_KEY, 'sk-ivan-own');
  });
});

test('deleting a key removes it', () => {
  setTenantKey('judy', 'openai', 'sk-judy-1111');
  assert.equal(deleteTenantKey('judy', 'openai'), true);
  assert.equal(getKeyForJob('judy', 'openai'), null);
  assert.equal(deleteTenantKey('judy', 'openai'), false, 'second delete is a no-op');
});

test('deleteAllTenantKeys removes keys by name while the directory stays', () => {
  setTenantKey('mona', 'openrouter', 'sk-or-mona-aaaa');
  setTenantKey('mona', 'openai', 'sk-mona-bbbb');
  const dir = path.dirname(keyStorePath('mona'));
  const removed = deleteAllTenantKeys('mona');
  assert.deepEqual(removed.sort(), ['openai', 'openrouter']);
  assert.equal(getKeyForJob('mona', 'openrouter'), null);
  assert.equal(listTenantKeys('mona').length, 0);
  assert.ok(!fs.existsSync(keyStorePath('mona')));
  assert.ok(fs.existsSync(dir), 'the tenant directory must survive named key deletion');
});

test('rotating a key replaces the value and bumps keyVersion', () => {
  const first = setTenantKey('ken', 'anthropic', 'sk-ant-first');
  const second = setTenantKey('ken', 'anthropic', 'sk-ant-second');
  assert.equal(first.keyVersion, 1);
  assert.equal(second.keyVersion, 2);
  assert.equal(getKeyForJob('ken', 'anthropic'), 'sk-ant-second');
});

test('production without JOBBY_MASTER_KEY fails closed', () => {
  withEnv({ NODE_ENV: 'production', JOBBY_MASTER_KEY: undefined }, () => {
    assert.throws(() => masterKey(), /JOBBY_MASTER_KEY is required/);
  });
});

test('tenant ids that walk the filesystem are rejected', () => {
  assert.throws(() => setTenantKey('../escape', 'openai', 'sk-x'), /invalid tenant id/);
  assert.throws(() => getKeyForJob('a/b', 'openai'), /invalid tenant id/);
});
