import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  BOARD_SOURCES,
  EXPLORE_SOURCES,
  isBoardSource,
  jobspyCountry,
  kmToMiles,
  normalizePostedDate,
  pickSearchTerms,
  shouldRunDrushim,
  summarizeDescription,
  titlePasses,
  wantsIsrael,
  runBoardSource,
} = await import('../scripts/explore-boards.mjs');

test('Explore sources include Drushim and LinkedIn, not as ATS directories', () => {
  assert.deepEqual([...BOARD_SOURCES], ['drushim', 'linkedin']);
  assert.ok(EXPLORE_SOURCES.includes('greenhouse'));
  assert.ok(EXPLORE_SOURCES.includes('linkedin'));
  assert.equal(isBoardSource('linkedin'), true);
  assert.equal(isBoardSource('greenhouse'), false);
});

test('pickSearchTerms caps, dedupes, and falls back', () => {
  assert.deepEqual(pickSearchTerms([]), ['software']);
  assert.deepEqual(pickSearchTerms(['  ', 'a']), ['software']);
  assert.deepEqual(pickSearchTerms(['Python', 'python', 'Golang']), ['Python', 'Golang']);
  assert.deepEqual(pickSearchTerms(['alpha', 'bravo', 'charlie', 'delta', 'echo'], 4), [
    'alpha',
    'bravo',
    'charlie',
    'delta',
  ]);
});

test('Drushim runs unless Only-in is a non-Israel place', () => {
  assert.equal(shouldRunDrushim({ allow: [] }), true);
  assert.equal(shouldRunDrushim({ allow: ['Israel'] }), true);
  assert.equal(shouldRunDrushim({ allow: ['Tel Aviv'] }), true);
  assert.equal(shouldRunDrushim({ allow: ['Berlin'] }), false);
  assert.equal(shouldRunDrushim({ allow: ['Berlin'], alwaysAllow: ['Israel'] }), true);
  assert.equal(wantsIsrael(['רמת גן']), true);
  assert.equal(wantsIsrael(['Munich']), false);
});

test('titlePasses applies negative then positive', () => {
  assert.equal(titlePasses('Senior Python Engineer', ['python'], ['intern']), true);
  assert.equal(titlePasses('Python Intern', ['python'], ['intern']), false);
  assert.equal(titlePasses('Staff Engineer', [], []), true);
  assert.equal(titlePasses('', ['python'], []), false);
});

test('JobSpy country maps aliases and km converts to miles', () => {
  assert.equal(jobspyCountry('Israel'), 'Israel');
  assert.equal(jobspyCountry('USA'), 'USA');
  assert.equal(jobspyCountry('united states'), 'USA');
  assert.equal(jobspyCountry('UK'), 'UK');
  assert.equal(jobspyCountry('Remote'), '');
  assert.equal(jobspyCountry(''), '');
  assert.equal(kmToMiles(0), 0);
  assert.equal(kmToMiles(25), 16);
});

test('normalizePostedDate keeps YYYY-MM-DD and strips ISO timestamps', () => {
  assert.equal(normalizePostedDate('2026-08-18'), '2026-08-18');
  assert.equal(normalizePostedDate('2026-08-11T09:15:21.893'), '2026-08-11');
  assert.equal(normalizePostedDate(''), '');
  assert.equal(normalizePostedDate(null), '');
});

test('summarizeDescription truncates without inventing', () => {
  assert.equal(summarizeDescription(''), '');
  assert.equal(summarizeDescription('Short blurb.'), 'Short blurb.');
  const long = 'A'.repeat(400);
  const out = summarizeDescription(long);
  assert.ok(out.length <= 280);
  assert.ok(out.endsWith('…'));
  assert.equal(summarizeDescription(long, 'Preferred summary only.'), 'Preferred summary only.');
});

test('runBoardSource skips Drushim when the location filter is not Israel', async () => {
  const events = [];
  const offers = [];
  const kept = await runBoardSource(
    'drushim',
    { positive: ['python'], negative: [], allow: ['Berlin'] },
    {
      onEvent: (e) => events.push(e),
      onOffer: (o) => offers.push(o),
    },
  );
  assert.equal(kept, 0);
  assert.equal(offers.length, 0);
  assert.ok(events.some((e) => e.kind === 'log' && /not Israel/.test(e.line)));
  assert.ok(events.some((e) => e.kind === 'atsDone' && e.ats === 'drushim' && e.unreachable === 0));
});
