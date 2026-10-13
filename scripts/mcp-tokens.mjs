/**
 * Per-tenant MCP API keys (D-030).
 *
 * The secret is shown once. Appwrite stores only the sha256, so a leaked
 * database dump does not become a working URL. Document id is derived from
 * the hash (`mt.` + 32 hex) so lookup is a get, not a scan.
 *
 * Up to MAX_KEYS live named keys per tenant (e.g. ChatGPT + Cursor). Optional
 * `rotate: true` retires every key then mints one. Client snippets use `name`
 * as the mcpServers entry so the user can call the connector whatever they want.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  Q,
  appwriteConfigured,
  createDocument,
  deleteDocument,
  getDocument,
  isAppwriteUnavailable,
  listDocuments,
  updateDocument,
} from './appwrite-rest.mjs';
import { tenantRootFor } from './resolve-root.mjs';

/** Operator `default` has no Appwrite row — same skip as accounts.mjs. */
function usesLocalStore(tenantId) {
  return tenantId === 'default';
}

function localStorePath(tenantId) {
  return path.join(tenantRootFor(tenantId), 'data', 'mcp-tokens.json');
}

function loadLocal(tenantId) {
  try {
    const doc = JSON.parse(fs.readFileSync(localStorePath(tenantId), 'utf8'));
    if (!doc || !Array.isArray(doc.keys)) return [];
    return doc.keys.filter((k) => k && typeof k.id === 'string');
  } catch {
    return [];
  }
}

function saveLocal(tenantId, keys) {
  const file = localStorePath(tenantId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, keys }, null, 2) + '\n');
}

function shapeRow(r) {
  return {
    id: r.id || r.$id,
    name: r.name ? String(r.name) : 'jobby',
    prefix: r.prefix ?? null,
    scope: normalizeKeyScope(r.scope),
    ...expiryState(r.expiresAt ?? null),
    createdAt: r.createdAt ?? null,
    lastUsedAt: r.lastUsedAt ?? null,
    status: keyStatus(r.expiresAt ?? null),
  };
}

export const COL_MCP = 'mcp_tokens';
export const TOKEN_PREFIX = 'jb_';
/** Soft cap so one account cannot mint unbounded secrets. */
export const MAX_MCP_KEYS = 5;
export const MCP_KEY_SCOPES = Object.freeze(['read', 'read-write']);
export const MCP_KEY_EXPIRY_OPTIONS = Object.freeze(['never', '7d', '30d']);

/** @param {unknown} raw */
export function normalizeKeyScope(raw) {
  return MCP_KEY_SCOPES.includes(raw) ? raw : 'read-write';
}

/** @param {unknown} raw */
export function normalizeExpiryOption(raw) {
  return MCP_KEY_EXPIRY_OPTIONS.includes(raw) ? raw : 'never';
}

/** @param {string} option @param {Date} [from] */
export function expiryDate(option, from = new Date()) {
  const days = option === '7d' ? 7 : option === '30d' ? 30 : 0;
  if (!days) return null;
  return new Date(from.getTime() + days * 86_400_000).toISOString();
}

/** @param {string | null | undefined} expiresAt @param {number} [nowMs] */
export function isTokenExpired(expiresAt, nowMs = Date.now()) {
  if (!expiresAt) return false;
  const expiresMs = Date.parse(expiresAt);
  return Number.isFinite(expiresMs) && expiresMs <= nowMs;
}

/** @param {string | null | undefined} expiresAt @param {number} [nowMs] */
export function keyStatus(expiresAt, nowMs = Date.now()) {
  return isTokenExpired(expiresAt, nowMs) ? 'expired' : 'live';
}

/** @param {string | null | undefined} expiresAt @param {number} [nowMs] */
export function expiryState(expiresAt, nowMs = Date.now()) {
  if (!expiresAt) return { expiresAt: null, expired: false, expiresInDays: null };
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) return { expiresAt, expired: false, expiresInDays: null };
  return {
    expiresAt,
    expired: expiresMs <= nowMs,
    expiresInDays: Math.max(0, Math.ceil((expiresMs - nowMs) / 86_400_000)),
  };
}
export const MCP_NAME_SUGGESTIONS = ['ChatGPT', 'Cursor', 'Claude'];

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/** Appwrite document id: mt. + 32 hex = 35 chars (max 36). */
export function tokenDocumentId(hashHex) {
  return `mt.${String(hashHex).slice(0, 32)}`;
}

export function mintSecret() {
  return `${TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
}

export function looksLikeToken(value) {
  const s = String(value || '').trim();
  return s.startsWith(TOKEN_PREFIX) && s.length === TOKEN_PREFIX.length + 48;
}

/**
 * Human label for the keys table + default mcpServers key.
 * Empty → "jobby". Max 32 chars; letters, digits, space, hyphen, underscore.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeKeyName(raw) {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 32)
    .trim();
  return cleaned || 'jobby';
}

/**
 * mcpServers / connector id — no spaces (Cursor/Claude JSON keys).
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function serverNameFromLabel(raw) {
  return normalizeKeyName(raw).replace(/\s+/g, '-');
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {string} tenantId
 */
export async function listTokens(tenantId) {
  if (!tenantId) return [];
  if (usesLocalStore(tenantId)) {
    return loadLocal(tenantId).map(shapeRow).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }
  if (!appwriteConfigured()) return [];
  let rows;
  try {
    rows = await listDocuments(COL_MCP, [
      Q.equal('tenantId', [tenantId]),
      Q.limit(20),
    ]);
  } catch (err) {
    if (isAppwriteUnavailable(err)) return [];
    throw err;
  }
  return rows
    .map(shapeRow)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/**
 * @param {string} tenantId
 */
async function revokeAll(tenantId) {
  if (usesLocalStore(tenantId)) {
    const n = loadLocal(tenantId).length;
    saveLocal(tenantId, []);
    return n;
  }
  const rows = await listTokens(tenantId);
  for (const row of rows) {
    await deleteDocument(COL_MCP, row.id);
  }
  return rows.length;
}

/**
 * Mint a new key for this tenant. Returns the secret once.
 *
 * @param {string} tenantId
 * @param {{ name?: string, rotate?: boolean }} [opts]
 * @returns {Promise<{ token: string, prefix: string, createdAt: string, name: string, id: string }>}
 */
/**
 * @param {string} tenantId
 * @param {{ name?: string, rotate?: boolean, scope?: 'read'|'read-write', expires?: 'never'|'7d'|'30d' }} [opts]
 */
export async function createToken(tenantId, opts = {}) {
  if (!tenantId) {
    const err = new Error('tenantId is required');
    err.status = 400;
    throw err;
  }
  const name = normalizeKeyName(opts.name);
  const rotate = Boolean(opts.rotate);
  if (rotate) {
    await revokeAll(tenantId);
  } else {
    const existing = await listTokens(tenantId);
    const live = existing.filter((row) => row.status === 'live');
    if (live.length >= MAX_MCP_KEYS) {
      const err = new Error(
        `At most ${MAX_MCP_KEYS} live keys — revoke one or rotate before adding another.`,
      );
      err.status = 409;
      throw err;
    }
  }
  const scope = normalizeKeyScope(opts.scope);
  const expires = normalizeExpiryOption(opts.expires);
  const token = mintSecret();
  const hash = hashToken(token);
  const id = tokenDocumentId(hash);
  const createdAt = nowIso();
  const expiresAt = expiryDate(expires, new Date(createdAt));
  const prefix = token.slice(0, 7);
  const row = {
    id,
    tenantId,
    name,
    prefix,
    scope,
    ...(expiresAt ? { expiresAt } : {}),
    createdAt,
    lastUsedAt: createdAt,
  };
  if (usesLocalStore(tenantId)) {
    saveLocal(tenantId, [...loadLocal(tenantId).filter((k) => k.id !== id), row]);
  } else if (!appwriteConfigured()) {
    const err = new Error('Appwrite is not configured — cannot mint an MCP key.');
    err.status = 503;
    throw err;
  } else {
    await createDocument(COL_MCP, id, {
      tenantId,
      name,
      prefix,
      scope,
      ...(expiresAt ? { expiresAt } : {}),
      createdAt,
      lastUsedAt: createdAt,
    });
  }
  return { token, prefix, createdAt, expiresAt, expires, name, id, scope };
}

/**
 * Resolve a presented secret to a tenant. Null on miss or bad shape.
 *
 * @param {string} token
 * @returns {Promise<{ tenantId: string, id: string, scope: string, expiresAt: string | null, expired: boolean } | null>}
 */
export async function resolveToken(token) {
  const raw = String(token || '').trim();
  if (!looksLikeToken(raw)) return null;
  const id = tokenDocumentId(hashToken(raw));
  const local = loadLocal('default').find((k) => k.id === id);
  if (local) {
    const expiresAt = local.expiresAt ?? null;
    return {
      tenantId: 'default',
      id,
      scope: normalizeKeyScope(local.scope),
      expiresAt,
      expired: isTokenExpired(expiresAt),
    };
  }
  if (!appwriteConfigured()) return null;
  let doc;
  try {
    doc = await getDocument(COL_MCP, id);
  } catch (err) {
    if (isAppwriteUnavailable(err)) return null;
    throw err;
  }
  if (!doc?.tenantId) return null;
  const expiresAt = doc.expiresAt ?? null;
  // Legacy keys predate scopes and expiry — treat them as full, non-expiring access.
  return {
    tenantId: doc.tenantId,
    id,
    scope: normalizeKeyScope(doc.scope),
    expiresAt,
    expired: isTokenExpired(expiresAt),
  };
}

/**
 * Best-effort last-used stamp. A failed write must not fail the MCP call.
 *
 * @param {string} id
 */
export async function touchToken(id) {
  if (!id) return;
  const localKeys = loadLocal('default');
  const local = localKeys.find((k) => k.id === id);
  if (local) {
    saveLocal(
      'default',
      localKeys.map((k) => (k.id === id ? { ...k, lastUsedAt: nowIso() } : k)),
    );
    return;
  }
  if (!appwriteConfigured()) return;
  try {
    await updateDocument(COL_MCP, id, { lastUsedAt: nowIso() });
  } catch {
    /* ignore */
  }
}

/**
 * Rename a live key (label only — secret and id stay the same).
 *
 * @param {string} tenantId
 * @param {string} tokenId
 * @param {string} [rawName]
 */
export async function renameToken(tenantId, tokenId, rawName) {
  const id = String(tokenId || '').trim();
  if (!id) {
    const err = new Error('key id is required');
    err.status = 400;
    throw err;
  }
  const rows = await listTokens(tenantId);
  const hit = rows.find((r) => r.id === id);
  if (!hit) {
    const err = new Error('key not found');
    err.status = 404;
    throw err;
  }
  const name = normalizeKeyName(rawName);
  if (usesLocalStore(tenantId)) {
    saveLocal(
      tenantId,
      loadLocal(tenantId).map((k) => (k.id === id ? { ...k, name } : k)),
    );
  } else if (!appwriteConfigured()) {
    const err = new Error('Appwrite is not configured');
    err.status = 503;
    throw err;
  } else {
    await updateDocument(COL_MCP, id, { name });
  }
  return { id, name, prefix: hit.prefix, createdAt: hit.createdAt, lastUsedAt: hit.lastUsedAt };
}

/**
 * Revoke one key by id, or every key for the tenant when id is omitted.
 *
 * @param {string} tenantId
 * @param {string} [tokenId]
 */
export async function revokeToken(tenantId, tokenId) {
  const id = String(tokenId || '').trim();
  if (usesLocalStore(tenantId)) {
    const keys = loadLocal(tenantId);
    if (id) {
      const hit = keys.find((k) => k.id === id);
      if (!hit) {
        const err = new Error('key not found');
        err.status = 404;
        throw err;
      }
      saveLocal(tenantId, keys.filter((k) => k.id !== id));
      return { revoked: 1 };
    }
    saveLocal(tenantId, []);
    return { revoked: keys.length };
  }
  if (!appwriteConfigured()) return { revoked: 0 };
  if (id) {
    const rows = await listTokens(tenantId);
    const hit = rows.find((r) => r.id === id);
    if (!hit) {
      const err = new Error('key not found');
      err.status = 404;
      throw err;
    }
    await deleteDocument(COL_MCP, id);
    return { revoked: 1 };
  }
  const revoked = await revokeAll(tenantId);
  return { revoked };
}
