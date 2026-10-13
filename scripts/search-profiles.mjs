/**
 * Search profiles store — the M2 query source (DATA_CONTRACT user-layer file
 * `config/search-profiles.json`). One store, shared by the web app and the CLI
 * toolchain so a profile created in the dashboard is what `scan.mjs` reads (FR-005).
 *
 * Pure ESM JS (no TS) so the CLI imports it directly and the web re-exports it
 * from `web/src/lib/core/search-profiles.ts` — same pattern as clean-chips.mjs.
 *
 * Schema (data-model.md): { version: 1, profiles: SearchProfile[] }.
 *   id        sp_ + 8–16 lowercase hex
 *   title     1–80 chars, unique per tenant (case-insensitive)
 *   queries   1–24 items, 1–64 chars each
 *   locations 0–24 items, 1–64 chars each
 *   enabled   boolean (default true on create)
 *   updatedAt ISO-8601, set on every real change
 *
 * Validation rejects when queries.length===0 && locations.length===0 (never "everything").
 * Idempotent PUT: identical logical payload → identical UTF-8 bytes (no updatedAt churn).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const PROFILES_REL = path.join('config', 'search-profiles.json');
export const PROFILE_ID_RE = /^sp_[a-z0-9]{8,16}$/;

const MAX_TITLE = 80;
const MAX_ITEMS = 24;
const MAX_ITEM = 64;

/** @param {string} root */
export function profilesPath(root) {
  return path.join(root, PROFILES_REL);
}

/** @param {unknown} v */
function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** @param {unknown} v */
function trimStrings(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((s) => String(s ?? '').trim())
    .filter((s) => s.length > 0 && s.length <= MAX_ITEM)
    .slice(0, MAX_ITEMS);
}

/** @param {unknown} v */
function normTitle(v) {
  return String(v ?? '').trim().slice(0, MAX_TITLE);
}

/** @param {unknown} v */
function normEnabled(v) {
  return v === true || v === 'true';
}

/**
 * Normalize a single profile document to canonical form (stable key order, trimmed).
 * @param {Record<string, unknown>} raw
 * @param {{ id?: string }} [opts]
 * @returns {{ id: string, title: string, queries: string[], locations: string[], enabled: boolean, updatedAt: string }}
 */
function normalizeProfile(raw, opts = {}) {
  // Preserve an existing valid id (load path) over minting a new one (create path):
  // without this, loadProfiles would regenerate every id on each read and the
  // in-memory id would diverge from the one on disk.
  const fromRaw = typeof raw?.id === 'string' && PROFILE_ID_RE.test(raw.id) ? raw.id : '';
  const fromOpts = opts.id && PROFILE_ID_RE.test(opts.id) ? opts.id : '';
  const id = fromRaw || fromOpts || newId();
  return {
    id,
    title: normTitle(raw.title),
    queries: trimStrings(raw.queries),
    locations: trimStrings(raw.locations),
    enabled: raw.enabled === undefined ? true : normEnabled(raw.enabled),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
}

/** @returns {string} */
export function newId() {
  return 'sp_' + randomBytes(6).toString('hex').slice(0, 12);
}

/**
 * Validate a normalized profile. Returns the first error string or null.
 * @param {{ title: string, queries: string[], locations: string[] }} p
 * @returns {string | null}
 */
export function validateProfile(p) {
  if (!p.title) return 'title is required (1–80 chars)';
  if (p.queries.length === 0 && p.locations.length === 0) {
    return 'at least one of queries or locations must be non-empty';
  }
  return null;
}

/**
 * Read + parse the store from `root`. Tolerant: missing/corrupt file → empty store.
 * @param {string} root
 * @returns {{ version: number, profiles: any[] }}
 */
export function loadProfiles(root) {
  const file = profilesPath(root);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { version: 1, profiles: [] };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { version: 1, profiles: [] };
  }
  if (!isObj(doc) || !Array.isArray(doc.profiles)) return { version: 1, profiles: [] };
  const profiles = doc.profiles
    .filter(isObj)
    .map((p) => normalizeProfile(p))
    .filter((p) => PROFILE_ID_RE.test(p.id));
  return { version: 1, profiles };
}

/** @param {{ version: number, profiles: any[] }} store */
function serialize(store) {
  return JSON.stringify(store, null, 2) + '\n';
}

/** @param {any[]} profiles */
function sortByTitle(profiles) {
  return [...profiles].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

/**
 * List profiles sorted by title.
 * @param {string} root
 * @returns {any[]}
 */
export function listProfiles(root) {
  return sortByTitle(loadProfiles(root).profiles);
}

/**
 * Find one profile by id (no tenant leakage — caller scopes `root`).
 * @param {string} root
 * @param {string} id
 */
export function getProfile(root, id) {
  return loadProfiles(root).profiles.find((p) => p.id === id) || null;
}

/**
 * Create a profile. Throws on validation/title-conflict.
 * @param {string} root
 * @param {{ title?: string, queries?: string[], locations?: string[], enabled?: boolean }} input
 */
export function createProfile(root, input) {
  const store = loadProfiles(root);
  const profile = normalizeProfile(input || {});
  const err = validateProfile(profile);
  if (err) throw Object.assign(new Error(err), { status: 400 });
  assertTitleUnique(store.profiles, profile.title);
  profile.updatedAt = new Date().toISOString();
  store.profiles.push(profile);
  persist(root, store);
  return profile;
}

/**
 * Idempotent upsert by id. PUT semantics: replaces all fields except id.
 * Returns the stored profile. 404 when id is unknown (POST creates).
 * @param {string} root
 * @param {string} id
 * @param {{ title?: string, queries?: string[], locations?: string[], enabled?: boolean }} input
 */
export function upsertProfile(root, id, input) {
  if (!PROFILE_ID_RE.test(id)) throw Object.assign(new Error('bad profile id'), { status: 400 });
  const store = loadProfiles(root);
  const idx = store.profiles.findIndex((p) => p.id === id);
  if (idx === -1) throw Object.assign(new Error('profile not found'), { status: 404 });
  const next = normalizeProfile(input || {}, { id });
  const err = validateProfile(next);
  if (err) throw Object.assign(new Error(err), { status: 400 });
  // title uniqueness against OTHER profiles
  for (const p of store.profiles) {
    if (p.id !== id && p.title.toLowerCase() === next.title.toLowerCase()) {
      throw Object.assign(new Error('title already in use'), { status: 409 });
    }
  }
  // Idempotent: identical payload → no updatedAt churn.
  const cur = store.profiles[idx];
  if (
    cur.title === next.title &&
    sameList(cur.queries, next.queries) &&
    sameList(cur.locations, next.locations) &&
    cur.enabled === next.enabled
  ) {
    return cur;
  }
  next.updatedAt = new Date().toISOString();
  store.profiles[idx] = next;
  persist(root, store);
  return next;
}

/**
 * Partial update (PATCH). Only the supplied fields change.
 * @param {string} root
 * @param {string} id
 * @param {Record<string, unknown>} patch
 */
export function patchProfile(root, id, patch = {}) {
  if (!PROFILE_ID_RE.test(id)) throw Object.assign(new Error('bad profile id'), { status: 400 });
  const store = loadProfiles(root);
  const idx = store.profiles.findIndex((p) => p.id === id);
  if (idx === -1) throw Object.assign(new Error('profile not found'), { status: 404 });
  const cur = store.profiles[idx];
  const merged = {
    title: patch.title !== undefined ? normTitle(patch.title) : cur.title,
    queries: patch.queries !== undefined ? trimStrings(patch.queries) : cur.queries,
    locations: patch.locations !== undefined ? trimStrings(patch.locations) : cur.locations,
    enabled: patch.enabled !== undefined ? normEnabled(patch.enabled) : cur.enabled,
  };
  const err = validateProfile(merged);
  if (err) throw Object.assign(new Error(err), { status: 400 });
  for (const p of store.profiles) {
    if (p.id !== id && p.title.toLowerCase() === merged.title.toLowerCase()) {
      throw Object.assign(new Error('title already in use'), { status: 409 });
    }
  }
  if (
    cur.title === merged.title &&
    sameList(cur.queries, merged.queries) &&
    sameList(cur.locations, merged.locations) &&
    cur.enabled === merged.enabled
  ) {
    return cur;
  }
  const next = { ...cur, ...merged, updatedAt: new Date().toISOString() };
  store.profiles[idx] = next;
  persist(root, store);
  return next;
}

/**
 * Delete a profile. Idempotent — deleting an unknown id is a 404 (per contract).
 * @param {string} root
 * @param {string} id
 */
export function deleteProfile(root, id) {
  if (!PROFILE_ID_RE.test(id)) throw Object.assign(new Error('bad profile id'), { status: 400 });
  const store = loadProfiles(root);
  const idx = store.profiles.findIndex((p) => p.id === id);
  if (idx === -1) throw Object.assign(new Error('profile not found'), { status: 404 });
  store.profiles.splice(idx, 1);
  persist(root, store);
}

/** Enabled profiles, sorted by id ascending (deterministic scan order). */
export function enabledProfiles(root) {
  return loadProfiles(root)
    .profiles.filter((p) => p.enabled)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** @param {any[]} profiles @param {string} title */
function assertTitleUnique(profiles, title) {
  for (const p of profiles) {
    if (p.title.toLowerCase() === title.toLowerCase()) {
      throw Object.assign(new Error('title already in use'), { status: 409 });
    }
  }
}

/** @param {string[]} a @param {string[]} b */
function sameList(a, b) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/** @param {string} root @param {{ version: number, profiles: any[] }} store */
function persist(root, store) {
  const file = profilesPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, serialize({ version: 1, profiles: store.profiles }), 'utf8');
  fs.renameSync(tmp, file);
}

// ── CLI entrypoint: `node scripts/search-profiles.mjs` — list this tenant's
// profiles (resolveRoot + JOBBY_TENANT_ID). JSON to stdout so it's scriptable;
// human-readable summary on stderr. Importable as a module otherwise (the guard
// below is false when imported).
import { fileURLToPath } from 'node:url';
import { resolveRoot } from './resolve-root.mjs';

const __isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (__isMain) {
  const root = resolveRoot();
  const profiles = listProfiles(root);
  const enabled = profiles.filter((p) => p.enabled);
  process.stdout.write(JSON.stringify({ root, total: profiles.length, active: enabled.length, profiles }, null, 2) + '\n');
  process.stderr.write(
    `${profiles.length} profile(s), ${enabled.length} active — ${root}\n` +
      profiles
        .map((p) => `  ${p.enabled ? '[x]' : '[ ]'} ${p.title}  <${p.id}>  q=${p.queries.join(',')}  loc=${p.locations.join(',')}`)
        .join('\n') + (profiles.length ? '\n' : ''),
  );
}

