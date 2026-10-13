/**
 * Daily MCP call cap (D-031). Same mutex pattern as scan-quota: unique document
 * ids on usage_events. Counted on tools/call only — initialize and tools/list
 * stay free so a client can connect.
 */
import { createHash } from 'node:crypto';
import { isOperator, planLimits } from './entitlements.mjs';
import {
  Q,
  appwriteConfigured,
  createDocument,
  listDocuments,
  updateDocument,
} from './appwrite-rest.mjs';

export const COL_USAGE = 'usage_events';
export const KIND_MCP = 'mcp';
export const MCP_DAILY = 'MCP_DAILY';
export const MCP_UNAVAILABLE = 'MCP_UNAVAILABLE';

const DEFAULT_DAILY = 40;

export class McpQuotaError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ status?: number, used?: number, limit?: number }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'McpQuotaError';
    this.code = code;
    this.status = extra.status ?? 429;
    this.used = extra.used;
    this.limit = extra.limit;
  }
}

/** @param {unknown} err */
export function isMcpQuotaError(err) {
  return err instanceof McpQuotaError || (err instanceof Error && err.name === 'McpQuotaError');
}

function tenantKey(tenantId) {
  return createHash('sha256').update(String(tenantId)).digest('hex').slice(0, 10);
}

function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}

/** @param {string} tenantId @param {string} day @param {number} n */
export function mcpSlotId(tenantId, day, n) {
  return `md.${tenantKey(tenantId)}.${day}.${n}`;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ role?: string, plan?: string } | null} [account]
 */
export function mcpDailyLimit(env = process.env, account = null) {
  const n = Number(env.JOBBY_MCP_DAILY_LIMIT);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  const limits = planLimits(account);
  return limits?.mcp ?? DEFAULT_DAILY;
}

/**
 * Take one MCP tool-call slot for today. Operator is recorded but not capped.
 *
 * @param {{ role?: string, plan?: string, status?: string } | null} account
 * @param {string} tenantId
 */
export async function consumeMcpCall(account, tenantId) {
  if (isOperator(account)) {
    if (tenantId === 'default' || !appwriteConfigured()) return { used: 0, limit: null, operator: true };
    const eventId = `mo.${tenantKey(tenantId)}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await createDocument(COL_USAGE, eventId, {
      tenantId,
      kind: KIND_MCP,
      outcome: 'ok',
      at: new Date().toISOString(),
    });
    return { eventId, used: 0, limit: null, operator: true };
  }

  if (!appwriteConfigured()) {
    throw new McpQuotaError(
      MCP_UNAVAILABLE,
      'MCP is temporarily unavailable — jobby cannot tell how many calls you have used today.',
      { status: 503 },
    );
  }

  const limit = mcpDailyLimit(process.env, account);
  const day = utcDay();
  const prefix = `md.${tenantKey(tenantId)}.${day}.`;
  // Reading the occupied slots once keeps allocation O(1) in the tenant's
  // current daily usage. Starting every request at slot zero makes the nth
  // call perform n remote POSTs (n-1 deliberate 409s), which becomes
  // quadratic over a day. Unique document ids still arbitrate concurrent
  // callers: a peer that wins the same free slot produces one 409 and this
  // loop advances to the next free id.
  const dayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00.000+00:00`;
  const occupied = new Set(
    (
      await listDocuments(COL_USAGE, [
        Q.equal('tenantId', [tenantId]),
        Q.equal('kind', [KIND_MCP]),
        Q.greaterThanEqual('at', [dayStart]),
        Q.limit(limit),
      ]).catch(() => [])
    )
      .map((row) => String(row.$id || ''))
      .filter((id) => id.startsWith(prefix)),
  );
  for (let n = 0; n < limit; n += 1) {
    const eventId = mcpSlotId(tenantId, day, n);
    if (occupied.has(eventId)) continue;
    try {
      await createDocument(COL_USAGE, eventId, {
        tenantId,
        kind: KIND_MCP,
        outcome: 'ok',
        at: new Date().toISOString(),
      });
      return { eventId, used: occupied.size + 1, limit, operator: false };
    } catch (err) {
      if (err.status !== 409) throw err;
      occupied.add(eventId);
    }
  }
  throw new McpQuotaError(
    MCP_DAILY,
    `You've used today's ${limit} MCP calls on this plan. More run after midnight UTC, or ask the operator to raise your plan.`,
    { used: limit, limit },
  );
}

/**
 * Mark a reserved call failed so it still consumed the slot (fair) but is
 * visible as a failure in admin usage.
 *
 * @param {string | null | undefined} eventId
 * @param {string} [errorClass]
 */
export async function markMcpCallFailed(eventId, errorClass) {
  if (!eventId || !appwriteConfigured()) return;
  try {
    await updateDocument(COL_USAGE, eventId, {
      outcome: 'failed',
      ...(errorClass ? { errorClass: String(errorClass).slice(0, 128) } : {}),
    });
  } catch {
    /* ignore */
  }
}

/**
 * Remaining calls today. Best-effort read for whoami; not a mutex.
 *
 * @param {string} tenantId
 * @param {{ role?: string, plan?: string } | null} account
 */
export async function mcpUsageToday(tenantId, account) {
  const limit = isOperator(account) ? null : mcpDailyLimit(process.env, account);
  if (tenantId === 'default' || !appwriteConfigured() || !tenantId) return { used: 0, limit };
  const dayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00.000+00:00`;
  const rows = await listDocuments(COL_USAGE, [
    Q.equal('tenantId', [tenantId]),
    Q.equal('kind', [KIND_MCP]),
    Q.greaterThanEqual('at', [dayStart]),
    Q.limit(100),
  ]).catch(() => []);
  const used = rows.filter((r) => String(r.$id || '').startsWith('md.') || r.kind === KIND_MCP).length;
  return { used, limit };
}
