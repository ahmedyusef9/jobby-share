/**
 * Search-profiles store unit coverage (M2). Validates the canonical store shared
 * by the web app and the CLI: CRUD, validation, idempotent PUT, title-conflict,
 * and two-tenant isolation via separate tenant roots (FR-002/FR-006).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createProfile,
  listProfiles,
  getProfile,
  upsertProfile,
  patchProfile,
  deleteProfile,
  enabledProfiles,
  validateProfile,
  PROFILE_ID_RE,
} from '../scripts/search-profiles.mjs';

function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jobby-profiles-'));
  return root;
}

test('create + list + get round-trips a profile', () => {
  const root = freshRoot();
  try {
    const p = createProfile(root, { title: 'Software Engineer Israel', queries: ['software engineer'], locations: ['Israel'] });
    assert.match(p.id, PROFILE_ID_RE);
    assert.equal(p.enabled, true);
    const list = listProfiles(root);
    assert.equal(list.length, 1);
    assert.equal(list[0].title, 'Software Engineer Israel');
    assert.equal(getProfile(root, p.id).id, p.id);
    assert.equal(getProfile(root, 'sp_nope'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validation rejects empty queries+locations', () => {
  const root = freshRoot();
  try {
    assert.throws(() => createProfile(root, { title: 'Empty', queries: [], locations: [] }), /at least one/);
    assert.throws(() => createProfile(root, { title: '', queries: ['x'] }), /title is required/);
    assert.equal(validateProfile({ title: 'ok', queries: [], locations: ['Israel'] }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('title is unique per tenant (case-insensitive)', () => {
  const root = freshRoot();
  try {
    createProfile(root, { title: 'Israel', queries: ['x'] });
    assert.throws(() => createProfile(root, { title: 'israel', queries: ['y'] }), /title already in use/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('idempotent PUT: identical payload does not churn updatedAt', () => {
  const root = freshRoot();
  try {
    const p = createProfile(root, { title: 'US', queries: ['backend'], locations: ['Remote'] });
    const a = upsertProfile(root, p.id, { title: 'US', queries: ['backend'], locations: ['Remote'], enabled: true });
    assert.equal(a.updatedAt, p.updatedAt, 'identical payload must not bump updatedAt');
    assert.deepEqual(a.queries, ['backend'], 'identical payload preserves queries');
    const b = upsertProfile(root, p.id, { title: 'US', queries: ['backend', 'api'], locations: ['Remote'], enabled: true });
    assert.deepEqual(b.queries, ['backend', 'api'], 'a real change must update the field');
    assert.ok(b.updatedAt >= p.updatedAt, 'a real change must not rewind updatedAt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PATCH toggles enabled without touching queries', () => {
  const root = freshRoot();
  try {
    const p = createProfile(root, { title: 'P', queries: ['x'], locations: ['y'] });
    const off = patchProfile(root, p.id, { enabled: false });
    assert.equal(off.enabled, false);
    assert.deepEqual(off.queries, ['x']);
    assert.deepEqual(off.locations, ['y']);
    const on = patchProfile(root, p.id, { enabled: true });
    assert.equal(on.enabled, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DELETE removes; double-delete 404s', () => {
  const root = freshRoot();
  try {
    const p = createProfile(root, { title: 'Gone', queries: ['x'] });
    deleteProfile(root, p.id);
    assert.equal(listProfiles(root).length, 0);
    assert.throws(() => deleteProfile(root, p.id), /not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enabledProfiles sorts by id ascending and excludes disabled', () => {
  const root = freshRoot();
  try {
    const a = createProfile(root, { title: 'A', queries: ['x'] });
    const b = createProfile(root, { title: 'B', queries: ['y'] });
    patchProfile(root, b.id, { enabled: false });
    const en = enabledProfiles(root);
    assert.equal(en.length, 1);
    assert.equal(en[0].id, a.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('two-tenant isolation: separate roots never share rows', () => {
  const t1 = freshRoot();
  const t2 = freshRoot();
  try {
    const p1 = createProfile(t1, { title: 'Default', queries: ['x'] });
    createProfile(t2, { title: 'Default', queries: ['x'] }); // same title, other tenant
    assert.equal(listProfiles(t1).length, 1);
    assert.equal(listProfiles(t2).length, 1);
    assert.equal(getProfile(t2, p1.id), null, 'T2 must not see T1 ids');
    // upsert/patch/delete on T2 with T1's id → 404, not a cross-tenant write
    assert.throws(() => upsertProfile(t2, p1.id, { title: 'Hijack', queries: ['z'] }), /not found/);
    assert.throws(() => patchProfile(t2, p1.id, { enabled: false }), /not found/);
    assert.throws(() => deleteProfile(t2, p1.id), /not found/);
    assert.equal(listProfiles(t1).length, 1, 'T1 row untouched');
  } finally {
    rmSync(t1, { recursive: true, force: true });
    rmSync(t2, { recursive: true, force: true });
  }
});

test('missing/corrupt store file loads empty (tolerant)', () => {
  const root = freshRoot();
  try {
    assert.equal(listProfiles(root).length, 0);
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', 'search-profiles.json'), '{ not valid json');
    assert.equal(listProfiles(root).length, 0, 'corrupt file must not throw');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stable serialization: key order + trailing newline', () => {
  const root = freshRoot();
  try {
    const p = createProfile(root, { title: 'S', queries: ['x'], locations: ['y'] });
    const raw = readFileSync(join(root, 'config', 'search-profiles.json'), 'utf8');
    assert.ok(raw.endsWith('\n'), 'file ends with a newline');
    // version then profiles; per profile id,title,queries,locations,enabled,updatedAt
    const obj = JSON.parse(raw);
    assert.deepEqual(Object.keys(obj), ['version', 'profiles']);
    assert.deepEqual(Object.keys(obj.profiles[0]), ['id', 'title', 'queries', 'locations', 'enabled', 'updatedAt']);
    void p;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
