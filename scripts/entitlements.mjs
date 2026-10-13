/**
 * Roles, plans and the single gate every restricted action goes through (BL-031/BL-023).
 *
 * Three separate ideas that are easy to confuse, kept apart on purpose:
 *
 *   tenant isolation — WHOSE data is this? Already enforced: the tenant comes from
 *                      the verified session and a request can only ever reach its own.
 *   role            — WHAT KIND of user is this? operator/admin vs member. Only the
 *                      operator may see the admin console or touch another account.
 *   plan            — HOW MUCH may this account do? Feature and quota gating, which is
 *                      what gets switched on after the POC.
 *
 * RBAC here is deliberately two roles, not a permission system. Five users who cannot
 * see each other's data do not need a role graph; they need one honest admin boundary.
 */

/** @typedef {'operator' | 'member'} Role */

export const ROLE = Object.freeze({
  /** You. Full access, including the admin console and other accounts' metadata. */
  OPERATOR: 'operator',
  /** Everyone else. Full access to their own tenant, nothing outside it. */
  MEMBER: 'member',
});

export const PLAN = Object.freeze({
  /** Unpaid 10-account cohort. Same scrape/MCP quota as advanced (D-033). */
  ALPHA: 'alpha',
  /** $0 — discovery and MCP, small daily caps. */
  FREE: 'free',
  /** $5 */
  BASIC: 'basic',
  /** $10 */
  PLUS: 'plus',
  /** $20 */
  ADVANCED: 'advanced',
});

/**
 * Host-resource meters (D-031). Discovery is zero-token; the numbers are what
 * the machine will survive with ten people. Operator is uncapped (D-012).
 * `priceUsd` is the label the operator assigns — Stripe is out of 0.4.0.
 */
export const PLAN_LIMITS = Object.freeze({
  [PLAN.FREE]: Object.freeze({ priceUsd: 0, scans: 3, mcp: 40, results: 40 }),
  [PLAN.BASIC]: Object.freeze({ priceUsd: 5, scans: 8, mcp: 120, results: 80 }),
  [PLAN.PLUS]: Object.freeze({ priceUsd: 10, scans: 15, mcp: 250, results: 150 }),
  [PLAN.ADVANCED]: Object.freeze({ priceUsd: 20, scans: 30, mcp: 500, results: 250 }),
  [PLAN.ALPHA]: Object.freeze({ priceUsd: 0, scans: 30, mcp: 500, results: 250 }),
});

export const HOST_SCORE_DEFERRED =
  'Scoring on jobby is paused for this release so the shared server stays up. Connect ChatGPT or Claude from Account → MCP (one URL with your key) and score there on your own subscription.';

/**
 * Capabilities, named for what a user does rather than what a route is called.
 * A new gate belongs here, never as an inline plan comparison at a call site.
 */
export const CAP = Object.freeze({
  SEARCH_JOBS: 'search_jobs',
  SCORE_JOB: 'score_job',
  GENERATE_CV: 'generate_cv',
  CV_CHAT: 'cv_chat',
  EXPORT_DATA: 'export_data',
  DELETE_ACCOUNT: 'delete_account',
  MANAGE_OWN_KEYS: 'manage_own_keys',
  /** Operator-only. */
  ADMIN_CONSOLE: 'admin_console',
  ADMIN_MANAGE_ACCOUNTS: 'admin_manage_accounts',
  /** Operator-only. Editing the permission matrix itself (BL-054). */
  ADMIN_RBAC: 'admin_rbac',
});

const MEMBER_SELF_SERVICE = [
  CAP.EXPORT_DATA,
  CAP.DELETE_ACCOUNT,
  CAP.MANAGE_OWN_KEYS,
  CAP.SEARCH_JOBS,
];

/**
 * What each plan allows. Scanning is zero-token so it stays free at every level;
 * the metered capabilities are the ones that cost money.
 */
const PLAN_CAPS = Object.freeze({
  [PLAN.ALPHA]: [...MEMBER_SELF_SERVICE, CAP.GENERATE_CV, CAP.CV_CHAT],
  [PLAN.FREE]: [...MEMBER_SELF_SERVICE],
  [PLAN.BASIC]: [...MEMBER_SELF_SERVICE, CAP.GENERATE_CV],
  [PLAN.PLUS]: [...MEMBER_SELF_SERVICE, CAP.GENERATE_CV],
  [PLAN.ADVANCED]: [...MEMBER_SELF_SERVICE, CAP.GENERATE_CV, CAP.CV_CHAT],
});

/* ------------------------------------------------------------------ *
 * Runtime plan-cap overrides (BL-054). The defaults above ship with the
 * release; the operator console may edit a plan's capability list live via
 * the config store (no restart). The in-process copy is what `can()` reads;
 * persistence lives in the rbac admin route.
 * ------------------------------------------------------------------ */

let planCapsRuntime = null; // null = pure defaults

/** Capabilities that can never be granted or revoked through an override:
 *  the self-service floor and the operator-only set are structural. */
const STRUCTURAL_CAPS = Object.freeze([
  CAP.EXPORT_DATA,
  CAP.DELETE_ACCOUNT,
  CAP.ADMIN_CONSOLE,
  CAP.ADMIN_MANAGE_ACCOUNTS,
  CAP.ADMIN_RBAC,
]);

const KNOWN_CAPS = new Set(Object.values(CAP));

/**
 * Validate and apply an overrides patch: `{ [planId]: string[] }`. A plan key
 * replaces that plan's list wholesale. Throws with a precise message on any
 * bad shape — the caller turns it into a 400.
 *
 * @param {Readonly<Record<string, readonly string[]>> | null | undefined} patch
 */
export function applyPlanCapOverrides(patch) {
  if (patch === null || patch === undefined) {
    planCapsRuntime = null;
    return null;
  }
  if (typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('planCaps override must be an object keyed by plan id');
  }
  for (const [plan, caps] of Object.entries(patch)) {
    if (!Object.values(PLAN).includes(plan)) {
      throw new Error(`unknown plan in override: ${plan}`);
    }
    if (!Array.isArray(caps) || caps.some((c) => typeof c !== 'string')) {
      throw new Error(`override for ${plan} must be an array of capability ids`);
    }
    const unknown = caps.filter((c) => !KNOWN_CAPS.has(c));
    if (unknown.length) throw new Error(`unknown capability ids: ${unknown.join(', ')}`);
    if (caps.includes(CAP.ADMIN_CONSOLE) || caps.includes(CAP.ADMIN_MANAGE_ACCOUNTS) || caps.includes(CAP.ADMIN_RBAC)) {
      throw new Error('operator-only capabilities cannot be granted to a plan');
    }
  }
  planCapsRuntime = Object.freeze(
    Object.fromEntries(Object.entries(patch).map(([p, caps]) => [p, Object.freeze([...caps])])),
  );
  return planCapsRuntime;
}

/** Currently applied override (for the console to show what diverges from defaults). */
export function currentPlanCapOverrides() {
  return planCapsRuntime;
}

function effectivePlanCaps(plan) {
  const override = planCapsRuntime?.[plan];
  if (override) return override;
  return PLAN_CAPS[plan] ?? PLAN_CAPS[PLAN.ALPHA];
}

/**
 * The full matrix the RBAC console renders: every role × capability × plan,
 * plus which limits each plan carries and whether overrides are in play.
 */
export function rbacMatrix() {
  return {
    roles: Object.values(ROLE),
    plans: Object.values(PLAN),
    caps: Object.values(CAP),
    memberCaps: [...MEMBER_SELF_SERVICE],
    structuralCaps: [...STRUCTURAL_CAPS],
    planCaps: Object.fromEntries(
      Object.values(PLAN).map((p) => [p, [...effectivePlanCaps(p)]]),
    ),
    planLimits: PLAN_LIMITS,
    overridden: planCapsRuntime !== null,
  };
}

/**
 * The gate.
 *
 * @param {{role?: string, plan?: string, status?: string} | null} account
 * @param {string} capability
 * @returns {boolean}
 */
export function can(account, capability) {
  if (!account) return false;

  // A suspended or deleting account can do nothing except leave with its data.
  if (account.status && account.status !== 'active') {
    return capability === CAP.EXPORT_DATA;
  }

  // The operator is not "a plan with more features" — it is a different kind of
  // user, so it bypasses plan gating entirely rather than being the top tier.
  if (account.role === ROLE.OPERATOR) return true;

  if (capability === CAP.ADMIN_CONSOLE || capability === CAP.ADMIN_MANAGE_ACCOUNTS || capability === CAP.ADMIN_RBAC) {
    return false;
  }

  const plan = account.plan || PLAN.ALPHA;
  return effectivePlanCaps(plan).includes(capability);
}

/** @param {{role?: string} | null} account */
export function isOperator(account) {
  return account?.role === ROLE.OPERATOR;
}

/**
 * Engines a member may run: NONE (BL-058 zero-key rule).
 *
 * R1 product rule, binding: members never provide API keys and jobby never
 * runs an AI model on their behalf. All scoring and CV intelligence happens in
 * the member's own assistant through the MCP surface. The list below remains
 * exported only so legacy filters keep compiling; the operator is the sole
 * account that may spawn any engine.
 */
export const SELF_FUNDED_ENGINES = Object.freeze(['openrouter', 'ollama', 'api-key']);

export const ZERO_KEY_MEMBER_DENIAL =
  'In this release jobby runs no AI models for members — bring your own assistant instead. Connect ChatGPT or Claude from Account → MCP (one URL with your key) and score or edit your CV there on your own subscription.';

/** @deprecated old name kept for existing imports; same text as ZERO_KEY_MEMBER_DENIAL. */
export const HOST_ENGINE_DENIAL = ZERO_KEY_MEMBER_DENIAL;

/** @param {string | null | undefined} cliId */
export function isSelfFundedEngine(cliId) {
  return SELF_FUNDED_ENGINES.includes(cliId);
}

/**
 * @param {{role?: string} | null | undefined} account
 * @param {string | null | undefined} cliId
 */
export function mayUseEngine(account, cliId) {
  // Zero-key rule (BL-058): an active operator may run anything configured on
  // the host; every other account runs nothing at all — suspended operators
  // included. Checked before the role bypass, same order as can().
  if (!account || (account.status && account.status !== 'active')) return false;
  void cliId;
  return isOperator(account);
}

/**
 * Throw if this account may not spawn `cliId`. Call from every CLI spawn path
 * (inline routes AND the worker) so hiding a Config card cannot be the only gate.
 *
 * @param {{role?: string} | null | undefined} account
 * @param {string | null | undefined} cliId
 */
export function assertSelfFundedEngine(account, cliId) {
  if (mayUseEngine(account, cliId)) return;
  const err = new Error(HOST_ENGINE_DENIAL);
  err.status = 403;
  err.code = 'HOST_ENGINE';
  throw err;
}

/**
 * Default plan for a newly provisioned account.
 *
 * During the POC this is `alpha` — everything on, because testers bring their own
 * key. Setting JOBBY_DEFAULT_PLAN=free is the one switch that closes the gate for
 * everyone who signs up afterwards, without touching existing accounts.
 */
export function defaultPlan(env = process.env) {
  const v = env.JOBBY_DEFAULT_PLAN?.trim();
  return v && Object.values(PLAN).includes(v) ? v : PLAN.ALPHA;
}

/** Human label for the reason a gate closed, shown to the user rather than a 403. */
export function denialReason(account, capability) {
  if (!account) return 'Sign in to continue.';
  if (account.status && account.status !== 'active') {
    return 'This account is suspended. You can still export your data.';
  }
  if (capability === CAP.ADMIN_CONSOLE || capability === CAP.ADMIN_MANAGE_ACCOUNTS || capability === CAP.ADMIN_RBAC) {
    return 'That area is operator-only.';
  }
  if (capability === CAP.SCORE_JOB) return HOST_SCORE_DEFERRED;
  return 'Your plan does not include this yet.';
}

/**
 * Daily host-resource caps for this account. Operator → null (uncapped).
 *
 * @param {{ role?: string, plan?: string } | null | undefined} account
 * @returns {{ scans: number, mcp: number, results: number, priceUsd: number } | null}
 */
export function planLimits(account) {
  if (!account || isOperator(account)) return null;
  const plan = account.plan || PLAN.ALPHA;
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS[PLAN.ALPHA];
}
