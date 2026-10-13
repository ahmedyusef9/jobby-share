/**
 * Runs, folded from the `job_events` ledger (M7 phase 2).
 *
 * The ledger is append-only and one row per state change, which is the right
 * shape to write and the wrong shape to read: "what happened on this instance"
 * is a question about runs, not about rows. This folds the rows back into one
 * record per job.
 *
 * Two things it will not do:
 *
 *   1. **It never widens the ledger.** `job_events` already refuses to store a
 *      URL, a CV, a report or a company (`scripts/job-events.mjs`). The row this
 *      module hands the browser is built from a closed allowlist, so a later
 *      attribute added to that collection cannot reach an operator screen just
 *      by existing. The privacy rule holds at the write AND at the read.
 *   2. **It never infers success.** A job with no terminal event is reported as
 *      still running, or as stuck once it has outlived the sandbox timeout — not
 *      quietly rounded to failed. D-021: done-ness comes from what was recorded.
 */
import { appwriteConfigured, listDocuments, Q } from './appwrite-rest.mjs';
import { COL_JOB_EVENTS } from './job-events.mjs';
import { JOB_STATES, isTerminalState } from './job-outcomes.mjs';

/**
 * How long a job may sit in a non-terminal state before the operator screen
 * calls it stuck. The sandbox kills a job at 15 minutes
 * (`deploy/worker/sandbox.mjs`), so anything past 20 has outlived every normal
 * ending — including its own timeout — and means the dispatcher never wrote the
 * terminal row.
 */
export const STUCK_AFTER_MS = 20 * 60 * 1000;

/** Exactly the fields an operator row may carry. Nothing else is copied. */
export const RUN_FIELDS = Object.freeze([
  'jobId',
  'tenantId',
  'traceId',
  'kind',
  'engine',
  'workerId',
  'state',
  'startedAt',
  'endedAt',
  'durationMs',
  'tokens',
  'artifactClass',
  'errorClass',
  'states',
  'stuck',
]);

const ms = (iso) => {
  const t = Date.parse(String(iso ?? ''));
  return Number.isFinite(t) ? t : null;
};

/**
 * Fold events into one record per job, newest first.
 *
 * @param {Array<Record<string, unknown>>} events
 * @param {{now?: number, stuckAfterMs?: number}} [opts]
 */
export function foldRuns(events, opts = {}) {
  const now = opts.now ?? Date.now();
  const stuckAfter = opts.stuckAfterMs ?? STUCK_AFTER_MS;
  /** @type {Map<string, any>} */
  const byJob = new Map();

  for (const ev of Array.isArray(events) ? events : []) {
    const jobId = String(ev?.jobId ?? '').trim();
    if (!jobId) continue;
    const at = ms(ev.at) ?? ms(ev.$createdAt);
    const state = String(ev.state ?? '');

    let run = byJob.get(jobId);
    if (!run) {
      run = {
        jobId,
        tenantId: String(ev.tenantId ?? ''),
        traceId: ev.traceId ? String(ev.traceId) : jobId,
        kind: String(ev.kind ?? ''),
        engine: ev.engine ? String(ev.engine) : null,
        workerId: ev.workerId ? String(ev.workerId) : null,
        state: '',
        startedAt: at,
        endedAt: null,
        durationMs: null,
        tokens: null,
        artifactClass: null,
        errorClass: null,
        states: [],
        stuck: false,
        _path: [],
        _seen: new Set(),
        _lastAt: null,
        _terminal: false,
      };
      byJob.set(jobId, run);
    }

    if (at != null && (run.startedAt == null || at < run.startedAt)) run.startedAt = at;
    if (at != null && (run._lastAt == null || at > run._lastAt)) run._lastAt = at;
    /*
     * Keep the timestamp with the state. Appwrite hands these back newest-first,
     * so pushing in arrival order rendered the path backwards — "incomplete,
     * running, queued" — which reads like the job un-happened.
     */
    if (state && !run._seen.has(state)) {
      run._seen.add(state);
      run._path.push({ state, at });
    }
    if (ev.engine && !run.engine) run.engine = String(ev.engine);
    if (ev.workerId && !run.workerId) run.workerId = String(ev.workerId);
    if (ev.kind && !run.kind) run.kind = String(ev.kind);

    /*
     * A terminal row is the answer, and a later non-terminal row does not undo
     * it. Events can arrive out of order — Appwrite orders by `at`, and two
     * events written in the same millisecond have no defined order between them
     * — so "last row wins" would let a `running` row overwrite `succeeded`.
     */
    if (isTerminalState(state)) {
      if (!run._terminal || (at != null && run.endedAt != null && at > run.endedAt)) {
        run.state = state;
        run.endedAt = at;
        run._terminal = true;
        if (Number.isFinite(Number(ev.durationMs))) run.durationMs = Math.floor(Number(ev.durationMs));
        if (ev.artifactClass) run.artifactClass = String(ev.artifactClass);
        if (ev.errorClass) run.errorClass = String(ev.errorClass);
        if (Number.isFinite(Number(ev.tokens))) run.tokens = Math.floor(Number(ev.tokens));
      }
    } else if (!run._terminal && state) {
      run.state = state;
      if (ev.artifactClass) run.artifactClass = String(ev.artifactClass);
    }
  }

  const runs = [];
  for (const run of byJob.values()) {
    if (!run.state) run.state = JOB_STATES.QUEUED;
    // A run that never reported an end is not failed and not finished — it is
    // unaccounted for, and saying so is the point of this screen.
    run.stuck = !run._terminal && run._lastAt != null && now - run._lastAt > stuckAfter;
    if (run.durationMs == null && run.endedAt != null && run.startedAt != null) {
      run.durationMs = Math.max(0, run.endedAt - run.startedAt);
    }
    run.states = run._path
      .slice()
      .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
      .map((p) => p.state);
    const row = {};
    for (const key of RUN_FIELDS) row[key] = run[key] ?? null;
    runs.push(row);
  }

  return runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/**
 * Headline numbers for the operator screen.
 *
 * `incomplete` is broken out rather than folded into failures because it is the
 * state M7 exists to make visible: the agent exited fine and produced nothing.
 *
 * @param {ReturnType<typeof foldRuns>} runs
 */
export function summarize(runs) {
  const rows = Array.isArray(runs) ? runs : [];
  const byState = {};
  let stuck = 0;
  const durations = [];
  for (const r of rows) {
    byState[r.state] = (byState[r.state] ?? 0) + 1;
    if (r.stuck) stuck += 1;
    if (r.state === JOB_STATES.SUCCEEDED && Number.isFinite(r.durationMs)) durations.push(r.durationMs);
  }
  durations.sort((a, b) => a - b);
  return {
    total: rows.length,
    byState,
    stuck,
    succeeded: byState[JOB_STATES.SUCCEEDED] ?? 0,
    incomplete: byState[JOB_STATES.INCOMPLETE] ?? 0,
    failed: byState[JOB_STATES.FAILED] ?? 0,
    medianSuccessMs: durations.length ? durations[Math.floor((durations.length - 1) / 2)] : null,
  };
}

/**
 * Read recent events from Appwrite. Returns `null` — not an empty list — when
 * Appwrite is not configured, so the screen can say "the ledger is unreachable"
 * instead of "nothing has run", which are opposite things.
 *
 * @param {{tenantId?: string, limit?: number}} [opts]
 */
export async function listRunEvents(opts = {}) {
  if (!appwriteConfigured()) return null;
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 200));
  const queries = [Q.orderDesc('at'), Q.limit(limit)];
  if (opts.tenantId) queries.unshift(Q.equal('tenantId', [String(opts.tenantId)]));
  return await listDocuments(COL_JOB_EVENTS, queries);
}

/**
 * The screen's whole payload: runs plus their headline, or an explicit
 * "unavailable" when the ledger cannot be read.
 *
 * @param {{tenantId?: string, limit?: number, now?: number}} [opts]
 */
export async function listRuns(opts = {}) {
  const events = await listRunEvents(opts);
  if (events === null) return { available: false, runs: [], summary: summarize([]) };
  const runs = foldRuns(events, { now: opts.now });
  return { available: true, runs, summary: summarize(runs) };
}
