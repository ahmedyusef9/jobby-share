/**
 * Append-only job_events ledger (D-021).
 *
 * Shape of a run, never its content: no URL, company, prompt, CV, report, or
 * activity text. The dispatcher writes these; the sandbox never holds the
 * Appwrite key, so it cannot.
 *
 * Appwrite down → no-op. Completion still depends on artifacts on disk, not
 * on this row existing.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { appwriteConfigured, createDocument } from './appwrite-rest.mjs';
import { JOB_STATES, canTransition, isJobState } from './job-outcomes.mjs';

export const COL_JOB_EVENTS = 'job_events';

const FORBIDDEN = Object.freeze([
  'url',
  'input',
  'prompt',
  'text',
  'activity',
  'report',
  'cv',
  'company',
  'body',
  'stdout',
  'stderr',
  'snapshot',
  'path',
  'filename',
]);

/**
 * Appwrite document ids: [a-zA-Z0-9._-]{1,36}.
 * `je.` + 32 hex chars from a UUID = 35.
 */
export function jobEventId() {
  return `je.${randomUUID().replace(/-/g, '')}`;
}

export function workerId(env = process.env) {
  return String(env.JOBBY_WORKER_ID || env.HOSTNAME || hostname() || 'worker').slice(0, 64);
}

/**
 * Drop anything that would put tenant content in the ledger.
 * @param {Record<string, unknown>} data
 */
export function sanitizeJobEvent(data) {
  const out = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (FORBIDDEN.includes(key)) continue;
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  if (!isJobState(out.state)) {
    throw new Error(`job_events: invalid state ${out.state}`);
  }
  if (out.fromState && !canTransition(String(out.fromState), String(out.state))) {
    throw new Error(`job_events: ${out.fromState} → ${out.state} is not a valid transition`);
  }
  return {
    jobId: String(out.jobId || '').slice(0, 64),
    tenantId: String(out.tenantId || '').slice(0, 64),
    traceId: String(out.traceId || out.jobId || '').slice(0, 64),
    kind: String(out.kind || '').slice(0, 32),
    engine: out.engine ? String(out.engine).slice(0, 64) : undefined,
    workerId: String(out.workerId || workerId()).slice(0, 64),
    state: String(out.state).slice(0, 32),
    fromState: out.fromState ? String(out.fromState).slice(0, 32) : undefined,
    artifactClass: out.artifactClass ? String(out.artifactClass).slice(0, 64) : undefined,
    errorClass: out.errorClass ? String(out.errorClass).slice(0, 128) : undefined,
    durationMs: Number.isFinite(Number(out.durationMs)) ? Math.floor(Number(out.durationMs)) : undefined,
    tokens: Number.isFinite(Number(out.tokens)) ? Math.floor(Number(out.tokens)) : undefined,
    costUsd: out.costUsd != null ? String(out.costUsd).slice(0, 32) : undefined,
    at: out.at || new Date().toISOString(),
  };
}

/**
 * @param {Record<string, unknown>} data
 * @returns {Promise<{ ok: boolean, id?: string, skipped?: string }>}
 */
export async function recordJobEvent(data) {
  const payload = sanitizeJobEvent(data);
  if (!payload.jobId || !payload.tenantId) {
    throw new Error('job_events: jobId and tenantId are required');
  }
  if (!appwriteConfigured()) return { ok: true, skipped: 'appwrite' };
  const id = jobEventId();
  const dataOut = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    dataOut[key] = value;
  }
  await createDocument(COL_JOB_EVENTS, id, dataOut);
  return { ok: true, id };
}

export { JOB_STATES };
