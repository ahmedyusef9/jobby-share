#!/usr/bin/env node
/**
 * User-data root for the CLI toolchain.
 *
 * Platform checkout (scripts, templates, modes): CAREER_OPS_ROOT, else this
 * file's parent directory.
 * User tree (cv.md, data/, reports/, output/): platform/tenants/{JOBBY_TENANT_ID}
 * when that env is set.
 *
 * Lives in scripts/ so update-system.mjs does not replace it. Root *.mjs that
 * import this are a named local patch — re-apply after an upstream update.
 *
 * Tenant id is never taken from argv or JD text.
 */
import { existsSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { pickChildEnv } from './child-env.mjs';

const TENANT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function platformRoot() {
  const env = process.env.CAREER_OPS_ROOT?.trim();
  if (env) return resolve(env);
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function assertInside(platform, candidate) {
  const root = resolve(platform);
  const abs = resolve(candidate);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (abs !== root && !abs.startsWith(prefix)) {
    throw new Error('tenant root escapes platform root');
  }
  return abs;
}

/**
 * Directory user-layer files live in.
 * @param {string} [override] doctor --target (trusted); skips tenant env
 */
export function resolveRoot(override) {
  if (override != null && String(override).trim() !== '') {
    return resolve(String(override).trim());
  }

  const platform = platformRoot();
  const raw = process.env.JOBBY_TENANT_ID?.trim();
  if (!raw) {
    /*
     * A checkout whose data has moved under tenants/ resolves to the DEFAULT
     * tenant rather than throwing (JOBBY-BL-051).
     *
     * The throw was protecting against a real bug — a CLI writing to the platform
     * root while the web app reads tenants/ — but it protected by breaking every
     * `node scan.mjs` run from the repo root, which is how the toolchain is meant
     * to be used, and it is what those sixteen tests were failing on. Its own
     * message said the fix was "set JOBBY_TENANT_ID (e.g. default)", so doing that
     * is the answer, not an error.
     *
     * `tenantChildEnv` in this same module has always defaulted to `default`; the
     * two are now consistent. Nothing that must be tenant-exact relies on this:
     * the worker resolves through `tenantRootFor(job.data.tenantId)` and the web
     * app through the verified session.
     */
    const marker = join(platform, 'tenants', 'default', '.jobby-tenant');
    if (existsSync(marker) && !existsSync(join(platform, 'cv.md'))) {
      return assertInside(platform, join(platform, 'tenants', 'default'));
    }
    return platform;
  }
  if (!TENANT_ID_RE.test(raw) || raw.includes('..')) {
    throw new Error(`invalid JOBBY_TENANT_ID: ${raw}`);
  }
  return assertInside(platform, join(platform, 'tenants', raw));
}

/**
 * Directory for a NAMED tenant, independent of the process environment.
 *
 * The queue worker needs this: its jobs belong to different tenants, so reading
 * JOBBY_TENANT_ID would give every job the same directory (JOBBY-BL-047).
 *
 * @param {string} tenantId
 */
export function tenantRootFor(tenantId) {
  const raw = String(tenantId ?? '').trim();
  if (!raw) throw new Error('tenantRootFor: no tenant id');
  if (!TENANT_ID_RE.test(raw) || raw.includes('..')) {
    throw new Error(`invalid tenant id: ${raw}`);
  }
  const platform = platformRoot();
  return assertInside(platform, join(platform, 'tenants', raw));
}

/**
 * @param {Record<string, string>} [extra]
 * @param {string} [tenantId] explicit owner; falls back to the process env for
 *   the single-tenant CLI case, where there is only ever one.
 */
export function tenantChildEnv(extra = {}, tenantId) {
  const tenant = String(tenantId ?? '').trim() || process.env.JOBBY_TENANT_ID?.trim() || 'default';
  if (!TENANT_ID_RE.test(tenant) || tenant.includes('..')) {
    throw new Error(`invalid JOBBY_TENANT_ID: ${tenant}`);
  }
  const home = extra.HOME || join(tenantRootFor(tenant), '.home');
  return pickChildEnv({
    CAREER_OPS_ROOT: platformRoot(),
    JOBBY_TENANT_ID: tenant,
    HOME: home,
    ...extra,
  });
}

export { pickChildEnv, providerEnvFor, CHILD_ENV_BASE_KEYS, CLI_PROVIDER_KEYS } from './child-env.mjs';
