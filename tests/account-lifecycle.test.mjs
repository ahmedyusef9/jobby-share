import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { installAppwriteMemory } from './appwrite-memory.mjs';

const aw = installAppwriteMemory();
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'jobby-lifecycle-'));
process.env.CAREER_OPS_ROOT = ROOT;
process.env.JOBBY_MASTER_KEY = crypto.randomBytes(32).toString('base64');

const { ACCOUNT_STATUS, canSignIn, resolveAccount, accountByTenant, forgetAccount } = await import(
  '../scripts/accounts.mjs'
);
const { setTenantKey, getKeyForJob, keyStorePath } = await import('../scripts/key-store.mjs');
const {
  containedTenantDir,
  exportTenantArchive,
  purgeAccount,
  purgeExpiredAccounts,
  requestDeletion,
  restoreAccount,
  zipBuffers,
} = await import('../scripts/account-lifecycle.mjs');

const WEEK = 8 * 24 * 60 * 60 * 1000;

beforeEach(() => {
  aw.reset();
});

function zipNames(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, 'zip has an end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(offset), 0x02014b50);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    names.push(buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8'));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

test('wrong confirmation email is refused and leaves the account active', async () => {
  const r = await resolveAccount({ provider: 'github', subject: 'del-1', email: 'ann@example.com' });
  await assert.rejects(() => requestDeletion(r.accountId, 'not-ann@example.com'), /confirmation does not match/);
  assert.equal(await canSignIn(r.accountId), true);
  assert.equal((await accountByTenant(r.tenantId)).status, ACCOUNT_STATUS.ACTIVE);
});

test('delete revokes sign-in immediately and is recoverable during the grace period', async () => {
  const r = await resolveAccount({ provider: 'github', subject: 'del-2', email: 'bob@example.com' });
  const before = r.sessionVersion;
  const result = await requestDeletion(r.accountId, 'bob@example.com');
  assert.equal(result.status, ACCOUNT_STATUS.DELETING);
  assert.equal(await canSignIn(r.accountId), false);
  assert.equal(result.sessionVersion, before + 1);
  assert.ok(fs.existsSync(path.join(ROOT, 'tenants', r.tenantId, '.jobby-tenant')), 'files stay during grace');

  const restored = await restoreAccount(r.accountId);
  assert.equal(restored.status, ACCOUNT_STATUS.ACTIVE);
  assert.equal(await canSignIn(r.accountId), true);
});

test('restore is refused after the grace window', async () => {
  const r = await resolveAccount({ provider: 'github', subject: 'del-3', email: 'cara@example.com' });
  await requestDeletion(r.accountId, 'cara@example.com');
  await assert.rejects(
    () => restoreAccount(r.accountId, { now: Date.now() + WEEK }),
    /grace period has elapsed/,
  );
});

test('purge before the grace window is refused', async () => {
  const r = await resolveAccount({ provider: 'github', subject: 'del-4', email: 'dan@example.com' });
  await requestDeletion(r.accountId, 'dan@example.com');
  await assert.rejects(() => purgeAccount(r.accountId), /grace period has not elapsed/);
  assert.ok(fs.existsSync(path.join(ROOT, 'tenants', r.tenantId, '.jobby-tenant')));
});

test('purge removes keys by name, then only that tenant directory', async () => {
  const victim = await resolveAccount({ provider: 'github', subject: 'del-5', email: 'eve@example.com' });
  const neighbour = await resolveAccount({ provider: 'github', subject: 'del-6', email: 'fay@example.com' });
  setTenantKey(victim.tenantId, 'openrouter', 'sk-or-eve-secret');
  setTenantKey(neighbour.tenantId, 'openrouter', 'sk-or-fay-secret');
  fs.writeFileSync(path.join(ROOT, 'tenants', victim.tenantId, 'cv.md'), 'eve-cv');
  fs.writeFileSync(path.join(ROOT, 'tenants', neighbour.tenantId, 'cv.md'), 'fay-cv');

  await requestDeletion(victim.accountId, 'eve@example.com');
  const purged = await purgeAccount(victim.accountId, { now: Date.now() + WEEK });
  assert.equal(purged.purged, true);
  assert.deepEqual(purged.keysRemoved, ['openrouter']);
  assert.ok(!fs.existsSync(path.join(ROOT, 'tenants', victim.tenantId)));
  assert.ok(!fs.existsSync(keyStorePath(victim.tenantId)));
  assert.equal(getKeyForJob(neighbour.tenantId, 'openrouter'), 'sk-or-fay-secret');
  assert.equal(
    fs.readFileSync(path.join(ROOT, 'tenants', neighbour.tenantId, 'cv.md'), 'utf8'),
    'fay-cv',
  );
  assert.equal(await accountByTenant(victim.tenantId), null);
});

test('containedTenantDir refuses traversal, default, and a symlink into another tenant', async () => {
  assert.throws(() => containedTenantDir('..'), /invalid tenant id/);
  assert.throws(() => containedTenantDir('../other'), /invalid tenant id/);
  assert.throws(() => containedTenantDir('default'), /default tenant/);

  const a = await resolveAccount({ provider: 'github', subject: 'del-7', email: 'gus@example.com' });
  const b = await resolveAccount({ provider: 'github', subject: 'del-8', email: 'hal@example.com' });
  fs.writeFileSync(path.join(ROOT, 'tenants', a.tenantId, 'cv.md'), 'keep-me');
  const bRoot = path.join(ROOT, 'tenants', b.tenantId);
  fs.rmSync(bRoot, { recursive: true, force: true });
  fs.symlinkSync(path.join(ROOT, 'tenants', a.tenantId), bRoot);

  await requestDeletion(b.accountId, 'hal@example.com');
  await assert.rejects(() => purgeAccount(b.accountId, { now: Date.now() + WEEK }), /escapes tenant root/);
  assert.equal(fs.readFileSync(path.join(ROOT, 'tenants', a.tenantId, 'cv.md'), 'utf8'), 'keep-me');
  await forgetAccount(b.accountId);
  fs.unlinkSync(bRoot);
});

test('export zip includes user files and excludes the key store', async () => {
  const r = await resolveAccount({ provider: 'github', subject: 'del-9', email: 'ivy@example.com' });
  fs.writeFileSync(path.join(ROOT, 'tenants', r.tenantId, 'cv.md'), 'ivy-cv-body');
  setTenantKey(r.tenantId, 'openai', 'sk-ivy-must-not-leak');

  const archive = exportTenantArchive(r.tenantId);
  assert.match(archive.filename, /^jobby-export-t_[0-9a-f]{16}-\d{4}-\d{2}-\d{2}\.zip$/);
  const names = zipNames(archive.bytes);
  assert.ok(names.includes('cv.md'), `cv.md in ${names.join(',')}`);
  assert.ok(names.includes('data/applications.md'));
  assert.ok(!names.includes('.career-ops-web/provider-keys.json'));
  assert.ok(!archive.bytes.includes(Buffer.from('sk-ivy-must-not-leak')));
  assert.equal(getKeyForJob(r.tenantId, 'openai'), 'sk-ivy-must-not-leak', 'export is read-only');
});

test('zipBuffers round-trips a filename into the central directory', () => {
  const buf = zipBuffers([{ name: 'hello.txt', data: Buffer.from('hi') }]);
  assert.deepEqual(zipNames(buf), ['hello.txt']);
});

test('purgeExpiredAccounts only touches rows past the grace window', async () => {
  const due = await resolveAccount({ provider: 'github', subject: 'del-10', email: 'jon@example.com' });
  const waiting = await resolveAccount({ provider: 'github', subject: 'del-11', email: 'kim@example.com' });
  await requestDeletion(due.accountId, 'jon@example.com');
  await requestDeletion(waiting.accountId, 'kim@example.com');
  await restoreAccount(waiting.accountId);

  const results = await purgeExpiredAccounts({ now: Date.now() + WEEK });
  assert.ok(results.some((r) => r.tenantId === due.tenantId && r.purged));
  assert.equal((await accountByTenant(waiting.tenantId)).status, ACCOUNT_STATUS.ACTIVE);
  assert.ok(fs.existsSync(path.join(ROOT, 'tenants', waiting.tenantId, '.jobby-tenant')));
});
