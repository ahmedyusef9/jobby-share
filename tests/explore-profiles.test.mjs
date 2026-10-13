import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyProfileToFilters } from '../scripts/explore-profile-filters.mjs';

test('a profile replaces roles and locations, keeps excludes and recency', () => {
  const next = applyProfileToFilters(
    {
      positive: ['from portals.yml'],
      negative: ['Junior'],
      allow: ['everywhere'],
      block: ['India'],
      alwaysAllow: ['Remote'],
      sinceDays: 7,
      ats: ['greenhouse'],
      limitPerAts: 150,
    },
    { queries: ['software engineer', 'senior backend'], locations: ['Israel'] },
  );
  assert.deepEqual(next.positive, ['software engineer', 'senior backend']);
  assert.deepEqual(next.allow, ['Israel']);
  assert.deepEqual(next.negative, ['Junior']);
  assert.deepEqual(next.block, ['India']);
  assert.equal(next.sinceDays, 7);
  assert.deepEqual(next.ats, ['greenhouse']);
});

test('two profiles produce two isolated filter overlays', () => {
  const base = { positive: [], negative: [], allow: [], sinceDays: 3, ats: ['lever'] };
  const il = applyProfileToFilters(base, { queries: ['software engineer'], locations: ['Israel'] });
  const us = applyProfileToFilters(base, { queries: ['software engineer'], locations: ['United States'] });
  assert.deepEqual(il.allow, ['Israel']);
  assert.deepEqual(us.allow, ['United States']);
  assert.notDeepEqual(il.allow, us.allow);
});
