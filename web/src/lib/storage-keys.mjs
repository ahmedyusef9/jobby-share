/**
 * localStorage key scoping, and the one rule about legacy migration
 * (JOBBY-BL-052).
 *
 * The bug this exists to stop
 * --------------------------
 * Keys are scoped per tenant (`jobby:{tenant}:jobs`), but the reader used to fall
 * back to the PRE-TENANCY unscoped key (`jobby:jobs`) whenever the scoped one was
 * missing — and then copy it into the caller's scope. That fallback was written
 * for a single-user install upgrading in place. On a shared browser it means a
 * brand-new member, who has never uploaded a CV or run anything, opens Workers and
 * sees somebody else's evaluations: company names, scores and verdict sentences,
 * permanently copied into their own storage.
 *
 * The unscoped data belongs to the original single-user install, and that install
 * is the `default` tenant. So only `default` may inherit it. Everyone else starts
 * empty, which is the correct state for an account that has done nothing.
 *
 * The `v2` segment
 * ----------------
 * Blocking future copies is not enough: browsers that already ran the old reader
 * have somebody else's rows sitting in their own scoped key. Bumping the
 * namespace orphans everything written under the old rule in one move. `default`
 * walks the chain back to its real data; every other tenant simply starts clean.
 */

const PREFIX = 'jobby';
const LEGACY_PREFIX = 'career-ops';

/** The tenant that owns any pre-tenancy data on this machine. */
export const MIGRATABLE_SCOPE = 'default';

/** No session resolved yet. Never inherits anything. */
export const ANON_SCOPE = 'anon';

/** Namespace generation. Bumping it abandons everything written under the old rule. */
export const NAMESPACE = 'v2';

/** @param {string} name @param {string} scope */
export function storageKey(name, scope) {
  // Theme is a device preference, not account data — one value per browser.
  if (name === 'theme') return `${PREFIX}:${name}`;
  return `${PREFIX}:${NAMESPACE}:${scope || ANON_SCOPE}:${name}`;
}

/** @param {string} name */
export function unscopedKey(name) {
  return `${PREFIX}:${name}`;
}

/** @param {string} name */
export function legacyKey(name) {
  return `${LEGACY_PREFIX}:${name}`;
}

/**
 * May this scope adopt pre-tenancy data left in the browser?
 *
 * Only the default tenant, and only with a real session. An anonymous visitor
 * inheriting somebody's job history would be the same leak with fewer steps.
 *
 * @param {string} scope
 */
export function mayInheritUnscoped(scope) {
  return scope === MIGRATABLE_SCOPE;
}

/**
 * Older keys this scope may adopt, oldest-usable first to newest.
 *
 * Empty for everyone but `default`: a member has nothing to migrate, because they
 * never had data on this machine — anything sitting there belongs to whoever used
 * the browser before them.
 *
 * @param {string} name @param {string} scope
 */
export function inheritChain(name, scope) {
  if (name === 'theme') return [];
  if (!mayInheritUnscoped(scope)) return [];
  return [
    `${PREFIX}:${MIGRATABLE_SCOPE}:${name}`, // v1 scoped
    unscopedKey(name), // pre-tenancy
    legacyKey(name), // career-ops
  ];
}
