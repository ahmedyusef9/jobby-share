/**
 * Account index and tenant provisioning.
 *
 * Identity and tenancy are separated:
 *
 *     identity (provider + subject)  ->  account  ->  tenant (directory)
 *
 * An account may collect several identities. The tenant id is random and stable,
 * so a person can change how they sign in without their data moving.
 *
 * Storage is Appwrite (D-008). The identity document id is the mutex: creating
 * it either succeeds or 409s, so two first-login tabs cannot fork one person
 * into two tenants. A JSON file cannot coordinate two web instances.
 *
 * Working files (cv.md, reports/, data/) stay on disk — spawned CLI agents
 * need a directory they can cd into (D-009).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { platformRoot } from './resolve-root.mjs';
import { PLAN, ROLE, defaultPlan } from './entitlements.mjs';
import {
  Q,
  appwriteConfigured,
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  updateDocument,
} from './appwrite-rest.mjs';

const COL_TENANTS = 'tenants';
const COL_IDENTITIES = 'identities';

/** Status values an account can hold. `deleting` is the grace period before purge. */
export const ACCOUNT_STATUS = Object.freeze({
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  DELETING: 'deleting',
});

const identityKey = (provider, subject) => `${provider}:${subject}`;

/**
 * Appwrite document id for an identity. Max 36 chars, a-z A-Z 0-9 . - _,
 * must not start with a special character. Colon in `github:123` is illegal.
 *
 * @param {string} provider
 * @param {string} subject
 */
export function identityDocumentId(provider, subject) {
  const hex = crypto
    .createHash('sha256')
    .update(identityKey(provider, String(subject)))
    .digest('hex')
    .slice(0, 32);
  return `id_${hex}`;
}

function fileIndexPath() {
  return path.resolve(platformRoot(), '.career-ops-web', 'accounts.json');
}

function parsePrefs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw ?? '{}'));
  } catch {
    return {};
  }
}

function emailsOf(doc, prefs) {
  const out = [];
  const fromPrefs = Array.isArray(prefs.emails) ? prefs.emails : [];
  for (const e of fromPrefs) {
    const n = String(e).trim().toLowerCase();
    if (n && !out.includes(n)) out.push(n);
  }
  const primary = String(doc.email ?? '').trim().toLowerCase();
  if (primary && !out.includes(primary)) out.unshift(primary);
  return out;
}

function shape(doc) {
  if (!doc) return null;
  const prefs = parsePrefs(doc.prefs);
  return {
    accountId: doc.$id,
    tenantId: doc.tenantId,
    status: doc.status,
    role: doc.role,
    plan: doc.plan,
    createdAt: doc.createdAt ?? null,
    lastSeenAt: doc.lastSeenAt ?? null,
    deletedAt: doc.deletedAt ?? null,
    emails: emailsOf(doc, prefs),
    cohort: doc.cohort || null,
    sessionVersion: doc.sessionVersion ?? 1,
    statusChangedAt: prefs.statusChangedAt ?? doc.statusChangedAt ?? null,
    planChangedAt: prefs.planChangedAt ?? null,
  };
}

function isUnavailable(err) {
  if (!err) return false;
  if (err.status === 401 || err.status === 403 || err.status >= 500) return true;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const code = err.code || err.cause?.code;
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
    return true;
  }
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

/* ------------------------------------------------------------------ *
 * Provisioning (filesystem — D-009)
 * ------------------------------------------------------------------ */

/**
 * Create the directory a new tenant needs to be usable.
 *
 * Sign-in succeeding is not the same as an account existing: without this a new
 * user lands in an app whose own doctor.mjs reports onboardingNeeded. Idempotent —
 * an existing marker means the tenant is already provisioned.
 *
 * @param {string} tenantId
 */
export function provisionTenant(tenantId) {
  const root = path.resolve(platformRoot(), 'tenants', tenantId);
  const marker = path.join(root, '.jobby-tenant');
  if (fs.existsSync(marker)) return { root, created: false };

  for (const dir of ['config', 'data', 'reports', 'output', 'jds', 'documents', '.career-ops-web']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }

  // A tracker with no header row is not an empty tracker — it is a broken one.
  const tracker = path.join(root, 'data', 'applications.md');
  if (!fs.existsSync(tracker)) {
    fs.writeFileSync(
      tracker,
      '# Applications Tracker\n\n' +
        '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
        '|---|------|---------|------|-------|--------|-----|--------|-------|\n',
    );
  }

  // Seed portals from the shipped example so scanning works before onboarding.
  const portals = path.join(root, 'portals.yml');
  const example = path.resolve(platformRoot(), 'templates', 'portals.example.yml');
  if (!fs.existsSync(portals) && fs.existsSync(example)) {
    fs.copyFileSync(example, portals);
  }

  fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  return { root, created: true };
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** @param {string} accountId */
export async function getAccount(accountId) {
  if (!accountId || !appwriteConfigured()) return null;
  try {
    return shape(await getDocument(COL_TENANTS, accountId));
  } catch (err) {
    if (isUnavailable(err)) return null;
    throw err;
  }
}

/** @param {string} tenantId */
export async function accountByTenant(tenantId) {
  if (!tenantId || !appwriteConfigured()) return null;
  await migrateFileIndexIfPresent();
  try {
    const rows = await listDocuments(COL_TENANTS, [Q.equal('tenantId', [tenantId]), Q.limit(1)]);
    return shape(rows[0] ?? null);
  } catch (err) {
    if (isUnavailable(err)) return null;
    throw err;
  }
}

async function accountByEmail(email) {
  const needle = String(email ?? '').trim().toLowerCase();
  if (!needle || !appwriteConfigured()) return null;
  const rows = await listDocuments(COL_TENANTS, [Q.equal('email', [needle]), Q.limit(20)]);
  const live = rows.map(shape).filter((a) => a && a.status !== ACCOUNT_STATUS.DELETING);
  return live[0] ?? null;
}

/**
 * Whether this account may hold a session right now.
 * @param {string} accountId
 */
export async function canSignIn(accountId) {
  const account = await getAccount(accountId);
  return account?.status === ACCOUNT_STATUS.ACTIVE;
}

/**
 * The operator identity, which has no account row because it is the local secret
 * login bound to the `default` tenant. Returned as an account-shaped object so
 * `can()` has one input type rather than two code paths.
 */
export function operatorAccount(tenantId) {
  return {
    accountId: 'operator',
    tenantId,
    role: ROLE.OPERATOR,
    plan: PLAN.ADVANCED,
    status: ACCOUNT_STATUS.ACTIVE,
    emails: [],
  };
}

/**
 * An account the index does not know about.
 *
 * `status: 'unknown'` is deliberately not `active`, so `can()` allows nothing but
 * exporting data and `mayUseEngine()` refuses every engine. Something is wrong
 * whenever this is returned — a missing row, Appwrite down — and the safe
 * answer to "who is this?" is "nobody with privileges", never "the operator".
 */
export function unknownAccount(tenantId) {
  return {
    accountId: 'unknown',
    tenantId,
    role: ROLE.MEMBER,
    plan: PLAN.FREE,
    status: 'unknown',
    emails: [],
  };
}

/**
 * Resolve the account behind a tenant, failing CLOSED (JOBBY-BL-049, D-014).
 *
 * The default tenant is the single legitimate exception: the operator signs in
 * with the local secret and has no row by design.
 *
 * @param {string} tenantId
 */
export async function accountForTenantStrict(tenantId) {
  // Operator on `default` has no Appwrite row. Asking Appwrite first turns a
  // hung endpoint (ConnectTimeout) into a 500 on every signed-in page.
  if (tenantId === 'default') return operatorAccount(tenantId);
  const found = await accountByTenant(tenantId);
  if (found) return found;
  return unknownAccount(tenantId);
}

/** All accounts, for the admin console. Never includes key material. */
export async function listAccounts() {
  if (!appwriteConfigured()) return [];
  await migrateFileIndexIfPresent();
  try {
    const rows = await listDocuments(COL_TENANTS, [Q.limit(500)]);
    return rows.map(shape).filter(Boolean);
  } catch (err) {
    if (isUnavailable(err)) return [];
    throw err;
  }
}

/**
 * Whether a JWT is still accepted for this tenant.
 *
 * No account row (the operator on `default`) is always valid — that path has
 * no record to bump. Everyone else must be `active` and the token's session
 * version must match, so a status change signs every device out immediately.
 *
 * Pass `account` when the caller already loaded it, so a request does not
 * round-trip twice.
 *
 * @param {string} tenantId
 * @param {unknown} tokenVersion
 * @param {Record<string, unknown> | null} [account]
 */
export async function sessionStillValid(tenantId, tokenVersion, account) {
  // The operator on `default` has no row and no session version to bump.
  if (tenantId === 'default') return true;
  const row = account !== undefined ? account : await accountByTenant(tenantId);
  if (!row || row.accountId === 'unknown' || row.accountId === 'operator') return false;
  if (row.status !== ACCOUNT_STATUS.ACTIVE) return false;
  if (tokenVersion == null || tokenVersion === '') return false;
  return Number(tokenVersion) === Number(row.sessionVersion);
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

async function touchLastSeen(account, email) {
  const now = new Date().toISOString();
  const emails = [...(account.emails ?? [])];
  if (email && !emails.includes(email)) emails.push(email);
  const patch = {
    lastSeenAt: now,
    prefs: JSON.stringify({
      emails,
      statusChangedAt: account.statusChangedAt ?? undefined,
      planChangedAt: account.planChangedAt ?? undefined,
    }),
  };
  if (email && !account.emails?.[0]) patch.email = email;
  await updateDocument(COL_TENANTS, account.accountId, patch);
}

async function createTenantRow({ accountId, tenantId, email, cohort, userId }) {
  const now = new Date().toISOString();
  const emails = email ? [email.toLowerCase()] : [];
  await createDocument(COL_TENANTS, accountId, {
    userId,
    tenantId,
    email: email ? email.toLowerCase() : '',
    role: ROLE.MEMBER,
    plan: defaultPlan(),
    status: ACCOUNT_STATUS.ACTIVE,
    cohort: cohort ?? '',
    createdAt: now,
    lastSeenAt: now,
    sessionVersion: 1,
    prefs: JSON.stringify({ emails }),
  });
}

async function ensureIdentity({ idDocId, key, provider, subject, accountId, email }) {
  try {
    await createDocument(COL_IDENTITIES, idDocId, {
      identityKey: key,
      provider,
      subject: String(subject),
      accountId,
      email: email ? email.toLowerCase() : '',
    });
    return { created: true };
  } catch (err) {
    if (err?.status !== 409) throw err;
    return { created: false };
  }
}

async function loadByIdentity(idDocId) {
  const ident = await getDocument(COL_IDENTITIES, idDocId);
  if (!ident) return null;
  const account = await getAccount(ident.accountId);
  return { ident, account };
}

/**
 * Find or create the account behind one identity, and provision its tenant.
 *
 * This is the whole of "signup": with OAuth there is nothing extra to collect, so
 * the first sign-in *is* the registration and this is the step that must run once.
 *
 * @param {{provider: string, subject: string, email?: string, cohort?: string}} identity
 * @returns {Promise<{accountId: string, tenantId: string, status: string, created: boolean, sessionVersion: number}>}
 */
export async function resolveAccount({ provider, subject, email, cohort }) {
  if (!provider || !subject) throw new Error('provider and subject are required');
  if (!appwriteConfigured()) {
    throw new Error('Appwrite is not configured — account state lives there (D-008)');
  }

  await migrateFileIndexIfPresent();

  const key = identityKey(provider, String(subject));
  const idDocId = identityDocumentId(provider, subject);
  const normalisedEmail = email ? email.toLowerCase() : undefined;

  const existing = await loadByIdentity(idDocId);
  if (existing?.account) {
    await touchLastSeen(existing.account, normalisedEmail);
    const fresh = await getAccount(existing.account.accountId);
    return {
      accountId: fresh.accountId,
      tenantId: fresh.tenantId,
      status: fresh.status,
      created: false,
      sessionVersion: fresh.sessionVersion ?? 1,
    };
  }

  // Identity row exists but the tenant row does not — a crash between the two
  // writes. Finish the job with the ids already claimed.
  if (existing?.ident && !existing.account) {
    const accountId = existing.ident.accountId;
    const tenantId = `t_${crypto.randomBytes(8).toString('hex')}`;
    try {
      await createTenantRow({
        accountId,
        tenantId,
        email: normalisedEmail,
        cohort,
        userId: provider === 'email' ? String(subject) : idDocId,
      });
    } catch (err) {
      if (err?.status !== 409) throw err;
    }
    provisionTenant((await getAccount(accountId))?.tenantId ?? tenantId);
    const account = await getAccount(accountId);
    return {
      accountId,
      tenantId: account.tenantId,
      status: account.status,
      created: true,
      sessionVersion: account.sessionVersion ?? 1,
    };
  }

  // Same human arriving through a second provider — link, do not fork.
  if (normalisedEmail) {
    const byEmail = await accountByEmail(normalisedEmail);
    if (byEmail) {
      await ensureIdentity({
        idDocId,
        key,
        provider,
        subject,
        accountId: byEmail.accountId,
        email: normalisedEmail,
      });
      await touchLastSeen(byEmail, normalisedEmail);
      const fresh = await getAccount(byEmail.accountId);
      return {
        accountId: fresh.accountId,
        tenantId: fresh.tenantId,
        status: fresh.status,
        created: false,
        sessionVersion: fresh.sessionVersion ?? 1,
      };
    }
  }

  const accountId = `acct_${crypto.randomBytes(8).toString('hex')}`;
  const tenantId = `t_${crypto.randomBytes(8).toString('hex')}`;
  const userId = provider === 'email' ? String(subject) : idDocId;

  // Identity document first: unique id is the mutex. The loser of a 409
  // re-reads and uses the winner's account.
  const ident = await ensureIdentity({
    idDocId,
    key,
    provider,
    subject,
    accountId,
    email: normalisedEmail,
  });

  if (!ident.created) {
    const won = await loadByIdentity(idDocId);
    if (won?.account) {
      provisionTenant(won.account.tenantId);
      return {
        accountId: won.account.accountId,
        tenantId: won.account.tenantId,
        status: won.account.status,
        created: false,
        sessionVersion: won.account.sessionVersion ?? 1,
      };
    }
  }

  try {
    await createTenantRow({ accountId, tenantId, email: normalisedEmail, cohort, userId });
  } catch (err) {
    if (err?.status !== 409) throw err;
  }

  provisionTenant(tenantId);
  const account = await getAccount(accountId);
  return {
    accountId,
    tenantId: account?.tenantId ?? tenantId,
    status: account?.status ?? ACCOUNT_STATUS.ACTIVE,
    created: true,
    sessionVersion: account?.sessionVersion ?? 1,
  };
}

/** @param {string} accountId @param {string} status */
export async function setAccountStatus(accountId, status) {
  if (!Object.values(ACCOUNT_STATUS).includes(status)) {
    throw new Error(`unknown account status: ${status}`);
  }
  const account = await getAccount(accountId);
  if (!account) return false;
  const now = new Date().toISOString();
  const prefs = {
    emails: account.emails ?? [],
    statusChangedAt: now,
    planChangedAt: account.planChangedAt ?? undefined,
  };
  const patch = {
    status,
    sessionVersion: (account.sessionVersion ?? 1) + 1,
    prefs: JSON.stringify(prefs),
  };
  if (status === ACCOUNT_STATUS.DELETING) patch.deletedAt = now;
  await updateDocument(COL_TENANTS, accountId, patch);
  return true;
}

/** Remove an account and every identity pointing at it. Files are purged separately. */
export async function forgetAccount(accountId) {
  const account = await getAccount(accountId);
  if (!account) return false;
  const identities = await listDocuments(COL_IDENTITIES, [
    Q.equal('accountId', [accountId]),
    Q.limit(50),
  ]);
  for (const row of identities) {
    await deleteDocument(COL_IDENTITIES, row.$id);
  }
  await deleteDocument(COL_TENANTS, accountId);
  return true;
}

/**
 * Change an account's plan. Operator action — the caller must have checked
 * `can(actor, CAP.ADMIN_MANAGE_ACCOUNTS)` first.
 *
 * Does NOT bump sessionVersion: a plan change should take effect on the next
 * request, not throw the user out mid-session. Authority is read per request
 * from the account, never from the token, which is what makes that safe.
 *
 * @param {string} accountId @param {string} plan
 */
export async function setAccountPlan(accountId, plan) {
  if (!Object.values(PLAN).includes(plan)) {
    throw new Error(`unknown plan: ${plan}`);
  }
  const account = await getAccount(accountId);
  if (!account) return false;
  const now = new Date().toISOString();
  const prefs = {
    emails: account.emails ?? [],
    statusChangedAt: account.statusChangedAt ?? undefined,
    planChangedAt: now,
  };
  await updateDocument(COL_TENANTS, accountId, {
    plan,
    prefs: JSON.stringify(prefs),
  });
  return true;
}

/**
 * Grant or revoke a role. Operator action — the caller must have checked
 * `can(actor, CAP.ADMIN_MANAGE_ACCOUNTS)` first.
 *
 * Unlike setAccountPlan this DOES bump sessionVersion (BL-054): authority is
 * read per request from the account row, but a *revoked* role must not survive
 * until the next token refresh — every existing session for that account dies
 * immediately and re-sign-in re-evaluates what they are. Granting operator is
 * as consequential as revoking it, so both directions bump.
 *
 * @param {string} accountId @param {string} role
 */
export async function setAccountRole(accountId, role) {
  const roles = Object.values(ROLE);
  if (!roles.includes(role)) {
    throw new Error(`unknown role: ${role}`);
  }
  const account = await getAccount(accountId);
  if (!account) return false;
  const now = new Date().toISOString();
  const prefs = {
    emails: account.emails ?? [],
    statusChangedAt: account.statusChangedAt ?? undefined,
    planChangedAt: account.planChangedAt ?? undefined,
    roleChangedAt: now,
  };
  await updateDocument(COL_TENANTS, accountId, {
    role,
    sessionVersion: (account.sessionVersion ?? 1) + 1,
    prefs: JSON.stringify(prefs),
  });
  return true;
}

/* ------------------------------------------------------------------ *
 * One-shot migration off accounts.json
 * ------------------------------------------------------------------ */

let migratedDone = false;

/**
 * Copy a leftover file index into Appwrite, then rename the file so nothing
 * keeps reading it. Idempotent: existing documents 409 and are skipped.
 */
export async function migrateFileIndexIfPresent() {
  if (migratedDone || !appwriteConfigured()) return { migrated: 0 };

  const file = fileIndexPath();
  if (!fs.existsSync(file)) return { migrated: 0 };

  let index;
  try {
    index = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { migrated: 0, error: 'unreadable accounts.json' };
  }
  if (index?.version !== 1 || !index.accounts) {
    migratedDone = true;
    return { migrated: 0 };
  }

  let migrated = 0;
  for (const [accountId, account] of Object.entries(index.accounts)) {
    const emails = Array.isArray(account.emails) ? account.emails : [];
    try {
      await createDocument(COL_TENANTS, accountId, {
        userId: accountId,
        tenantId: account.tenantId,
        email: emails[0] ?? '',
        role: account.role ?? ROLE.MEMBER,
        plan: account.plan ?? defaultPlan(),
        status: account.status ?? ACCOUNT_STATUS.ACTIVE,
        cohort: account.cohort ?? '',
        createdAt: account.createdAt ?? new Date().toISOString(),
        lastSeenAt: account.lastSeenAt ?? account.createdAt ?? new Date().toISOString(),
        sessionVersion: account.sessionVersion ?? 1,
        prefs: JSON.stringify({
          emails,
          statusChangedAt: account.statusChangedAt,
          planChangedAt: account.planChangedAt,
        }),
        ...(account.deletedAt ? { deletedAt: account.deletedAt } : {}),
      });
      migrated += 1;
    } catch (err) {
      if (err?.status !== 409) throw err;
    }
  }

  for (const [key, accountId] of Object.entries(index.identities ?? {})) {
    const split = key.indexOf(':');
    if (split < 1) continue;
    const provider = key.slice(0, split);
    const subject = key.slice(split + 1);
    const account = index.accounts[accountId];
    const email = account?.emails?.[0] ?? '';
    try {
      await createDocument(COL_IDENTITIES, identityDocumentId(provider, subject), {
        identityKey: key,
        provider,
        subject,
        accountId,
        email,
      });
    } catch (err) {
      if (err?.status !== 409) throw err;
    }
  }

  const dest = `${file}.migrated`;
  try {
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    fs.renameSync(file, dest);
  } catch {
    /* the copy is in Appwrite; leaving the file is worse than a rename miss */
    try {
      fs.renameSync(file, `${file}.migrated.${Date.now()}`);
    } catch {
      /* ignore */
    }
  }
  migratedDone = true;
  return { migrated };
}
