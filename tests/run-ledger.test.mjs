// tests/run-ledger.test.mjs — the operator's runs view (M7 phase 2).
//
// Two properties carry the milestone's constraints:
//
//   1. The read side cannot widen what the ledger promised. `job_events` refuses
//      to STORE a URL, CV, report or company; this asserts the fold also refuses
//      to PASS ON anything outside a closed allowlist, so an attribute added to
//      that collection later cannot reach an operator's browser by accident.
//   2. Nothing is inferred. A job with no terminal event is reported as running
//      or stuck — never rounded to failed, never rounded to succeeded — because
//      D-021 makes done-ness a matter of what was recorded.
import { pass, fail } from './helpers.mjs';
import { RUN_FIELDS, STUCK_AFTER_MS, foldRuns, summarize } from '../scripts/run-ledger.mjs';

console.log('\nrun-ledger — runs folded from job_events');

const check = (label, cond) => (cond ? pass(label) : fail(label));

const T0 = Date.parse('2026-08-18T10:00:00.000Z');
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();

const ev = (over) => ({
  jobId: 'job-1',
  tenantId: 't_alpha',
  kind: 'score',
  workerId: 'dispatcher',
  state: 'queued',
  at: at(0),
  ...over,
});

// ── a complete run ──────────────────────────────────────────────────
{
  const runs = foldRuns(
    [
      ev({ state: 'queued', at: at(0) }),
      ev({ state: 'running', fromState: 'queued', at: at(1000), engine: 'opencode' }),
      ev({ state: 'validated', fromState: 'running', at: at(5000), artifactClass: 'ok' }),
      ev({ state: 'succeeded', fromState: 'validated', at: at(5100), durationMs: 5100, artifactClass: 'ok' }),
    ],
    { now: T0 + 10_000 },
  );

  check('four events fold into one run', runs.length === 1);
  const r = runs[0];
  check('the terminal state is the run state', r.state === 'succeeded');
  check('the path taken is kept', r.states.join('>') === 'queued>running>validated>succeeded');
  check('the duration comes from the terminal event', r.durationMs === 5100);
  check('the engine is picked up from whichever event carried it', r.engine === 'opencode');
  check('a finished run is not stuck', r.stuck === false);
}

// ── the path reads forwards, whatever order the rows arrive in ──────
{
  // Appwrite returns newest-first, which is how the live screen first rendered
  // "incomplete > running > queued" — a job that appeared to un-happen.
  const runs = foldRuns(
    [
      ev({ state: 'succeeded', fromState: 'validated', at: at(5100), durationMs: 5100 }),
      ev({ state: 'validated', fromState: 'running', at: at(5000) }),
      ev({ state: 'running', fromState: 'queued', at: at(1000) }),
      ev({ state: 'queued', at: at(0) }),
    ],
    { now: T0 + 10_000 },
  );
  check(
    'newest-first events still produce a forwards path',
    runs[0].states.join('>') === 'queued>running>validated>succeeded',
  );
}

// ── a terminal row is not undone by a late one ──────────────────────
{
  const runs = foldRuns(
    [
      ev({ state: 'succeeded', fromState: 'validated', at: at(5000), durationMs: 5000 }),
      ev({ state: 'running', fromState: 'queued', at: at(1000) }),
    ],
    { now: T0 + 10_000 },
  );
  check(
    'an out-of-order running row cannot un-finish a succeeded run',
    runs[0].state === 'succeeded' && runs[0].durationMs === 5000,
  );
}

// ── nothing is inferred ─────────────────────────────────────────────
{
  const fresh = foldRuns([ev({ state: 'running', fromState: 'queued', at: at(0) })], { now: T0 + 60_000 });
  check('a job still running is reported as running', fresh[0].state === 'running');
  check('and is not marked stuck a minute in', fresh[0].stuck === false);
  check('and is never guessed to have failed', fresh[0].errorClass === null);

  const old = foldRuns([ev({ state: 'running', fromState: 'queued', at: at(0) })], {
    now: T0 + STUCK_AFTER_MS + 1000,
  });
  check('past the sandbox timeout it is stuck, not failed', old[0].stuck === true && old[0].state === 'running');

  const incomplete = foldRuns(
    [ev({ state: 'incomplete', fromState: 'running', at: at(2000), errorClass: 'incomplete', artifactClass: 'missing_report' })],
    { now: T0 + 10_000 },
  );
  check(
    'incomplete keeps its own identity rather than becoming a failure',
    incomplete[0].state === 'incomplete' && incomplete[0].artifactClass === 'missing_report',
  );
}

// ── the read side cannot widen the ledger ───────────────────────────
{
  const runs = foldRuns([
    ev({
      state: 'succeeded',
      fromState: 'validated',
      at: at(1000),
      // Nothing writes these today — job-events.mjs strips them. This asserts the
      // READ side would also refuse them if a later attribute slipped through.
      url: 'https://boards.test/secret',
      company: 'Acme',
      report: '# private',
      cv: 'Ahmad ...',
      prompt: 'evaluate this',
    }),
  ]);
  const keys = Object.keys(runs[0]);
  check('a run row carries only the allowlisted fields', keys.every((k) => RUN_FIELDS.includes(k)));
  check('every allowlisted field is present, so the shape is stable', RUN_FIELDS.every((k) => k in runs[0]));
  const serialized = JSON.stringify(runs[0]);
  check(
    'no tenant content survives the fold',
    !/boards\.test|Acme|private|Ahmad|evaluate this/.test(serialized),
  );
}

// ── several jobs, several tenants ───────────────────────────────────
{
  const runs = foldRuns(
    [
      ev({ jobId: 'a', state: 'succeeded', fromState: 'validated', at: at(1000), durationMs: 1000 }),
      ev({ jobId: 'b', tenantId: 't_beta', state: 'incomplete', fromState: 'running', at: at(3000) }),
      ev({ jobId: 'c', state: 'succeeded', fromState: 'validated', at: at(2000), durationMs: 3000 }),
    ],
    { now: T0 + 10_000 },
  );
  check('one row per job', runs.length === 3);
  check('newest first', runs.map((r) => r.jobId).join('') === 'bca');
  check('each run keeps its own tenant', runs.find((r) => r.jobId === 'b').tenantId === 't_beta');

  const s = summarize(runs);
  check('the headline counts terminal states', s.succeeded === 2 && s.incomplete === 1);
  check('incomplete is not counted as failed', s.failed === 0);
  check('median duration is over successes only', s.medianSuccessMs === 1000);
}

// ── junk in the ledger does not break the screen ────────────────────
{
  const runs = foldRuns([null, {}, { jobId: '' }, ev({ jobId: 'ok', state: 'queued' })]);
  check('rows with no job id are skipped rather than fatal', runs.length === 1 && runs[0].jobId === 'ok');
  check('an empty ledger summarises to zero, not to a crash', summarize(foldRuns([])).total === 0);
}
