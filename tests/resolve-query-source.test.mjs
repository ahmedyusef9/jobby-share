/**
 * resolve-query-source unit coverage (M2). Verifies per-profile ephemeral portals
 * files, the portals-fallback when no profiles exist, and the fail-closed
 * error when every profile is disabled. Also checks that the real portals.yml's
 * tracked_companies survive into each ephemeral file (merge-copy, not replace).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as yaml from 'js-yaml';

import { createProfile, patchProfile } from '../scripts/search-profiles.mjs';
import { resolveQuerySource } from '../scripts/resolve-query-source.mjs';

function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'jobby-rqs-'));
}

function writePortals(root, doc) {
  writeFileSync(join(root, 'portals.yml'), yaml.dump(doc), 'utf8');
}

test('no profiles file → portals-fallback, one run pointing at the real portals.yml', () => {
  const root = freshRoot();
  try {
    writePortals(root, { tracked_companies: [{ name: 'Acme' }] });
    const r = resolveQuerySource(root);
    assert.equal(r.mode, 'portals-fallback');
    assert.equal(r.runs.length, 1);
    assert.equal(r.runs[0].profileId, '');
    assert.equal(r.runs[0].portalsPath, join(root, 'portals.yml'));
    r.cleanup();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enabled profiles → one ephemeral run each, sorted by id', () => {
  const root = freshRoot();
  try {
    writePortals(root, { tracked_companies: [{ name: 'Acme' }], title_filter: { positive: ['old'] } });
    const a = createProfile(root, { title: 'Israel', queries: ['software engineer'], locations: ['Israel'] });
    const b = createProfile(root, { title: 'US', queries: ['software engineer'], locations: ['United States'] });
    const r = resolveQuerySource(root);
    assert.equal(r.mode, 'profiles');
    assert.equal(r.runs.length, 2);
    // sorted by id ascending
    assert.ok(r.runs[0].profileId < r.runs[1].profileId || r.runs[0].profileId === a.id);
    // each run points at a temp file, not the real portals.yml
    for (const run of r.runs) {
      assert.notEqual(run.portalsPath, join(root, 'portals.yml'));
      assert.ok(existsSync(run.portalsPath));
    }
    // the ephemeral file overrides filters but keeps tracked_companies (merge-copy)
    const first = /** @type {any} */ (yaml.load(readFileSync(r.runs[0].portalsPath, 'utf8')));
    assert.deepEqual(first.tracked_companies, [{ name: 'Acme' }], 'tracked_companies preserved');
    assert.ok(Array.isArray(first.title_filter.positive));
    assert.ok(first.title_filter.positive.includes('software engineer'));
    r.cleanup();
    // cleanup removed the temp files
    for (const run of r.runs) assert.ok(!existsSync(run.portalsPath));
    void b;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('all profiles disabled → fail closed (never scan "everything")', () => {
  const root = freshRoot();
  try {
    writePortals(root, { tracked_companies: [] });
    const p = createProfile(root, { title: 'P', queries: ['x'] });
    patchProfile(root, p.id, { enabled: false });
    assert.throws(() => resolveQuerySource(root), /all search profiles are disabled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ephemeral filters are per-profile (Israel vs US locations differ)', () => {
  const root = freshRoot();
  try {
    writePortals(root, {});
    const il = createProfile(root, { title: 'Israel', queries: ['backend'], locations: ['Israel'] });
    const us = createProfile(root, { title: 'US', queries: ['backend'], locations: ['United States', 'Remote'] });
    const r = resolveQuerySource(root);
    // runs are sorted by id ascending; map back to titles via the store.
    const byTitle = new Map();
    for (const run of r.runs) {
      const doc = /** @type {any} */ (yaml.load(readFileSync(run.portalsPath, 'utf8')));
      byTitle.set(run.profileId, doc.location_filter.allow);
    }
    assert.deepEqual(byTitle.get(il.id), ['Israel']);
    assert.deepEqual(byTitle.get(us.id), ['United States', 'Remote']);
    r.cleanup();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
