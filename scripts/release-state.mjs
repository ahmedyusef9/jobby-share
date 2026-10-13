/**
 * Release state machine: versioned config and open signup with runtime capacity
 * (JOBBY-BL-043, JOBBY-BL-046).
 *
 * The model
 * ---------
 *   app_config   one immutable row per version; exactly one is `active`
 *   batch        one signup cohort per release, with a CAPACITY and a state
 *   slot         one row per account admitted, created at signup
 *
 * Registration is OPEN. Anybody may create an account while the batch is open and
 * the number of accounts is below capacity — there are no invitations, no codes and
 * no allow-list. Capacity is a runtime number the operator raises (10 → 15) without
 * a deploy; when it is reached, the next person is told the round is full.
 *
 * This deliberately replaced an invite-seat design: capacity control is the goal,
 * gate-keeping who may try is not.
 *
 * Pure functions only. Every rule here is decided without touching Appwrite or the
 * filesystem, so the machine can be tested exhaustively and the storage layer is
 * free to be a database, a file, or a mock.
 */

/* ------------------------------------------------------------------ *
 * States
 * ------------------------------------------------------------------ */

export const CONFIG_STATE = Object.freeze({
  DRAFT: 'draft',
  ACTIVE: 'active',
  RETIRED: 'retired',
});

export const BATCH_STATE = Object.freeze({
  /** Being prepared. Invites may be added; nobody can sign up. */
  DRAFT: 'draft',
  /** Accepting signups. */
  OPEN: 'open',
  /** Every seat claimed. Not an error — the batch did its job. */
  FULL: 'full',
  /** No new signups. Existing accounts keep working. */
  CLOSED: 'closed',
  /** Historical record only. */
  ARCHIVED: 'archived',
});

/* ------------------------------------------------------------------ *
 * Transitions
 * ------------------------------------------------------------------ */

/**
 * Allowed batch transitions.
 *
 * `full` is reachable both ways: raising capacity on a full batch reopens it,
 * which is the normal "two more testers asked to join" case and must not require
 * creating a second batch.
 */
const BATCH_TRANSITIONS = Object.freeze({
  [BATCH_STATE.DRAFT]: [BATCH_STATE.OPEN, BATCH_STATE.ARCHIVED],
  [BATCH_STATE.OPEN]: [BATCH_STATE.FULL, BATCH_STATE.CLOSED],
  [BATCH_STATE.FULL]: [BATCH_STATE.OPEN, BATCH_STATE.CLOSED],
  [BATCH_STATE.CLOSED]: [BATCH_STATE.OPEN, BATCH_STATE.ARCHIVED],
  [BATCH_STATE.ARCHIVED]: [],
});

const CONFIG_TRANSITIONS = Object.freeze({
  [CONFIG_STATE.DRAFT]: [CONFIG_STATE.ACTIVE],
  [CONFIG_STATE.ACTIVE]: [CONFIG_STATE.RETIRED],
  // Retired is terminal. Re-activating an old version silently changes what a
  // release means; publish a new version that copies it instead.
  [CONFIG_STATE.RETIRED]: [],
});

/** @param {Record<string, string[]>} table @param {string} from @param {string} to */
function allowed(table, from, to) {
  return (table[from] ?? []).includes(to);
}

/** @param {string} from @param {string} to */
export function canTransitionBatch(from, to) {
  return allowed(BATCH_TRANSITIONS, from, to);
}

/** @param {string} from @param {string} to */
export function canTransitionConfig(from, to) {
  return allowed(CONFIG_TRANSITIONS, from, to);
}

/**
 * Apply a batch transition, or explain the refusal.
 * @param {{state: string, capacity?: number}} batch
 * @param {string} to
 * @returns {{ok: true, state: string} | {ok: false, error: string}}
 */
export function transitionBatch(batch, to) {
  const from = batch?.state;
  if (!Object.values(BATCH_STATE).includes(to)) {
    return { ok: false, error: `unknown batch state: ${to}` };
  }
  if (from === to) return { ok: true, state: to };
  if (!canTransitionBatch(from, to)) {
    return { ok: false, error: `a ${from} batch cannot become ${to}` };
  }
  // Opening a batch with no seats would show a signup form nobody can complete.
  if (to === BATCH_STATE.OPEN && !(batch.capacity > 0)) {
    return { ok: false, error: 'set a capacity before opening the batch' };
  }
  return { ok: true, state: to };
}

/* ------------------------------------------------------------------ *
 * Capacity accounting
 * ------------------------------------------------------------------ */

/**
 * How full the round is.
 *
 * `taken` is a count of slot rows, so it is derived from what actually exists
 * rather than from a stored counter that can drift.
 *
 * @param {number} taken     accounts admitted so far
 * @param {number} capacity  the operator's current limit
 */
export function capacityOf(taken, capacity) {
  const total = Number.isFinite(capacity) && capacity >= 0 ? capacity : 0;
  const used = Number.isFinite(taken) && taken >= 0 ? taken : 0;
  return { total, taken: used, remaining: Math.max(0, total - used) };
}

/** The alpha-is-full message, in one place so every caller says the same thing. */
export const FULL_MESSAGE =
  'Jobby is currently full. We are testing this release with a limited number of ' +
  'people. Please check back soon for the next round.';

/**
 * The single question signup asks: may somebody create an account right now?
 *
 * Registration is open — this does NOT check who the applicant is. It checks only
 * that the round is accepting people and that there is room. A refusal is shown to
 * a real person, so it returns a sentence rather than a boolean.
 *
 * @param {{state: string, capacity?: number, plan?: string, batchId?: string} | null} batch
 * @param {number} taken  accounts already admitted to this batch
 * @param {{email: string}} applicant
 */
export function evaluateSignup(batch, taken, applicant) {
  const email = String(applicant?.email ?? '').trim().toLowerCase();
  if (!email) return { allowed: false, reason: 'Enter a valid email address.' };

  if (!batch) {
    return { allowed: false, reason: 'Sign-ups are not open right now.' };
  }
  if (batch.state === BATCH_STATE.DRAFT) {
    return { allowed: false, reason: 'This round has not opened yet.' };
  }
  if (batch.state === BATCH_STATE.CLOSED || batch.state === BATCH_STATE.ARCHIVED) {
    return { allowed: false, reason: 'This testing round has closed.' };
  }
  if (batch.state === BATCH_STATE.FULL) {
    return { allowed: false, reason: FULL_MESSAGE };
  }

  const c = capacityOf(taken, batch.capacity);
  if (c.remaining <= 0) {
    return { allowed: false, reason: FULL_MESSAGE };
  }

  return { allowed: true, plan: batch.plan, batchId: batch.batchId, remaining: c.remaining };
}

/**
 * Whether the slot just taken was the last one, so the caller can move the batch to
 * `full` in the same operation instead of leaving it open with nothing behind it.
 *
 * @param {number} takenAfterClaim
 * @param {number} capacity
 */
export function batchBecameFull(takenAfterClaim, capacity) {
  return capacityOf(takenAfterClaim, capacity).remaining <= 0;
}

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

/**
 * Settings a batch may override, and their defaults.
 *
 * Anything not listed here is NOT configurable — that is the point. A secret or an
 * endpoint must never become a value an operator can edit through a UI, because
 * config that can change credentials is a privilege-escalation path wearing a
 * settings page.
 */
export const CONFIG_SCHEMA = Object.freeze({
  defaultPlan: { type: 'string', default: 'alpha', oneOf: ['alpha', 'free', 'basic', 'advanced'] },
  signupOpen: { type: 'boolean', default: true },
  /**
   * Default capacity applied to a NEW batch. The live limit is `capacity` on the
   * batch row — raising that is what admits more people, and it is deliberately one
   * number in one place so the two can never disagree.
   */
  maxAccounts: { type: 'number', default: 10 },
  sessionMaxAgeDays: { type: 'number', default: 7 },
  deletionGraceDays: { type: 'number', default: 7 },
  requireOwnApiKey: { type: 'boolean', default: true },
  feedbackUrl: { type: 'string', default: '' },
  /**
   * Serialized plan-capability overrides (BL-054): JSON `{ [planId]: capIds[] }`
   * or empty string for pure defaults. Kept as a string because the schema is
   * deliberately scalar-only; the real validation happens the moment it is
   * parsed, in entitlements.applyPlanCapOverrides — bad shape refuses to load
   * and falls back to defaults rather than half-applying.
   */
  rbacPlanCapsJson: { type: 'string', default: '' },
});

/** Defaults as a plain object. */
export function defaultConfig() {
  const out = {};
  for (const [key, spec] of Object.entries(CONFIG_SCHEMA)) out[key] = spec.default;
  return out;
}

/**
 * Validate a candidate config against the schema.
 *
 * Unknown keys are rejected rather than ignored: silently dropping a setting an
 * operator believed they had changed is worse than refusing it.
 *
 * @param {Record<string, unknown>} candidate
 */
export function validateConfig(candidate) {
  const errors = [];
  const value = {};
  const input = candidate && typeof candidate === 'object' ? candidate : {};

  for (const key of Object.keys(input)) {
    if (!(key in CONFIG_SCHEMA)) errors.push(`unknown setting: ${key}`);
  }

  for (const [key, spec] of Object.entries(CONFIG_SCHEMA)) {
    const raw = input[key];
    if (raw === undefined) {
      value[key] = spec.default;
      continue;
    }
    if (spec.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        errors.push(`${key} must be a non-negative number`);
        continue;
      }
      value[key] = n;
    } else if (spec.type === 'boolean') {
      if (typeof raw !== 'boolean') {
        errors.push(`${key} must be true or false`);
        continue;
      }
      value[key] = raw;
    } else {
      if (typeof raw !== 'string') {
        errors.push(`${key} must be a string`);
        continue;
      }
      if (spec.oneOf && !spec.oneOf.includes(raw)) {
        errors.push(`${key} must be one of ${spec.oneOf.join(', ')}`);
        continue;
      }
      value[key] = raw;
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, value };
}

/**
 * Freeze a validated config for the running process.
 *
 * Frozen deliberately: config is read on request paths that decide who may spend
 * money, and a module that can mutate it at runtime is a bug waiting to be written.
 * Changing config means publishing a new version, not assigning a property.
 *
 * @param {Record<string, unknown>} value
 */
export function sealConfig(value) {
  return Object.freeze({ ...defaultConfig(), ...value });
}
