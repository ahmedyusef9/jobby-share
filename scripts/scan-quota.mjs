/**
 * Scan concurrency + daily quota (JOBBY-BL-050).
 *
 * Scanning spends no model tokens, but it spends the host: CPU, outbound HTTP,
 * and the ATS datasets on this machine. Ten testers sweeping Greenhouse in
 * parallel is a real bill. This is the last uncapped thing a member could spend
 * of the operator's.
 *
 * Two limits, from the PRD alpha table:
 *   - one scan running per account (a queue is fine; two at once is not)
 *   - five searches per UTC day
 *
 * Both are written through the existing `usage_events` collection. Daily slots
 * are unique document ids (`sd.{tenant}.{day}.{n}`), so two processes racing
 * for the last scan produce one winner — the same mutex as capacity slots.
 * The run lock is a second unique id (`sl.{tenant}`), deleted when the scan
 * ends, stolen if older than the stale window so a crashed worker cannot
 * jam an account forever.
 *
 * The operator is uncapped — it is their machine. Events are still written
 * so the admin view is not a lie. Members fail closed if Appwrite is down:
 * we cannot tell how much they have used, so we do not let them start.
 */
import { createHash } from 'node:crypto';
import { CAP, can, denialReason, isOperator, planLimits } from './entitlements.mjs';
import {
  Q,
  appwriteConfigured,
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  updateDocument,
} from './appwrite-rest.mjs';

export const COL_USAGE = 'usage_events';
export const KIND_SEARCH = 'search';

export const SCAN_CONCURRENT = 'SCAN_CONCURRENT';
export const SCAN_DAILY = 'SCAN_DAILY';
export const SCAN_UNAVAILABLE = 'SCAN_UNAVAILABLE';
export const SCAN_DENIED = 'SCAN_DENIED';

const DEFAULT_DAILY = 5;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_STALE_MS = 20 * 60 * 1000;

/** @param {unknown} err */
export function isScanQuotaError(err) {
  return err instanceof ScanQuotaError || (err instanceof Error && err.name === 'ScanQuotaError');
}

export class ScanQuotaError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ status?: number, used?: number, limit?: number }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ScanQuotaError';
    this.code = code;
    this.status = extra.status ?? 429;
    this.used = extra.used;
    this.limit = extra.limit;
  }
}

/**
 * Daily scan cap. `JOBBY_SCAN_DAILY_LIMIT` overrides for tests. Otherwise the
 * account's plan table (D-031). Operator callers never hit this.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ role?: string, plan?: string } | null} [account]
 */
export function scanDailyLimit(env = process.env, account = null) {
  const n = Number(env.JOBBY_SCAN_DAILY_LIMIT);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  const limits = planLimits(account);
  return limits?.scans ?? DEFAULT_DAILY;
}

/** @param {NodeJS.ProcessEnv} [env] */
export function scanConcurrency(env = process.env) {
  const n = Number(env.JOBBY_SCAN_CONCURRENCY);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CONCURRENCY;
}

/** @param {NodeJS.ProcessEnv} [env] */
export function scanLockStaleMs(env = process.env) {
  const n = Number(env.JOBBY_SCAN_LOCK_STALE_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_MS;
}

/**
 * Short stable key that fits inside Appwrite's 36-char document id.
 * @param {string} tenantId
 */
export function tenantKey(tenantId) {
  return createHash('sha256').update(String(tenantId)).digest('hex').slice(0, 10);
}

/** UTC calendar day as YYYYMMDD — the quota resets at midnight UTC. */
export function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}

export function utcDayStartIso(now = new Date()) {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000+00:00`;
}

/**
 * Daily slot document id. Appwrite allows a-z A-Z 0-9 . - _ and max 36 chars.
 * @param {string} tenantId
 * @param {string} day YYYYMMDD
 * @param {number} n
 */
export function dailySlotId(tenantId, day, n) {
  return `sd.${tenantKey(tenantId)}.${day}.${n}`;
}

/** @param {string} tenantId */
export function runLockId(tenantId) {
  return `sl.${tenantKey(tenantId)}`;
}

/**
 * Pure decision, no IO. The live path uses unique-id creates rather than this
 * (count-then-write would race); this is the rule the error copy must match.
 *
 * @param {{ operator?: boolean, used: number, running: number, dailyLimit?: number, concurrency?: number }} input
 */
export function decideScan(input) {
  const dailyLimit = input.dailyLimit ?? DEFAULT_DAILY;
  const concurrency = input.concurrency ?? DEFAULT_CONCURRENCY;
  if (input.operator) return { ok: true };
  if (input.running >= concurrency) {
    return {
      ok: false,
      code: SCAN_CONCURRENT,
      message: 'A scan is already running on this account. Wait for it to finish, then try again.',
    };
  }
  if (input.used >= dailyLimit) {
    return {
      ok: false,
      code: SCAN_DAILY,
      used: input.used,
      limit: dailyLimit,
      message: `You've used today's ${dailyLimit} scans. More run after midnight UTC.`,
    };
  }
  return { ok: true, used: input.used, limit: dailyLimit };
}

function nowIso(now = new Date()) {
  return now.toISOString();
}

function usagePayload(tenantId, outcome, extra = {}) {
  return {
    tenantId,
    kind: KIND_SEARCH,
    outcome,
    at: extra.at ?? nowIso(),
    ...(extra.durationMs != null ? { durationMs: extra.durationMs } : {}),
    ...(extra.engine ? { engine: extra.engine } : {}),
  };
}

/**
 * How many search events this tenant has today (UTC), excluding the run lock.
 * @param {string} tenantId
 */
export async function countToday(tenantId, now = new Date()) {
  const rows = await listDocuments(COL_USAGE, [
    Q.equal('tenantId', [tenantId]),
    Q.equal('kind', [KIND_SEARCH]),
    Q.greaterThanEqual('at', [utcDayStartIso(now)]),
    Q.limit(100),
  ]);
  return rows.filter((r) => r.outcome !== 'running').length;
}

/**
 * Take the next daily slot. Unique document ids make this a mutex: two racers
 * for scan #5 produce one winner.
 *
 * @param {{ role?: string, plan?: string, status?: string } | null} account
 * @param {string} tenantId
 */
export async function reserveScan(account, tenantId) {
  if (!can(account, CAP.SEARCH_JOBS)) {
    throw new ScanQuotaError(SCAN_DENIED, denialReason(account, CAP.SEARCH_JOBS), { status: 403 });
  }

  if (isOperator(account)) {
    if (!appwriteConfigured()) return { eventId: null, used: 0, limit: null, operator: true };
    const eventId = `so.${tenantKey(tenantId)}.${Date.now().toString(36)}`;
    await createDocument(COL_USAGE, eventId, usagePayload(tenantId, 'queued'));
    return { eventId, used: 0, limit: null, operator: true };
  }

  if (!appwriteConfigured()) {
    throw new ScanQuotaError(
      SCAN_UNAVAILABLE,
      'Scanning is temporarily unavailable — jobby cannot tell how many scans you have used today.',
      { status: 503 },
    );
  }

  const limit = scanDailyLimit(process.env, account);
  const day = utcDay();
  for (let n = 0; n < limit; n += 1) {
    const eventId = dailySlotId(tenantId, day, n);
    try {
      await createDocument(COL_USAGE, eventId, usagePayload(tenantId, 'queued'));
      return { eventId, used: n + 1, limit, operator: false };
    } catch (err) {
      if (err.status !== 409) throw err;
    }
  }
  throw new ScanQuotaError(
    SCAN_DAILY,
    `You've used today's ${limit} scans. More run after midnight UTC.`,
    { used: limit, limit },
  );
}

async function stealStaleLock(tenantId) {
  const id = runLockId(tenantId);
  const existing = await getDocument(COL_USAGE, id);
  if (!existing) return false;
  const at = Date.parse(existing.at || '');
  if (!Number.isFinite(at) || Date.now() - at < scanLockStaleMs()) return false;
  await deleteDocument(COL_USAGE, id);
  return true;
}

/**
 * One running scan per account. `wait: true` is for the worker (a queue is fine);
 * the interactive explore path must not hang — it 429s instead.
 *
 * @param {string} tenantId
 * @param {{ wait?: boolean, waitMs?: number }} [opts]
 */
export async function acquireRunLock(tenantId, opts = {}) {
  if (!appwriteConfigured()) return;
  const id = runLockId(tenantId);
  const deadline = opts.wait ? Date.now() + (opts.waitMs ?? 8 * 60 * 1000) : 0;

  for (;;) {
    try {
      await createDocument(COL_USAGE, id, usagePayload(tenantId, 'running'));
      return;
    } catch (err) {
      if (err.status !== 409) throw err;
      const stole = await stealStaleLock(tenantId);
      if (stole) continue;
      if (!opts.wait || Date.now() >= deadline) {
        throw new ScanQuotaError(
          SCAN_CONCURRENT,
          'A scan is already running on this account. Wait for it to finish, then try again.',
        );
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/** @param {string} tenantId */
export async function releaseRunLock(tenantId) {
  if (!appwriteConfigured()) return;
  await deleteDocument(COL_USAGE, runLockId(tenantId));
}

/**
 * Lock then reserve. Used by the in-process explore path, which starts work
 * immediately. Queue enqueue calls `reserveScan` only — the worker takes the
 * lock when it actually runs, so a second scan can sit in the queue.
 *
 * @param {{ role?: string, plan?: string, status?: string } | null} account
 * @param {string} tenantId
 * @param {{ waitForLock?: boolean }} [opts]
 */
export async function beginScan(account, tenantId, opts = {}) {
  await acquireRunLock(tenantId, { wait: Boolean(opts.waitForLock) });
  try {
    return await reserveScan(account, tenantId);
  } catch (err) {
    await releaseRunLock(tenantId);
    throw err;
  }
}

/**
 * Record the outcome on the reserved event and drop the run lock.
 * Safe to call with a null eventId (operator + Appwrite down).
 *
 * @param {string} tenantId
 * @param {string | null | undefined} eventId
 * @param {{ outcome: string, durationMs?: number }} result
 * @param {{ releaseLock?: boolean }} [opts] pass false when this event never held the run lock (queue reserve then enqueue failed)
 */
export async function endScan(tenantId, eventId, result, opts = {}) {
  try {
    if (eventId && appwriteConfigured()) {
      await updateDocument(COL_USAGE, eventId, {
        outcome: result.outcome,
        ...(result.durationMs != null ? { durationMs: result.durationMs } : {}),
      });
    }
  } finally {
    if (opts.releaseLock !== false) await releaseRunLock(tenantId);
  }
}

/**
 * Usage rows for one tenant, newest first. Shape of usage only — never CV
 * text, company names or report bodies. The operator screen reads this.
 *
 * @param {string} tenantId
 * @param {{ limit?: number }} [opts]
 */
export async function usageForTenant(tenantId, opts = {}) {
  if (!appwriteConfigured() || !tenantId) return [];
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
  const rows = await listDocuments(COL_USAGE, [
    Q.equal('tenantId', [tenantId]),
    Q.orderDesc('at'),
    Q.limit(limit),
  ]);
  return rows
    .filter((r) => r.outcome !== 'running' && !String(r.$id || '').startsWith('sl.'))
    .map((r) => ({
      id: r.$id,
      kind: r.kind ?? null,
      engine: r.engine ?? null,
      outcome: r.outcome ?? null,
      durationMs: r.durationMs ?? null,
      tokens: r.tokens ?? null,
      at: r.at ?? null,
    }));
}
