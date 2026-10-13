import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'jobby-mcp-local-'));
process.env.CAREER_OPS_ROOT = ROOT;

const { createToken, listTokens, resolveToken, revokeToken } = await import('../scripts/mcp-tokens.mjs');

test('operator default tenant mints without Appwrite', async () => {
  let appwriteHits = 0;
  const backing = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    appwriteHits += 1;
    return backing.apply(globalThis, args);
  };
  try {
    const minted = await createToken('default', { name: 'ChatGPT', expires: '30d' });
    assert.equal(minted.name, 'ChatGPT');
    assert.match(minted.token, /^jb_/);
    const listed = await listTokens('default');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'ChatGPT');
    assert.equal((await resolveToken(minted.token))?.tenantId, 'default');
    const store = path.join(ROOT, 'tenants', 'default', 'data', 'mcp-tokens.json');
    assert.equal(fs.existsSync(store), true);
    assert.equal(JSON.parse(fs.readFileSync(store, 'utf8')).keys[0].id, minted.id);
    assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(store, 'utf8'))).includes(minted.token), false);
    const gone = await revokeToken('default', minted.id);
    assert.equal(gone.revoked, 1);
    assert.equal((await listTokens('default')).length, 0);
    assert.equal(appwriteHits, 0, 'default tenant must not call Appwrite');
  } finally {
    globalThis.fetch = backing;
  }
});
