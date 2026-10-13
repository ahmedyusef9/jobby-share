import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { installAppwriteMemory } from './appwrite-memory.mjs';

const mem = installAppwriteMemory();
const { COL_JOB_EVENTS, recordJobEvent, sanitizeJobEvent, jobEventId } =
  await import('../scripts/job-events.mjs');
const { JOB_STATES } = await import('../scripts/job-outcomes.mjs');

beforeEach(() => mem.reset());

test('jobEventId fits Appwrite document id rules', () => {
  const id = jobEventId();
  assert.match(id, /^je\.[a-zA-Z0-9]{32}$/);
  assert.ok(id.length <= 36);
});

test('sanitizeJobEvent drops URL, prompt, CV, and activity text', () => {
  const row = sanitizeJobEvent({
    jobId: 'run-1',
    tenantId: 't_abc',
    kind: 'evaluate',
    state: JOB_STATES.RUNNING,
    fromState: JOB_STATES.QUEUED,
    url: 'https://secret.example/jobs/1',
    prompt: 'read cv.md',
    cv: 'Ahmed ...',
    activity: 'tool Write reports/001.md',
    report: '# leaked',
    company: 'Acme',
    engine: 'openrouter',
  });
  assert.equal(row.url, undefined);
  assert.equal(row.prompt, undefined);
  assert.equal(row.cv, undefined);
  assert.equal(row.activity, undefined);
  assert.equal(row.report, undefined);
  assert.equal(row.company, undefined);
  assert.equal(row.state, JOB_STATES.RUNNING);
  assert.equal(row.engine, 'openrouter');
});

test('sanitizeJobEvent refuses running → succeeded', () => {
  assert.throws(
    () =>
      sanitizeJobEvent({
        jobId: 'run-1',
        tenantId: 't_abc',
        kind: 'evaluate',
        state: JOB_STATES.SUCCEEDED,
        fromState: JOB_STATES.RUNNING,
      }),
    /not a valid transition/,
  );
});

test('recordJobEvent writes a metadata-only row', async () => {
  const r = await recordJobEvent({
    jobId: 'run-9',
    tenantId: 't_abc',
    kind: 'evaluate',
    state: JOB_STATES.QUEUED,
    engine: 'opencode',
  });
  assert.equal(r.ok, true);
  const rows = [...mem.collection(COL_JOB_EVENTS).values()];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].jobId, 'run-9');
  assert.equal(rows[0].state, 'queued');
  assert.equal(rows[0].url, undefined);
  assert.equal(rows[0].input, undefined);
});
