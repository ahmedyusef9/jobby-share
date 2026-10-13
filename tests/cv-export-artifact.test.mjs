/**
 * QA round 1 regression (#51): cv-export artifact verification must accept any
 * fresh PDF — its `input` is maxPages, not a report number to grep filenames for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { verifyJobArtifacts, ARTIFACT } = await import('../scripts/job-artifacts.mjs');

function tmpTenant() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cvexport-'));
  fs.mkdirSync(path.join(root, 'output'), { recursive: true });
  // A realistic date-named export containing NO digit "1".
  const pdf = path.join(root, 'output', 'cv-2026-08-23.pdf');
  fs.writeFileSync(pdf, Buffer.alloc(2048, '%PDF-'));
  return root;
}

test('cv-export accepts a date-named PDF even with input "1"', () => {
  const root = tmpTenant();
  const check = verifyJobArtifacts({ kind: 'cv-export', tenantRoot: root, input: '1', sinceMs: Date.now() - 60_000 });
  assert.equal(check.ok, true);
  assert.notEqual(check.artifactClass, ARTIFACT.MISSING_PDF);
});

test('plain pdf jobs keep the report-number needle behavior', () => {
  const root = tmpTenant();
  const check = verifyJobArtifacts({ kind: 'pdf', tenantRoot: root, input: '64', sinceMs: Date.now() - 60_000 });
  assert.equal(check.ok, false);
  assert.equal(check.artifactClass, ARTIFACT.MISSING_PDF);
});
