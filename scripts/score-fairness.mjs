/**
 * Per-tenant Score admission (D-023).
 *
 * One shared BullMQ queue, one dispatcher, N sandboxes. "Score all" must not
 * dump this tenant's inbox onto FIFO ahead of everyone else. Until round-robin
 * dispatch exists: at most one running Score and one waiting Score per tenant.
 * Scan caps stay in scan-quota.mjs (D-012). PDF/research are not this gate.
 */

export const SCORE_KIND = 'evaluate';
export const SCORE_MAX_ACTIVE = 1;
export const SCORE_MAX_WAITING = 1;
/** Browser may POST this many evaluate jobs; the rest stay in the local list. */
export const SCORE_INFLIGHT_CAP = SCORE_MAX_ACTIVE + SCORE_MAX_WAITING;
export const SCORE_FAIRNESS = 'SCORE_FAIRNESS';
/** Redis lock while a tenant Score sandbox is running. Covers JOBBY_RUN_TIMEOUT_MS. */
export const SCORE_RUN_LOCK_TTL_SEC = 20 * 60;
/** How long the dispatcher parks a Score that lost the per-tenant run lock. */
export const SCORE_RUN_RETRY_MS = 8_000;
const RELEASE_SCORE_RUN_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

export class ScoreFairnessError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ status?: number, active?: number, waiting?: number }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ScoreFairnessError';
    this.code = code;
    this.status = extra.status ?? 429;
    this.active = extra.active;
    this.waiting = extra.waiting;
  }
}

/** @param {unknown} err */
export function isScoreFairnessError(err) {
  return err instanceof ScoreFairnessError || (err instanceof Error && err.name === 'ScoreFairnessError');
}

/**
 * How many sandboxes this host will run at once. Default 1. Do not pretend the
 * browser's old 3-wide pump is the machine.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function workerConcurrency(env = process.env) {
  const n = Number(env.JOBBY_WORKER_CONCURRENCY);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

/**
 * Pure rule. `active` / `waiting` are this tenant's evaluate jobs already in
 * Redis (not the browser local list).
 *
 * @param {{ active: number, waiting: number }} counts
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export function decideScoreAdmission(counts) {
  const active = Math.max(0, Number(counts.active) || 0);
  const waiting = Math.max(0, Number(counts.waiting) || 0);
  if (waiting >= SCORE_MAX_WAITING) {
    return {
      ok: false,
      code: SCORE_FAIRNESS,
      message:
        'This account already has a Score waiting. It starts when the dispatcher is free — Score all stays in your list until then.',
    };
  }
  if (active > SCORE_MAX_ACTIVE) {
    return {
      ok: false,
      code: SCORE_FAIRNESS,
      message: 'This account already has a Score running. Wait for it to finish before queuing another.',
    };
  }
  return { ok: true };
}

/** @param {string} tenantId */
export function scoreRunLockKey(tenantId) {
  return `jobby:score-run:${tenantId}`;
}

/**
 * At most one running Score per tenant, even when `JOBBY_WORKER_CONCURRENCY` > 1.
 * Enqueue admission alone is not enough: the waiter would start beside the
 * already-running job as soon as a second sandbox slot opened.
 *
 * @param {{ set: Function }} redis
 * @param {string} tenantId
 * @param {string} jobId
 * @param {number} [ttlSec]
 */
export async function tryAcquireScoreRunLock(redis, tenantId, jobId, ttlSec = SCORE_RUN_LOCK_TTL_SEC) {
  const got = await redis.set(scoreRunLockKey(tenantId), String(jobId), 'EX', ttlSec, 'NX');
  return got === 'OK' || got === true;
}

/**
 * @param {{ eval: Function }} redis
 * @param {string} tenantId
 * @param {string} jobId
 */
export async function releaseScoreRunLock(redis, tenantId, jobId) {
  await redis.eval(RELEASE_SCORE_RUN_LUA, 1, scoreRunLockKey(tenantId), String(jobId));
}
