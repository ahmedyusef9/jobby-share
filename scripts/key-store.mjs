/**
 * Per-tenant provider API key store (JOBBY-BL-021).
 *
 * Why this module exists
 * ----------------------
 * Provider keys used to be written into `process.env`, which is ONE object shared
 * by every request in the Node server. The first tenant to save a key won the
 * global slot and every later tenant's job silently spent that key. A key store
 * has to be addressed by tenant, so this module's whole surface takes a tenantId
 * and nothing here ever reads or writes `process.env` for a secret value.
 *
 * Storage
 * -------
 * {platformRoot}/tenants/{id}/.career-ops-web/provider-keys.json, mode 0600.
 *
 * Envelope encryption: a random 32-byte DEK per tenant, wrapped by the master KEK;
 * each key encrypted under the DEK with AES-256-GCM. The AAD binds every ciphertext
 * to its tenant and env-var name, so a blob copied into another tenant's directory
 * fails to decrypt rather than decrypting into the wrong account.
 *
 * Backend seam
 * ------------
 * `getKeyForJob(tenantId, provider)` is the interface a managed backend plugs into.
 * Swapping the local cipher for OpenBao/Vault Transit or a cloud KMS means
 * implementing `wrapDek`/`unwrapDek` and selecting it with JOBBY_KEY_BACKEND —
 * no caller changes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CLI_PROVIDER_KEYS } from './child-env.mjs';
import { platformRoot } from './resolve-root.mjs';

const TENANT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const FORMAT_VERSION = 1;
const ALGO = 'aes-256-gcm';

/** Provider name (what the UI posts) -> env var the CLIs read. */
export const PROVIDER_ENV = Object.freeze({
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
});

/**
 * Env vars that carry a *secret*. In multi-tenant mode these may only come from
 * this store — never from the server's own environment, or one operator key
 * would be handed to every tenant, which is the bug this module exists to end.
 */
export const SECRET_ENV_KEYS = Object.freeze([
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_API_KEY',
  'DASHSCOPE_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'OMNIROUTE_API_KEY',
  'JOBBY_OMNIROUTE_API_KEY',
]);

const SECRET_SET = new Set(SECRET_ENV_KEYS);

/** @param {string} envKey */
export function isSecretEnvKey(envKey) {
  return SECRET_SET.has(envKey);
}

/**
 * True when this instance serves more than one account.
 *
 * Same flag auth.ts reads, so tenancy cannot be on for identity and off for keys.
 * Single-tenant is the local single-user install (the upstream career-ops case),
 * where an operator's own key in the environment is legitimate.
 */
export function isMultiTenant(env = process.env) {
  const v = env.AUTH_SINGLE_TENANT ?? '1';
  return v === '0' || String(v).toLowerCase() === 'false';
}

/** @param {string} tenantId */
function assertTenant(tenantId) {
  const id = String(tenantId ?? '').trim();
  if (!TENANT_ID_RE.test(id) || id.includes('..')) {
    throw new Error(`invalid tenant id: ${tenantId}`);
  }
  return id;
}

/** @param {string} tenantId */
export function keyStorePath(tenantId) {
  const id = assertTenant(tenantId);
  return path.resolve(platformRoot(), 'tenants', id, '.career-ops-web', 'provider-keys.json');
}

/* ------------------------------------------------------------------ *
 * Master key (KEK)
 * ------------------------------------------------------------------ */

/**
 * 32-byte master key.
 *
 * Production must supply JOBBY_MASTER_KEY and we fail closed without it: silently
 * inventing a key would write a file nobody can decrypt after the next restart,
 * and storing the key beside the data it protects is not encryption at rest.
 * Outside production a local file is generated so a fresh checkout just runs.
 */
export function masterKey(env = process.env) {
  const raw = env.JOBBY_MASTER_KEY?.trim();
  if (raw) {
    const buf = decodeKeyMaterial(raw);
    if (buf.length !== 32) {
      throw new Error('JOBBY_MASTER_KEY must decode to 32 bytes (base64 or hex)');
    }
    return buf;
  }
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'JOBBY_MASTER_KEY is required in production — generate with: openssl rand -base64 32',
    );
  }
  return devMasterKey();
}

/** @param {string} raw */
function decodeKeyMaterial(raw) {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return Buffer.from(raw, 'base64');
}

function devMasterKey() {
  const file = path.resolve(platformRoot(), '.career-ops-web', 'master.key');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    const buf = decodeKeyMaterial(existing);
    if (buf.length === 32) return buf;
  } catch {
    /* fall through and create */
  }
  const buf = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${buf.toString('base64')}\n`);
  return buf;
}

/* ------------------------------------------------------------------ *
 * Cipher backend — the seam a managed KMS plugs into
 * ------------------------------------------------------------------ */

const localCipher = {
  name: 'local',
  /** @param {Buffer} dek @param {string} aad */
  wrapDek(dek, aad) {
    return sealBuffer(masterKey(), dek, aad);
  },
  /** @param {{ct:string,iv:string,tag:string}} wrapped @param {string} aad */
  unwrapDek(wrapped, aad) {
    return openBuffer(masterKey(), wrapped, aad);
  },
};

export function activeCipher(env = process.env) {
  const backend = (env.JOBBY_KEY_BACKEND ?? 'local').trim().toLowerCase();
  if (backend === 'local') return localCipher;
  throw new Error(
    `unknown JOBBY_KEY_BACKEND: ${backend} — 'local' is implemented; transit/kms plug in here`,
  );
}

/* ------------------------------------------------------------------ *
 * AES-256-GCM primitives
 * ------------------------------------------------------------------ */

/** @param {Buffer} key @param {Buffer} plain @param {string} aad */
function sealBuffer(key, plain, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALGO, key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { ct: ct.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

/** @param {Buffer} key @param {{ct:string,iv:string,tag:string}} sealed @param {string} aad */
function openBuffer(key, sealed, aad) {
  const d = crypto.createDecipheriv(ALGO, key, Buffer.from(sealed.iv, 'base64'));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(sealed.ct, 'base64')), d.final()]);
}

const dekAad = (tenantId) => `jobby|v${FORMAT_VERSION}|${tenantId}|dek`;
const entryAad = (tenantId, envKey) => `jobby|v${FORMAT_VERSION}|${tenantId}|${envKey}`;

/* ------------------------------------------------------------------ *
 * File I/O
 * ------------------------------------------------------------------ */

/** @param {string} file @param {string} body */
function writeFileAtomic(file, body) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** @param {string} tenantId */
function readStore(tenantId) {
  const file = keyStorePath(tenantId);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || parsed.version !== FORMAT_VERSION || !parsed.dek) return null;
  if (parsed.tenantId && parsed.tenantId !== tenantId) return null;
  return parsed;
}

/** @param {string} tenantId @param {object} store */
function writeStore(tenantId, store) {
  const file = keyStorePath(tenantId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(store, null, 2)}\n`);
}

/** @param {string} tenantId */
function loadDek(tenantId, store) {
  return activeCipher().unwrapDek(store.dek, dekAad(tenantId));
}

/** @param {string} tenantId */
function newStore(tenantId) {
  const dek = crypto.randomBytes(32);
  return {
    store: {
      version: FORMAT_VERSION,
      tenantId,
      backend: activeCipher().name,
      dek: activeCipher().wrapDek(dek, dekAad(tenantId)),
      entries: {},
    },
    dek,
  };
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Save one provider key for one tenant.
 * @param {string} tenantId
 * @param {string} provider  openrouter | openai | anthropic | gemini
 * @param {string} value     the raw API key
 */
export function setTenantKey(tenantId, provider, value) {
  const id = assertTenant(tenantId);
  const envKey = PROVIDER_ENV[provider];
  if (!envKey) throw new Error(`unknown provider: ${provider}`);
  const secret = String(value ?? '').trim();
  if (!secret) throw new Error('empty key');

  const existing = readStore(id);
  let store;
  let dek;
  if (existing) {
    store = existing;
    dek = loadDek(id, existing);
  } else {
    ({ store, dek } = newStore(id));
  }

  const sealed = sealBuffer(dek, Buffer.from(secret, 'utf8'), entryAad(id, envKey));
  store.entries[envKey] = {
    ...sealed,
    provider,
    last4: secret.slice(-4),
    createdAt: store.entries[envKey]?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastUsedAt: store.entries[envKey]?.lastUsedAt ?? null,
    keyVersion: (store.entries[envKey]?.keyVersion ?? 0) + 1,
  };
  writeStore(id, store);
  return { provider, last4: store.entries[envKey].last4, keyVersion: store.entries[envKey].keyVersion };
}

/** @param {string} tenantId @param {string} provider */
export function deleteTenantKey(tenantId, provider) {
  const id = assertTenant(tenantId);
  const envKey = PROVIDER_ENV[provider];
  if (!envKey) throw new Error(`unknown provider: ${provider}`);
  const store = readStore(id);
  if (!store?.entries?.[envKey]) return false;
  delete store.entries[envKey];
  writeStore(id, store);
  return true;
}

/**
 * Remove every stored key for a tenant *by name*, then unlink the store file
 * and any leftover plaintext secrets.env.
 *
 * Account deletion must call this before removing the directory. Coupling
 * erasure to "the file happened to sit in the folder" breaks the day the
 * store moves to Vault or a KMS — named deletion still reaches the keys.
 *
 * @param {string} tenantId
 * @returns {string[]} providers whose keys were present and removed
 */
export function deleteAllTenantKeys(tenantId) {
  const id = assertTenant(tenantId);
  const removed = [];
  for (const provider of Object.keys(PROVIDER_ENV)) {
    if (deleteTenantKey(id, provider)) removed.push(provider);
  }
  try {
    fs.unlinkSync(keyStorePath(id));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const extra of ['secrets.env', 'secrets.env.migrated']) {
    const leftover = path.resolve(platformRoot(), 'tenants', id, '.career-ops-web', extra);
    try {
      fs.unlinkSync(leftover);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return removed;
}

/**
 * Metadata for the settings screen — never the key itself.
 * @param {string} tenantId
 */
export function listTenantKeys(tenantId) {
  const id = assertTenant(tenantId);
  const store = readStore(id);
  if (!store) return [];
  return Object.entries(store.entries).map(([envKey, e]) => ({
    provider: e.provider ?? envKey,
    envKey,
    last4: e.last4 ?? null,
    createdAt: e.createdAt ?? null,
    updatedAt: e.updatedAt ?? null,
    lastUsedAt: e.lastUsedAt ?? null,
    keyVersion: e.keyVersion ?? 1,
  }));
}

/**
 * The interface a managed backend implements. Returns the decrypted key for one
 * tenant and one provider, or null. Callers pass the result straight into a
 * child process env and never store it anywhere else.
 *
 * @param {string} tenantId
 * @param {string} provider
 * @returns {string | null}
 */
export function getKeyForJob(tenantId, provider) {
  const id = assertTenant(tenantId);
  const envKey = PROVIDER_ENV[provider];
  if (!envKey) return null;
  const store = readStore(id);
  const entry = store?.entries?.[envKey];
  if (!entry) return null;
  try {
    const dek = loadDek(id, store);
    return openBuffer(dek, entry, entryAad(id, envKey)).toString('utf8');
  } catch {
    // Wrong master key, tampered blob, or a file copied from another tenant.
    return null;
  }
}

/**
 * One-time import of the pre-BL-021 plaintext `.career-ops-web/secrets.env`.
 *
 * Existing installs keep their keys in that file. Deleting the old loader without
 * this would silently un-configure them. Runs only when there is no encrypted
 * store yet, so it is not a write on the hot path once a tenant is migrated.
 *
 * @param {string} tenantId
 */
export function migrateLegacyEnvFile(tenantId) {
  const id = assertTenant(tenantId);
  if (fs.existsSync(keyStorePath(id))) return false;
  const legacy = path.resolve(platformRoot(), 'tenants', id, '.career-ops-web', 'secrets.env');
  let body;
  try {
    body = fs.readFileSync(legacy, 'utf8');
  } catch {
    return false;
  }

  const byEnvKey = Object.fromEntries(Object.entries(PROVIDER_ENV).map(([p, k]) => [k, p]));
  let imported = 0;
  for (const line of body.split('\n')) {
    const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const provider = byEnvKey[m[1]];
    if (!provider) continue;
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!value) continue;
    setTenantKey(id, provider, value);
    imported += 1;
  }
  if (imported > 0) {
    // Encrypted copy is now authoritative; leaving the plaintext would defeat it.
    try {
      fs.renameSync(legacy, `${legacy}.migrated`);
    } catch {
      /* keep going — the encrypted store already wins */
    }
  }
  return imported > 0;
}

/**
 * Every secret env var this tenant has, decrypted, as an env fragment.
 *
 * In single-tenant mode the operator's own environment is folded in, because a
 * one-user local install legitimately configures keys that way. In multi-tenant
 * mode the environment is ignored entirely — that is the fix.
 *
 * @param {string} tenantId
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, string>}
 */
export function tenantSecretEnv(tenantId, env = process.env) {
  /** @type {Record<string, string>} */
  const out = {};

  try {
    migrateLegacyEnvFile(tenantId);
  } catch {
    /* a bad legacy file must not stop a job that has a valid store */
  }

  if (!isMultiTenant(env)) {
    for (const k of SECRET_ENV_KEYS) {
      const v = env[k];
      if (v !== undefined && String(v).trim() !== '') out[k] = String(v);
    }
  }

  for (const provider of Object.keys(PROVIDER_ENV)) {
    const value = getKeyForJob(tenantId, provider);
    if (value) out[PROVIDER_ENV[provider]] = value;
  }
  return out;
}

/**
 * The full env fragment one CLI should receive for one tenant.
 *
 * Single source of truth for web and worker so the two cannot drift:
 *   - non-secret CLI config (models, config dirs, base URLs) from the server env
 *   - secrets only from this tenant's store, and only the ones this CLI reads
 *
 * @param {string} cliId
 * @param {string} tenantId
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, string>}
 */
export function tenantProviderEnv(cliId, tenantId, env = process.env) {
  const readable = new Set(CLI_PROVIDER_KEYS[cliId] || []);
  /** @type {Record<string, string>} */
  const out = {};

  for (const key of readable) {
    if (isSecretEnvKey(key)) continue;
    const v = env[key];
    if (v !== undefined && String(v).trim() !== '') out[key] = String(v);
  }

  for (const [key, value] of Object.entries(tenantSecretEnv(tenantId, env))) {
    if (readable.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Record that a key was used, for the admin console's "last used" column.
 * Best-effort: a usage stamp must never fail a job.
 * @param {string} tenantId @param {string} provider
 */
export function markKeyUsed(tenantId, provider) {
  try {
    const id = assertTenant(tenantId);
    const envKey = PROVIDER_ENV[provider];
    const store = readStore(id);
    if (!store?.entries?.[envKey]) return;
    store.entries[envKey].lastUsedAt = new Date().toISOString();
    writeStore(id, store);
  } catch {
    /* never block a run on telemetry */
  }
}
