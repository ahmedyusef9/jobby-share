import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ANON_SCOPE,
  MIGRATABLE_SCOPE,
  inheritChain,
  legacyKey,
  mayInheritUnscoped,
  storageKey,
  unscopedKey,
} from '../web/src/lib/storage-keys.mjs';

/**
 * The reported symptom: ahmed@jobby.local.v1 signed in as a brand-new member,
 * never uploaded a CV, never ran a scan — and Workers showed twenty of somebody
 * else's scored jobs, with company names, scores and verdicts.
 */

test('each tenant reads its own key', () => {
  assert.equal(storageKey('jobs', 't_abc'), 'jobby:v2:t_abc:jobs');
  assert.notEqual(storageKey('jobs', 't_abc'), storageKey('jobs', 't_xyz'));
});

test('only the default tenant may adopt pre-tenancy data', () => {
  assert.equal(mayInheritUnscoped(MIGRATABLE_SCOPE), true, 'the original single-user install');
  assert.equal(
    mayInheritUnscoped('t_<tenant>'),
    false,
    'a member must never inherit the browser previous occupant’s job history',
  );
});

test('an anonymous visitor inherits nothing', () => {
  assert.equal(mayInheritUnscoped(ANON_SCOPE), false, 'no session is not a licence to read');
  assert.equal(storageKey('jobs', ''), 'jobby:v2:anon:jobs', 'a blank scope is anon, never global');
  assert.deepEqual(inheritChain('jobs', ANON_SCOPE), []);
});

test('theme stays a device preference, not account data', () => {
  assert.equal(storageKey('theme', 't_abc'), 'jobby:theme');
  assert.equal(storageKey('theme', 't_xyz'), 'jobby:theme', 'dark mode does not follow the account');
});

test('the unscoped and legacy keys are distinct from any scoped key', () => {
  assert.equal(unscopedKey('jobs'), 'jobby:jobs');
  assert.equal(legacyKey('jobs'), 'career-ops:jobs');
  assert.notEqual(unscopedKey('jobs'), storageKey('jobs', MIGRATABLE_SCOPE));
});

test('a member inherits nothing at all, from any older key', () => {
  assert.deepEqual(
    inheritChain('jobs', 't_<tenant>'),
    [],
    'the whole reported bug: twenty of someone else’s scored jobs, adopted on first read',
  );
});

test('the default tenant walks back to its real data', () => {
  assert.deepEqual(inheritChain('jobs', MIGRATABLE_SCOPE), [
    'jobby:default:jobs',
    'jobby:jobs',
    'career-ops:jobs',
  ]);
});

test('bumping the namespace orphans anything already mis-copied', () => {
  // A browser that ran the old reader has the operator's rows under the v1 key.
  assert.notEqual(storageKey('jobs', 't_abc'), 'jobby:t_abc:jobs');
  assert.equal(inheritChain('jobs', 't_abc').length, 0, 'and v2 will not go looking for them');
});
