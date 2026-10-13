import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeTrackerScore, urlFromNotes } from '../scripts/tracker-score.mjs';
import { parseApplications } from '../web/src/lib/tracker-table.mjs';
import fs from 'node:fs';
import path from 'node:path';

test('normalizeTrackerScore converts /100 and /5', () => {
  assert.equal(normalizeTrackerScore('94/100'), '4.7/5');
  assert.equal(normalizeTrackerScore('4.2/5'), '4.2/5');
  assert.equal(normalizeTrackerScore(90), '4.5/5');
  assert.equal(normalizeTrackerScore(''), '');
});

test('urlFromNotes extracts posting url', () => {
  assert.equal(urlFromNotes('url=https://x.test/a · Fit 4.5/5'), 'https://x.test/a');
  assert.equal(urlFromNotes('no url here'), null);
});

test('default tenant tracker parses Evaluated rows (live data smoke)', () => {
  const file = path.join(process.cwd(), 'tenants/default/data/applications.md');
  if (!fs.existsSync(file)) {
    assert.ok(true, 'skip — no default tracker in this checkout');
    return;
  }
  const rows = parseApplications(fs.readFileSync(file, 'utf8'), process.cwd());
  const evaluated = rows.filter((r) => r.status === 'Evaluated');
  assert.ok(rows.length > 0, 'expected tracker rows in tenants/default');
  assert.ok(evaluated.length > 0, 'expected Evaluated rows — ChatGPT writes landed here');
  const withUrl = evaluated.filter((r) => urlFromNotes(r.notes));
  assert.ok(withUrl.length > 0, 'expected url= in notes for MCP adds');
});
