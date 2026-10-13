import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { installAppwriteMemory, VALID_DOCUMENT_ID } from './appwrite-memory.mjs';

const aw = installAppwriteMemory();
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'jobby-accounts-'));
process.env.CAREER_OPS_ROOT = ROOT;

const {
  ACCOUNT_STATUS,
  accountByTenant,
  accountForTenantStrict,
  canSignIn,
  forgetAccount,
  identityDocumentId,
  listAccounts,
  migrateFileIndexIfPresent,
  provisionTenant,
  resolveAccount,
  sessionStillValid,
  setAccountStatus,
} = await import('../scripts/accounts.mjs');
const { nextConfigVersion } = await import('../scripts/config-store.mjs');

beforeEach(() => {
  aw.reset();
});

test('first sign-in creates an account and provisions a usable tenant', async () => {
  const r = await resolveAccount({ provider: 'github', subject: '111', email: 'ann@example.com' });
  assert.equal(r.created, true);
  assert.match(r.tenantId, /^t_[0-9a-f]{16}$/);

  const root = path.join(ROOT, 'tenants', r.tenantId);
  assert.ok(fs.existsSync(path.join(root, '.jobby-tenant')), 'tenant marker written');
  const tracker = fs.readFileSync(path.join(root, 'data', 'applications.md'), 'utf8');
  assert.match(tracker, /\| # \| Date \| Company \|/, 'tracker has its header row');
});

test('signing in again returns the same tenant, not a new one', async () => {
  const first = await resolveAccount({ provider: 'github', subject: '222', email: 'bob@example.com' });
  const second = await resolveAccount({ provider: 'github', subject: '222', email: 'bob@example.com' });
  assert.equal(second.created, false);
  assert.equal(second.tenantId, first.tenantId);
});

test('the same person on a second provider keeps one tenant', async () => {
  const viaGitHub = await resolveAccount({ provider: 'github', subject: '333', email: 'cara@example.com' });
  const viaGoogle = await resolveAccount({ provider: 'google', subject: '444', email: 'cara@example.com' });
  assert.equal(
    viaGoogle.tenantId,
    viaGitHub.tenantId,
    'two logins must not fork one person into two CVs and two trackers',
  );
  assert.equal(viaGoogle.accountId, viaGitHub.accountId);
});

test('different people never share a tenant', async () => {
  const dan = await resolveAccount({ provider: 'github', subject: '555', email: 'dan@example.com' });
  const eve = await resolveAccount({ provider: 'github', subject: '666', email: 'eve@example.com' });
  assert.notEqual(dan.tenantId, eve.tenantId);
  assert.notEqual(dan.accountId, eve.accountId);
});

test('the tenant id is not derivable from the login', async () => {
  const r = await resolveAccount({ provider: 'github', subject: '777', email: 'fay@example.com' });
  assert.ok(
    !r.tenantId.includes('777'),
    'a random id means a person can change how they sign in without their data moving',
  );
});

test('a suspended account cannot sign in', async () => {
  const r = await resolveAccount({ provider: 'github', subject: '888', email: 'gus@example.com' });
  assert.equal(await canSignIn(r.accountId), true);
  await setAccountStatus(r.accountId, ACCOUNT_STATUS.SUSPENDED);
  assert.equal(await canSignIn(r.accountId), false);
});

test('a status change bumps the session version so live sessions die', async () => {
  const r = await resolveAccount({ provider: 'github', subject: '999', email: 'hal@example.com' });
  const before = (await accountByTenant(r.tenantId)).sessionVersion;
  await setAccountStatus(r.accountId, ACCOUNT_STATUS.DELETING);
  assert.equal((await accountByTenant(r.tenantId)).sessionVersion, before + 1);
});

test('an account marked deleting is not re-linked by a later sign-in on the same email', async () => {
  const r = await resolveAccount({ provider: 'github', subject: 'aaa', email: 'ivy@example.com' });
  await setAccountStatus(r.accountId, ACCOUNT_STATUS.DELETING);
  const again = await resolveAccount({ provider: 'google', subject: 'bbb', email: 'ivy@example.com' });
  assert.notEqual(again.tenantId, r.tenantId, 'a deleted account must not be resurrected by email match');
});

test('forgetting an account removes it and its identities', async () => {
  const r = await resolveAccount({ provider: 'github', subject: 'ccc', email: 'jon@example.com' });
  assert.equal(await forgetAccount(r.accountId), true);
  assert.equal(await accountByTenant(r.tenantId), null);
  const fresh = await resolveAccount({ provider: 'github', subject: 'ccc', email: 'jon@example.com' });
  assert.equal(fresh.created, true, 'the identity no longer points anywhere');
});

test('provisioning twice is a no-op, not a reset', async () => {
  const r = await resolveAccount({ provider: 'github', subject: 'ddd', email: 'kim@example.com' });
  const tracker = path.join(ROOT, 'tenants', r.tenantId, 'data', 'applications.md');
  fs.appendFileSync(tracker, '| 1 | 2026-08-16 | Acme | Dev | 4.0/5 | Applied | ✅ | — | note |\n');
  const second = provisionTenant(r.tenantId);
  assert.equal(second.created, false);
  assert.match(fs.readFileSync(tracker, 'utf8'), /Acme/, 'existing user data survives');
});

test('listAccounts exposes no key material', async () => {
  await resolveAccount({ provider: 'github', subject: 'list-1', email: 'list@example.com' });
  const serialized = JSON.stringify(await listAccounts());
  assert.ok(!/api[_-]?key/i.test(serialized));
  assert.ok(!/secret/i.test(serialized));
});

test('a bumped session version invalidates the previous token', async () => {
  const r = await resolveAccount({ provider: 'github', subject: 'eee', email: 'lea@example.com' });
  assert.equal(await sessionStillValid(r.tenantId, r.sessionVersion), true);
  await setAccountStatus(r.accountId, ACCOUNT_STATUS.DELETING);
  assert.equal(await sessionStillValid(r.tenantId, r.sessionVersion), false);
  assert.equal(
    await sessionStillValid(r.tenantId, r.sessionVersion + 1),
    false,
    'deleting is refused even with the new version',
  );
});

test('the operator tenant with no account record stays valid', async () => {
  assert.equal(await sessionStillValid('default', undefined), true);
});

test('operator default tenant does not wait on Appwrite', async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  try {
    const t0 = Date.now();
    const a = await accountForTenantStrict('default');
    assert.ok(Date.now() - t0 < 200, 'must not sit on a hung Appwrite fetch');
    assert.equal(a.accountId, 'operator');
    assert.equal(a.role, 'operator');
    assert.equal(a.tenantId, 'default');
  } finally {
    globalThis.fetch = prev;
  }
});

test('two first-login tabs for the same identity produce one account', async () => {
  const [a, b] = await Promise.all([
    resolveAccount({ provider: 'github', subject: 'race', email: 'race@example.com' }),
    resolveAccount({ provider: 'github', subject: 'race', email: 'race@example.com' }),
  ]);
  assert.equal(a.accountId, b.accountId);
  assert.equal(a.tenantId, b.tenantId);
  assert.equal(aw.collection('tenants').size, 1);
  assert.equal(aw.collection('identities').size, 1);
});

test('identity document ids are ones Appwrite will actually accept', () => {
  assert.match(identityDocumentId('github', '12345'), VALID_DOCUMENT_ID);
  assert.match(identityDocumentId('email', 'user-with:colon'), VALID_DOCUMENT_ID);
  assert.doesNotMatch(identityDocumentId('github', '12345'), /:/);
});

test('a leftover accounts.json is copied into Appwrite and retired', async () => {
  const dir = path.join(ROOT, '.career-ops-web');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'accounts.json');
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      version: 1,
      identities: { 'github:legacy': 'acct_legacy01' },
      accounts: {
        acct_legacy01: {
          tenantId: 't_legacy000000001',
          status: 'active',
          role: 'member',
          plan: 'alpha',
          emails: ['legacy@example.com'],
          createdAt: '2026-08-01T00:00:00.000Z',
          lastSeenAt: '2026-08-01T00:00:00.000Z',
          sessionVersion: 3,
        },
      },
    })}\n`,
  );

  const result = await migrateFileIndexIfPresent();
  assert.equal(result.migrated, 1);
  assert.ok(!fs.existsSync(file), 'the file index must not remain the source of truth');
  const account = await accountByTenant('t_legacy000000001');
  assert.equal(account.accountId, 'acct_legacy01');
  assert.equal(account.sessionVersion, 3);
  assert.equal(account.emails[0], 'legacy@example.com');
});

test('nextConfigVersion stays inside Appwrite document-id rules', () => {
  assert.equal(nextConfigVersion('1.0.0'), '1.0.1');
  assert.match(nextConfigVersion('1.0.0'), VALID_DOCUMENT_ID);
  assert.match(nextConfigVersion(null), VALID_DOCUMENT_ID);
});
