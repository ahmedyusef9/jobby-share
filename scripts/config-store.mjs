/**
 * Live application config, versioned in Appwrite (JOBBY-BL-044).
 *
 * What this replaces
 * ------------------
 * Settings in `deploy/.env`, which could only change by editing a file and
 * recreating the container, recorded nothing about who changed what or when, and
 * meant a running deployment could not be adjusted at all.
 *
 * How reload works
 * ----------------
 * The active config row is read and cached with a short TTL. On refresh the
 * version is compared; if it changed, the whole frozen object is REPLACED. The
 * process is never restarted and the object is never mutated — swapping a frozen
 * reference is atomic, so a request either sees the old config or the new one,
 * never a half-applied mix.
 *
 * Publishing a new version is therefore: create a draft, activate it, and within
 * one TTL every running instance is using it. No deploy, no restart, no dropped
 * sessions or in-flight jobs.
 *
 * What is deliberately NOT reloadable: anything that changes trust. The schema in
 * release-state.mjs lists seven product settings and no endpoints or credentials,
 * so a hot config swap can never repoint the app at another server or key.
 */
import { CONFIG_STATE, defaultConfig, sealConfig, validateConfig } from './release-state.mjs';
import { Q, appwriteConfigured, listDocuments, updateDocument } from './appwrite-rest.mjs';

const COL_CONFIG = 'app_config';

/** How long a cached config may be stale. Short enough to feel live, long enough
 *  that a request path is not making a network call per call. */
const TTL_MS = Number(process.env.JOBBY_CONFIG_TTL_MS ?? 30_000);

/** @type {{version: string|null, value: Readonly<Record<string, unknown>>, at: number, source: string}} */
let cache = {
  version: null,
  value: sealConfig(defaultConfig()),
  at: 0,
  source: 'defaults',
};

let inflight = null;

/**
 * The config in force right now.
 *
 * Synchronous and never throws: it returns the last good value. Call `refreshConfig()`
 * to pick up a newly activated version — request paths do that opportunistically.
 */
export function currentConfig() {
  return cache.value;
}

export function currentConfigVersion() {
  return cache.version;
}

export function currentConfigSource() {
  return cache.source;
}

/**
 * Re-read the active version if the cache is stale.
 *
 * Returns `{ changed }` so a caller can log or act on a version flip.
 *
 * @param {{force?: boolean}} [opts]
 */
export async function refreshConfig(opts = {}) {
  if (!appwriteConfigured()) {
    return { changed: false, version: cache.version, source: cache.source };
  }
  const fresh = Date.now() - cache.at < TTL_MS;
  if (fresh && !opts.force) {
    return { changed: false, version: cache.version, source: cache.source };
  }
  // Collapse concurrent refreshes — a burst of requests must not become a burst
  // of identical round trips.
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const rows = await listDocuments(COL_CONFIG, [
        Q.equal('state', [CONFIG_STATE.ACTIVE]),
        Q.limit(1),
      ]);
      const row = rows[0];
      if (!row) {
        // No active version yet. Keep whatever we have rather than resetting to
        // defaults — defaults could silently reopen signups.
        cache = { ...cache, at: Date.now() };
        return { changed: false, version: cache.version, source: cache.source };
      }

      const parsed = safeParse(row.config);
      const result = validateConfig(parsed);
      if (!result.ok) {
        // A malformed active row must not take the app down or silently reset it.
        cache = { ...cache, at: Date.now() };
        return {
          changed: false,
          version: cache.version,
          source: cache.source,
          error: `active config ${row.version} is invalid: ${result.errors.join('; ')}`,
        };
      }

      const changed = row.version !== cache.version;
      // Replace the frozen object wholesale; never mutate the live one.
      cache = {
        version: row.version,
        value: sealConfig(result.value),
        at: Date.now(),
        source: 'appwrite',
      };
      return { changed, version: row.version, source: 'appwrite' };
    } catch (err) {
      // Appwrite unreachable: serve the last known config. Falling back to
      // defaults here would be worse than staleness — it could reopen signups or
      // change everyone's plan because a network call failed.
      cache = { ...cache, at: Date.now() };
      return {
        changed: false,
        version: cache.version,
        source: cache.source,
        error: err instanceof Error ? err.message : 'config refresh failed',
      };
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** Refresh if stale, then return the config. The normal accessor for request paths. */
export async function getConfig() {
  await refreshConfig();
  return cache.value;
}

function safeParse(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw ?? '{}'));
  } catch {
    return {};
  }
}

/**
 * Publish a new version and make it active.
 *
 * Operator action. The previous active row is retired rather than edited, so what
 * a past release ran with stays readable.
 *
 * @param {string} version
 * @param {Record<string, unknown>} value
 * @param {string} [notes]
 */
export async function publishConfigVersion(version, value, notes = '') {
  const result = validateConfig(value);
  if (!result.ok) return { ok: false, errors: result.errors };

  const { createDocument } = await import('./appwrite-rest.mjs');
  const now = new Date().toISOString();

  await createDocument(COL_CONFIG, version, {
    version,
    state: CONFIG_STATE.ACTIVE,
    config: JSON.stringify(result.value),
    notes,
    createdAt: now,
    activatedAt: now,
  });

  // Retire the previous active rows AFTER the new one exists, so there is never a
  // window with no active config.
  const previous = await listDocuments(COL_CONFIG, [Q.equal('state', [CONFIG_STATE.ACTIVE])]);
  for (const row of previous) {
    if (row.version === version) continue;
    await updateDocument(COL_CONFIG, row.$id, {
      state: CONFIG_STATE.RETIRED,
      retiredAt: now,
    });
  }

  await refreshConfig({ force: true });
  return { ok: true, version, config: result.value };
}

/**
 * Next immutable version id. Appwrite document ids allow a-z A-Z 0-9 . - _
 * and at most 36 characters, so this stays inside that alphabet.
 *
 * @param {string | null | undefined} current
 */
export function nextConfigVersion(current) {
  const raw = String(current || '1.0.0');
  const m = raw.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (m) return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
  return `cfg.${Date.now().toString(36)}`.slice(0, 36);
}

/**
 * Operator patch: take the live config, overlay a few keys, publish a new
 * version. The previous row is retired, not edited — that is what makes a
 * second instance pick the change up without a shared file.
 *
 * @param {Record<string, unknown>} partial
 * @param {string} [notes]
 */
export async function patchActiveConfig(partial, notes = '') {
  await refreshConfig({ force: true });
  const current = await getConfig();
  const version = nextConfigVersion(cache.version);
  return publishConfigVersion(version, { ...current, ...partial }, notes);
}
