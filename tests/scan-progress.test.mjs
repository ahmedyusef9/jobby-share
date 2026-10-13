import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseScanLine, takeLines } from '../scripts/scan-parse.mjs';
import {
  completion,
  createRecorder,
  emptyProgress,
  foldEvent,
  isProductive,
  listProgress,
  readProgress,
} from '../scripts/scan-progress.mjs';

const fold = (events) => events.reduce(foldEvent, emptyProgress({ scanId: 's1' }));

/* ---------------------------------------------------------------- *
 * Parsing the scanner's own output
 * ---------------------------------------------------------------- */

test('the scanner s progress lines become structured events', () => {
  const ctx = {};
  assert.deepEqual(parseScanLine('⚙ greenhouse — 412 companies', ctx), {
    kind: 'atsStart',
    ats: 'greenhouse',
    companies: 412,
  });
  // The ATS carries across lines: the progress line does not name it.
  assert.deepEqual(parseScanLine('  120/412 scanned, 7 total matches', ctx), {
    kind: 'progress',
    ats: 'greenhouse',
    scanned: 120,
    total: 412,
    matches: 7,
  });
});

test('an unrecognised line is not an event', () => {
  assert.equal(parseScanLine('some banner text', {}), null);
});

test('a progress line split across two chunks is not lost', () => {
  const first = takeLines('', '⚙ greenhouse — 412 companies\n  120/4');
  assert.equal(first.lines.length, 1);
  const second = takeLines(first.rest, '12 scanned, 7 total matches\n');
  assert.deepEqual(parseScanLine(second.lines[0], { ats: 'greenhouse' }), {
    kind: 'progress',
    ats: 'greenhouse',
    scanned: 120,
    total: 412,
    matches: 7,
  });
});

/* ---------------------------------------------------------------- *
 * Progress is derived, never asserted
 * ---------------------------------------------------------------- */

test('completion comes from pages actually finished', () => {
  const s = fold([
    { kind: 'atsStart', ats: 'gh', companies: 100 },
    { kind: 'atsStart', ats: 'lever', companies: 100 },
    { kind: 'progress', ats: 'gh', scanned: 100, total: 100, matches: 4 },
    { kind: 'progress', ats: 'lever', scanned: 40, total: 100, matches: 1 },
  ]);
  assert.equal(completion(s), 0.7, '140 of 200 companies');
});

test('unknown progress is null, never a made-up percentage', () => {
  assert.equal(completion(emptyProgress({ scanId: 's' })), null);
});

test('a source cannot report more scanned than it has', () => {
  const s = fold([
    { kind: 'atsStart', ats: 'gh', companies: 10 },
    { kind: 'progress', ats: 'gh', scanned: 999, total: 10, matches: 0 },
  ]);
  assert.equal(completion(s), 1, 'a bad line must not push completion past 100%');
});

test('the broken-run shape is visible in the counters', () => {
  // 240 companies swept, nothing discovered, nothing evaluated: the exact
  // "burning effort with no result" case this milestone exists to expose.
  const grinding = fold([
    { kind: 'atsStart', ats: 'gh', companies: 240 },
    { kind: 'progress', ats: 'gh', scanned: 240, total: 240, matches: 0 },
  ]);
  assert.equal(isProductive(grinding), false);
  assert.equal(completion(grinding), 1, 'finished, and still produced nothing');

  const healthy = foldEvent(grinding, { kind: 'offer' });
  assert.equal(isProductive(healthy), true);
});

test('the scanner s own total wins when our line count fell behind', () => {
  const s = fold([{ kind: 'offer' }, { kind: 'matches', matches: 7 }]);
  assert.equal(s.counts.discovered, 7, 'a dropped line must not look like a failed scan');
});

test('duplicates, filtered and evaluated are counted separately', () => {
  const s = fold([
    { kind: 'offer' },
    { kind: 'duplicate' },
    { kind: 'filtered' },
    { kind: 'evaluated', tokens: 1200 },
  ]);
  assert.deepEqual(
    { d: s.counts.discovered, dup: s.counts.duplicates, f: s.counts.filtered, e: s.counts.evaluated, t: s.counts.tokens },
    { d: 1, dup: 1, f: 1, e: 1, t: 1200 },
    'the money line is evaluated/tokens, and it is separate from discovery',
  );
});

test('the recent tail stays bounded on a long sweep', () => {
  let s = emptyProgress({ scanId: 's' });
  for (let i = 0; i < 200; i++) s = foldEvent(s, { kind: 'progress', ats: 'gh', scanned: i, total: 200, matches: 0 });
  assert.ok(s.recent.length <= 40, 'a full sweep must not grow the record without bound');
});

/* ---------------------------------------------------------------- *
 * Persistence, inside the tenant's own directory
 * ---------------------------------------------------------------- */

test('a scan record is written under the tenant and read back', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobby-scan-'));
  const rec = createRecorder(root, { scanId: 'scan-1', tenantId: 't_a' }, { flushMs: 0 });
  rec.record({ kind: 'atsStart', ats: 'gh', companies: 5 });
  rec.record({ kind: 'offer' });
  rec.finish('ok');

  const back = readProgress(root, 'scan-1');
  assert.equal(back.status, 'ok');
  assert.equal(back.counts.discovered, 1);
  assert.equal(back.tenantId, 't_a');
  assert.ok(
    fs.existsSync(path.join(root, '.career-ops-web', 'scans', 'scan-1.json')),
    'lives beside the run snapshots, inside the tenant',
  );
});

test('listing is newest first and survives a half-written file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobby-scan-'));
  createRecorder(root, { scanId: 'old', startedAt: 1 }, { flushMs: 0 }).finish('ok');
  createRecorder(root, { scanId: 'new', startedAt: 2 }, { flushMs: 0 }).finish('ok');
  fs.writeFileSync(path.join(root, '.career-ops-web', 'scans', 'corrupt.json'), '{not json');

  const rows = listProgress(root);
  assert.deepEqual(rows.map((r) => r.scanId), ['new', 'old'], 'a corrupt file is skipped, not fatal');
});

test('the portal scanner summary is understood too, not just the ATS one', () => {
  // The first live queued scan reported "89 companies, 0 discovered" because
  // only the ATS scanner's vocabulary was parsed. These are scan.mjs's lines.
  assert.deepEqual(parseScanLine('Total jobs found:      42', {}), { kind: 'matches', matches: 42 });
  assert.deepEqual(parseScanLine('Filtered by title:     37 removed', {}), {
    kind: 'filteredBatch',
    filtered: 37,
  });
  assert.deepEqual(parseScanLine('Job boards scanned:    3', {}), { kind: 'boardsScanned', boards: 3 });
});

test('a scan that found rows and filtered them all is productive but explains itself', () => {
  const s = [
    { kind: 'companiesScanned', companies: 89 },
    { kind: 'matches', matches: 42 },
    { kind: 'filteredBatch', filtered: 37 },
    { kind: 'filteredBatch', filtered: 5 },
  ].reduce(foldEvent, emptyProgress({ scanId: 's' }));

  assert.equal(s.counts.discovered, 42);
  assert.equal(s.counts.filtered, 42, 'removals accumulate across reasons');
  assert.equal(isProductive(s), true, 'it found things; the filters are the story, not a failure');
});

test('the cheap filter stage reports what a run refused to buy', () => {
  // The one line that says how much of a pipeline run was paid for
  // (JOBBY-BL-055). Without it the counters show evaluations and no sense of
  // how many candidates never got one.
  const event = parseScanLine(
    'Prefilter: 240 pending, 25 selected, 180 dropped, 35 deferred (budget 25)',
    {},
  );
  assert.deepEqual(event, {
    kind: 'prefilter',
    pending: 240,
    selected: 25,
    dropped: 180,
    deferred: 35,
    budget: 25,
  });

  const s = foldEvent(emptyProgress({ scanId: 's' }), event);
  assert.equal(s.counts.prefilterDropped, 180);
  assert.equal(s.counts.deferred, 35);
  assert.equal(s.counts.filtered, 0, 'discovery filtering and spend filtering stay separate numbers');
  assert.equal(s.prefilter.budget, 25);
});
