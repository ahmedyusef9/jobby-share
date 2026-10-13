/**
 * Job outcome states. The dispatcher — not the spawned CLI — decides the
 * terminal state after it has looked at the tenant's files (D-021).
 *
 * queued → running → validated → succeeded
 * queued → running → incomplete | failed | cancelled | timed_out
 */
export const JOB_STATES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  VALIDATED: 'validated',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  INCOMPLETE: 'incomplete',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out',
});

export const TERMINAL_STATES = Object.freeze([
  JOB_STATES.SUCCEEDED,
  JOB_STATES.FAILED,
  JOB_STATES.INCOMPLETE,
  JOB_STATES.CANCELLED,
  JOB_STATES.TIMED_OUT,
]);

const ALLOWED = Object.freeze({
  [JOB_STATES.QUEUED]: [JOB_STATES.RUNNING, JOB_STATES.CANCELLED],
  [JOB_STATES.RUNNING]: [
    JOB_STATES.VALIDATED,
    JOB_STATES.INCOMPLETE,
    JOB_STATES.FAILED,
    JOB_STATES.CANCELLED,
    JOB_STATES.TIMED_OUT,
  ],
  [JOB_STATES.VALIDATED]: [JOB_STATES.SUCCEEDED, JOB_STATES.FAILED],
  [JOB_STATES.SUCCEEDED]: [],
  [JOB_STATES.FAILED]: [],
  [JOB_STATES.INCOMPLETE]: [],
  [JOB_STATES.CANCELLED]: [],
  [JOB_STATES.TIMED_OUT]: [],
});

export function isJobState(value) {
  return Object.values(JOB_STATES).includes(String(value || ''));
}

export function isTerminalState(value) {
  return TERMINAL_STATES.includes(String(value || ''));
}

/**
 * @param {string} from
 * @param {string} to
 */
export function canTransition(from, to) {
  if (!isJobState(from) || !isJobState(to)) return false;
  return (ALLOWED[from] || []).includes(to);
}

/**
 * Classify a dispatcher failure into an error class stored on job_events.
 * Never include URLs, prompts, or file contents.
 *
 * @param {unknown} err
 */
export function errorClassOf(err) {
  const msg = err instanceof Error ? err.message : String(err || '');
  if (/^incomplete:/i.test(msg) || err?.code === 'INCOMPLETE') return 'incomplete';
  if (/timed?\s*out/i.test(msg) || err?.code === 'TIMED_OUT') return 'timeout';
  if (/cancell?ed/i.test(msg) || err?.code === 'CANCELLED') return 'cancelled';
  if (/sandbox/i.test(msg) || err?.code === 'SANDBOX') return 'sandbox_start';
  if (/exit \d+/i.test(msg)) return 'exit_nonzero';
  return 'failed';
}
