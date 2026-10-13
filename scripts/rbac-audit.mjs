/**
 * RBAC mutation audit (BL-054). One JSONL file, one writer, no reads on the hot
 * path — the console tails it for display only.
 *
 * Every operator action that changes WHO may do WHAT lands here:
 * role grant/revoke, plan change, suspend/reactivate, permission-matrix edit.
 * The row records before → after so the trail answers "what changed and who
 * changed it", not just "something happened".
 */
import fs from 'node:fs';
import path from 'node:path';
import { platformRoot } from './resolve-root.mjs';

const AUDIT_FILE = '.career-ops-web/audit.jsonl';

/**
 * Append one audit row. Never throws into the caller's flow: a failed audit
 * write is logged, not fatal — but it does print loudly.
 *
 * @param {{
 *   action: string,
 *   actor?: string,
 *   accountId?: string | null,
 *   tenantId?: string | null,
 *   field?: string,
 *   before?: unknown,
 *   after?: unknown,
 * }} event
 */
export function appendRbacAudit(event) {
  const row = {
    ts: new Date().toISOString(),
    action: event.action,
    actor: event.actor ?? 'operator',
    accountId: event.accountId ?? null,
    tenantId: event.tenantId ?? null,
    field: event.field ?? null,
    before: event.before ?? null,
    after: event.after ?? null,
  };
  try {
    const file = path.resolve(platformRoot(), AUDIT_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  } catch (err) {
    console.error('[rbac-audit] write failed:', err?.message ?? err);
  }
}

/**
 * Newest-last tail of the audit file, for the console view.
 * @param {number} [limit]
 */
export function readAuditTail(limit = 50) {
  const file = path.resolve(platformRoot(), AUDIT_FILE);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { ts: null, action: 'unparseable', raw: l.slice(0, 200) };
    }
  });
}
