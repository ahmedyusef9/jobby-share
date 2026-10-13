import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ARTIFACT, verifyJobArtifacts } from '../scripts/job-artifacts.mjs';
import { JOB_STATES, canTransition, errorClassOf } from '../scripts/job-outcomes.mjs';

const REPORT = `# Acme — Engineer

**Score:** 4.2/5
**URL:** https://example.test/jobs/1
**Legitimacy:** likely-real

## Machine Summary

\`\`\`yaml
company: Acme
role: Engineer
score: 4.2
\`\`\`

${'padding '.repeat(40)}
`;

function tenantFixture() {
  const root = mkdtempSync(join(tmpdir(), 'jobby-art-'));
  mkdirSync(join(root, 'reports'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'output'), { recursive: true });
  return root;
}

test('queued → running → validated → succeeded is allowed', () => {
  assert.equal(canTransition(JOB_STATES.QUEUED, JOB_STATES.RUNNING), true);
  assert.equal(canTransition(JOB_STATES.RUNNING, JOB_STATES.VALIDATED), true);
  assert.equal(canTransition(JOB_STATES.VALIDATED, JOB_STATES.SUCCEEDED), true);
  assert.equal(canTransition(JOB_STATES.RUNNING, JOB_STATES.SUCCEEDED), false);
  assert.equal(canTransition(JOB_STATES.RUNNING, JOB_STATES.INCOMPLETE), true);
});

test('a VERDICT string is not a score artifact', () => {
  const root = tenantFixture();
  try {
    const r = verifyJobArtifacts({ kind: 'evaluate', tenantRoot: root });
    assert.equal(r.ok, false);
    assert.equal(r.artifactClass, ARTIFACT.MISSING_REPORT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('score requires report + score line + tracker row', () => {
  const root = tenantFixture();
  try {
    writeFileSync(join(root, 'reports', '001-acme-2026-08-18.md'), REPORT);
    let r = verifyJobArtifacts({ kind: 'evaluate', tenantRoot: root });
    assert.equal(r.artifactClass, ARTIFACT.MISSING_TRACKER);

    writeFileSync(
      join(root, 'data', 'applications.md'),
      `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-08-18 | Acme | Engineer | 4.2/5 | Evaluated | ❌ | [1](reports/001-acme-2026-08-18.md) | |
`,
    );
    r = verifyJobArtifacts({ kind: 'evaluate', tenantRoot: root });
    assert.equal(r.ok, true);
    assert.equal(r.artifactClass, ARTIFACT.OK);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pdf requires a non-empty output file', () => {
  const root = tenantFixture();
  try {
    writeFileSync(join(root, 'output', 'cv-acme.pdf'), 'tiny');
    let r = verifyJobArtifacts({ kind: 'pdf', tenantRoot: root, input: '1' });
    assert.equal(r.artifactClass, ARTIFACT.MISSING_PDF);

    writeFileSync(join(root, 'output', 'cv-1-acme.pdf'), Buffer.alloc(200, 37));
    r = verifyJobArtifacts({ kind: 'pdf', tenantRoot: root, input: '1' });
    assert.equal(r.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('research requires a saved VERDICT file', () => {
  const root = tenantFixture();
  try {
    let r = verifyJobArtifacts({ kind: 'research', tenantRoot: root, runId: 'run-1' });
    assert.equal(r.artifactClass, ARTIFACT.MISSING_VERDICT);

    mkdirSync(join(root, '.career-ops-web', 'research'), { recursive: true });
    writeFileSync(
      join(root, '.career-ops-web', 'research', 'run-1.md'),
      'Short note.\n\nVERDICT: 4/5 — strong proof points\n',
    );
    r = verifyJobArtifacts({ kind: 'research', tenantRoot: root, runId: 'run-1' });
    assert.equal(r.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scan skips file artifacts', () => {
  const root = tenantFixture();
  try {
    const r = verifyJobArtifacts({ kind: 'scan', tenantRoot: root });
    assert.equal(r.ok, true);
    assert.equal(r.artifactClass, ARTIFACT.SKIPPED);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('errorClassOf maps incomplete messages', () => {
  const err = new Error('incomplete: missing_report');
  err.code = 'INCOMPLETE';
  assert.equal(errorClassOf(err), 'incomplete');
  assert.equal(errorClassOf(new Error('sandbox timed out')), 'timeout');
});
