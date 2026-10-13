/**
 * Account deletion and data export (JOBBY-BL-039).
 *
 * Soft-delete first, then a contained hard purge. A recursive delete driven by
 * a tenant id is exactly where a path bug destroys the wrong person's data, so
 * every filesystem step resolves through containedTenantDir() and refuses
 * anything that is not strictly inside tenants/{id}.
 *
 * Keys are removed by name *before* the directory goes, so erasure still
 * reaches them the day the store moves off the volume.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ACCOUNT_STATUS,
  accountByTenant,
  forgetAccount,
  getAccount,
  listAccounts,
  setAccountStatus,
} from './accounts.mjs';
import { deleteAllTenantKeys } from './key-store.mjs';
import { platformRoot } from './resolve-root.mjs';

const TENANT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const DEFAULT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const SKIP_EXPORT = new Set([
  '.career-ops-web/provider-keys.json',
  '.career-ops-web/secrets.env',
  '.career-ops-web/secrets.env.migrated',
]);

export const ACCOUNT_GRACE_MS = DEFAULT_GRACE_MS;

/** @param {NodeJS.ProcessEnv} [env] */
export function graceMs(env = process.env) {
  const raw = env.JOBBY_ACCOUNT_GRACE_MS?.trim();
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return DEFAULT_GRACE_MS;
}

/* ------------------------------------------------------------------ *
 * Path containment
 * ------------------------------------------------------------------ */

/**
 * Resolve tenants/{id} and refuse anything that is not strictly that directory.
 *
 * The tenant id is never taken from a request body by callers — they pass the
 * id from the verified session. This function still treats the string as
 * hostile: `..`, a symlink out of tenants/, and the operator's `default`
 * directory are all refused (unless allowDefault, which export uses).
 *
 * @param {string} tenantId
 * @param {{ allowDefault?: boolean }} [opts]
 */
export function containedTenantDir(tenantId, opts = {}) {
  const id = String(tenantId ?? '').trim();
  if (!TENANT_ID_RE.test(id) || id.includes('..')) {
    throw Object.assign(new Error(`invalid tenant id: ${tenantId}`), { status: 400 });
  }
  if (id === 'default' && !opts.allowDefault) {
    throw Object.assign(new Error('refusing to modify the default tenant'), { status: 403 });
  }

  const tenantsRoot = path.resolve(platformRoot(), 'tenants');
  const root = path.resolve(tenantsRoot, id);
  if (path.basename(root) !== id) {
    throw Object.assign(new Error('path escapes tenant root'), { status: 400 });
  }

  // Compare realpaths: on macOS os.tmpdir() is /var/folders, which realpath
  // resolves to /private/var/folders — that is not an escape.
  const tenantsReal = fs.existsSync(tenantsRoot) ? fs.realpathSync(tenantsRoot) : tenantsRoot;
  const prefix = tenantsReal.endsWith(path.sep) ? tenantsReal : tenantsReal + path.sep;

  if (fs.existsSync(root)) {
    const real = fs.realpathSync(root);
    if (real === tenantsReal || !real.startsWith(prefix) || path.basename(real) !== id) {
      throw Object.assign(new Error('path escapes tenant root'), { status: 400 });
    }
  } else {
    const relative = path.relative(tenantsRoot, root);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw Object.assign(new Error('path escapes tenant root'), { status: 400 });
    }
  }
  return root;
}

/* ------------------------------------------------------------------ *
 * Confirmation
 * ------------------------------------------------------------------ */

function emailDigest(value) {
  return crypto.createHash('sha256').update(String(value ?? '').trim().toLowerCase()).digest();
}

/** Timing-safe match against the account's stored emails. */
export function emailConfirmed(emails, candidate) {
  const got = emailDigest(candidate);
  let ok = false;
  const list = Array.isArray(emails) ? emails : [];
  for (const e of list) {
    if (crypto.timingSafeEqual(got, emailDigest(e))) ok = true;
  }
  if (list.length === 0) crypto.timingSafeEqual(got, emailDigest(''));
  return ok;
}

/* ------------------------------------------------------------------ *
 * Audit (stub until BL-037)
 * ------------------------------------------------------------------ */

function appendAudit(event) {
  const file = path.resolve(platformRoot(), '.career-ops-web', 'audit.jsonl');
  const row = {
    ts: new Date().toISOString(),
    action: event.action,
    accountId: event.accountId,
    tenantId: event.tenantId,
    actor: event.actor ?? 'self',
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

/* ------------------------------------------------------------------ *
 * Soft-delete / restore
 * ------------------------------------------------------------------ */

/**
 * Mark the account deleting, stamp deletedAt, bump the session version.
 * Sign-in is refused from this moment; files stay on disk for the grace period.
 *
 * @param {string} accountId
 * @param {string} confirmEmail
 */
export async function requestDeletion(accountId, confirmEmail) {
  const account = await getAccount(accountId);
  if (!account) throw Object.assign(new Error('account not found'), { status: 404 });
  if (account.tenantId === 'default') {
    throw Object.assign(new Error('refusing to modify the default tenant'), { status: 403 });
  }
  if (!emailConfirmed(account.emails, confirmEmail)) {
    throw Object.assign(new Error('confirmation does not match'), { status: 403 });
  }

  if (account.status !== ACCOUNT_STATUS.DELETING) {
    await setAccountStatus(accountId, ACCOUNT_STATUS.DELETING);
  }
  const updated = await getAccount(accountId);
  appendAudit({ action: 'account.delete.requested', accountId, tenantId: updated.tenantId });
  const deletedAt = Date.parse(updated.deletedAt);
  return {
    accountId,
    tenantId: updated.tenantId,
    status: updated.status,
    deletedAt: updated.deletedAt,
    purgeAfter: new Date(deletedAt + graceMs()).toISOString(),
    sessionVersion: updated.sessionVersion,
  };
}

/**
 * Support restore during the grace period. After the window, the data is gone
 * or about to be — refuse rather than resurrect an empty account over a purge.
 *
 * @param {string} accountId
 * @param {{ now?: number }} [opts]
 */
export async function restoreAccount(accountId, opts = {}) {
  const account = await getAccount(accountId);
  if (!account) throw Object.assign(new Error('account not found'), { status: 404 });
  if (account.status !== ACCOUNT_STATUS.DELETING) {
    throw Object.assign(new Error('account is not pending deletion'), { status: 409 });
  }
  const now = opts.now ?? Date.now();
  if (now - Date.parse(account.deletedAt) >= graceMs()) {
    throw Object.assign(new Error('grace period has elapsed'), { status: 409 });
  }
  await setAccountStatus(accountId, ACCOUNT_STATUS.ACTIVE);
  appendAudit({ action: 'account.restored', accountId, tenantId: account.tenantId, actor: 'support' });
  return getAccount(accountId);
}

/* ------------------------------------------------------------------ *
 * Hard purge
 * ------------------------------------------------------------------ */

/**
 * Remove keys by name, then the tenant directory, then the account row.
 * Callers must have already revoked sessions (requestDeletion does).
 *
 * @param {string} accountId
 * @param {{ now?: number }} [opts]
 */
export async function purgeAccount(accountId, opts = {}) {
  const account = await getAccount(accountId);
  if (!account) return { purged: false, reason: 'missing' };
  if (account.tenantId === 'default') {
    throw Object.assign(new Error('refusing to modify the default tenant'), { status: 403 });
  }
  if (account.status !== ACCOUNT_STATUS.DELETING) {
    throw Object.assign(new Error('account is not pending deletion'), { status: 409 });
  }
  const now = opts.now ?? Date.now();
  if (now - Date.parse(account.deletedAt) < graceMs()) {
    throw Object.assign(new Error('grace period has not elapsed'), { status: 409 });
  }

  const tenantId = account.tenantId;
  const root = containedTenantDir(tenantId);
  const keysRemoved = deleteAllTenantKeys(tenantId);
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  await forgetAccount(accountId);
  appendAudit({ action: 'account.purged', accountId, tenantId });
  return { purged: true, accountId, tenantId, keysRemoved };
}

/** @param {{ now?: number }} [opts] */
export async function purgeExpiredAccounts(opts = {}) {
  const now = opts.now ?? Date.now();
  const due = (await listAccounts()).filter(
    (a) => a.status === ACCOUNT_STATUS.DELETING && now - Date.parse(a.deletedAt) >= graceMs(),
  );
  const results = [];
  for (const a of due) {
    try {
      results.push(await purgeAccount(a.accountId, { now }));
    } catch (err) {
      results.push({
        purged: false,
        accountId: a.accountId,
        tenantId: a.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/* ------------------------------------------------------------------ *
 * Export (zip, no key material)
 * ------------------------------------------------------------------ */

function skipExportRel(rel) {
  const n = rel.split(path.sep).join('/');
  if (SKIP_EXPORT.has(n)) return true;
  if (n.startsWith('.career-ops-web/provider-keys.json.')) return true;
  if (n === 'master.key' || n.endsWith('/master.key')) return true;
  return false;
}

function collectExportFiles(root) {
  /** @type {{ name: string, data: Buffer }[]} */
  const files = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const name = rel ? `${rel}/${ent.name}` : ent.name;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, name);
        continue;
      }
      if (!ent.isFile()) continue;
      if (skipExportRel(name)) continue;
      files.push({ name, data: fs.readFileSync(full) });
    }
  };
  walk(root, '');
  return files;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

/** Minimal ZIP (DEFLATE) so we do not add a dependency for a one-shot export. */
export function zipBuffers(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const crc = zlib.crc32(data);
    const deflated = zlib.deflateRawSync(data);
    const method = deflated.length < data.length ? 8 : 0;
    const payload = method === 8 ? deflated : data;
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0x800),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(payload.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      payload,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0x800),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(payload.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, centralDir, eocd]);
}

/**
 * Zip of the tenant directory, minus the encrypted key store.
 * @param {string} tenantId
 */
export function exportTenantArchive(tenantId) {
  const root = containedTenantDir(tenantId, { allowDefault: true });
  if (!fs.existsSync(root)) {
    throw Object.assign(new Error('tenant directory missing'), { status: 404 });
  }
  const files = collectExportFiles(root);
  const day = new Date().toISOString().slice(0, 10);
  return {
    filename: `jobby-export-${tenantId}-${day}.zip`,
    bytes: zipBuffers(files),
  };
}

/** Look up the account for a session tenant id. */
export async function accountForTenant(tenantId) {
  return accountByTenant(tenantId);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const cmd = process.argv[2];
  if (cmd === 'purge-expired') {
    const result = await purgeExpiredAccounts();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stderr.write(`usage: node ${path.basename(fileURLToPath(import.meta.url))} purge-expired\n`);
    process.exit(2);
  }
}
