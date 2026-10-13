// tests/prefilter.test.mjs — the cheap filter stage (JOBBY-BL-055).
//
// This module is the only thing standing between a 7,527-posting sweep and
// 7,527 model calls, so the properties below are the ones worth pinning:
//
//   1. The budget is a ceiling. A caller asking for more than BUDGET_CEILING
//      gets BUDGET_CEILING, and an EMPTY profile — no filters, no targets, no
//      blacklist — still cannot buy more than the budget. A cost cap that only
//      holds when the user has configured things is not a cost cap.
//   2. Nothing is destroyed. Everything that goes in comes back out in exactly
//      one of keep / dropped / deferred, so no posting can be silently lost.
//   3. Every decision carries a reason, and no reason can forge a markdown row.
//   4. The selection is stable: the same input picks the same postings.
import { pass, fail } from './helpers.mjs';
import {
  BUDGET_CEILING,
  DEFAULT_BUDGET,
  companyKey,
  emptyCriteria,
  parseBlacklist,
  parsePending,
  parseSeenUrls,
  prefilter,
  safeReason,
  scoreCandidate,
  summaryLines,
  urlKey,
} from '../scripts/prefilter.mjs';

console.log('\nprefilter — the cheap stage before any LLM call');

const check = (label, cond) => (cond ? pass(label) : fail(label));

const job = (over = {}) => ({
  url: 'https://boards.test/a',
  company: 'Acme',
  role: 'Senior Backend Engineer',
  location: 'Berlin, Germany',
  ...over,
});

// ── the budget is the actual spend control ──────────────────────────
{
  const many = Array.from({ length: 500 }, (_, i) => job({ url: `https://boards.test/${i}` }));

  const wide = prefilter(many, emptyCriteria(), { budget: 5000 });
  check('a budget above the ceiling is clamped to the ceiling', wide.keep.length === BUDGET_CEILING);

  // The case that matters most: a brand-new account with nothing configured.
  const bare = prefilter(many, emptyCriteria(), {});
  check('with no criteria at all the default budget still holds', bare.keep.length === DEFAULT_BUDGET);
  check('everything over budget is deferred, not dropped', bare.stats.deferred === 500 - DEFAULT_BUDGET);
  check('a deferred row says it was the budget, not the filters', bare.deferred[0].reason.includes('over budget'));

  const zero = prefilter(many, emptyCriteria(), { budget: 0 });
  check('a zero budget buys nothing', zero.keep.length === 0);

  const negative = prefilter(many, emptyCriteria(), { budget: -10 });
  check('a negative budget cannot go below zero', negative.keep.length === 0);

  const junk = prefilter(many, emptyCriteria(), { budget: 'lots' });
  check('a non-numeric budget falls back to the default', junk.keep.length === DEFAULT_BUDGET);
}

// ── nothing is lost ─────────────────────────────────────────────────
{
  const crit = { ...emptyCriteria(), titleNegative: ['sales'] };
  const rows = [
    job({ url: 'https://boards.test/1' }),
    job({ url: 'https://boards.test/2', role: 'Sales Manager' }),
    job({ url: 'https://boards.test/3' }),
  ];
  const out = prefilter(rows, crit, { budget: 1 });
  const accounted = out.keep.length + out.dropped.length + out.deferred.length;
  check('every input row lands in exactly one bucket', accounted === rows.length);
  check('the totals in stats match the buckets', out.stats.total === 3 && out.stats.kept === 1);
  check(
    'a dropped row still carries its original candidate',
    out.dropped[0].candidate.url === 'https://boards.test/2',
  );
}

// ── hard gates, each with an argument the user can push back on ──────
{
  const crit = {
    ...emptyCriteria(),
    titlePositive: ['engineer'],
    titleNegative: ['sales'],
    locationAllow: ['germany'],
    locationBlock: ['india'],
    blacklist: parseBlacklist('| Company | Since | Scope | Reason |\n| Acme Corp. | 2026 | all | ghosted me |'),
    seenUrls: new Set([urlKey('https://boards.test/seen')]),
    seniority: 'senior',
  };

  // Anything not testing the blacklist uses a company that is not on it — the
  // gates run in order and the blacklist would otherwise answer first.
  const clean = (over) => job({ company: 'Globex', ...over });
  const drops = [
    ['no URL to evaluate', clean({ url: '' })],
    ['already evaluated', clean({ url: 'https://boards.test/seen' })],
    ['blacklisted', job({ company: 'ACME corp' })],
    ['title excluded', clean({ role: 'Sales Engineer' })],
    ['title matches no target keyword', clean({ role: 'Chef de Partie' })],
    ['seniority mismatch', clean({ role: 'Junior Engineer' })],
    ['location blocked', clean({ location: 'Bangalore, India' })],
    ['location outside target region', clean({ location: 'Tokyo, Japan' })],
  ];
  for (const [expect, cand] of drops) {
    const d = scoreCandidate(cand, crit);
    check(`drops on: ${expect}`, d.verdict === 'drop' && d.reason.includes(expect.split(':')[0]));
  }

  check(
    'the blacklist reason reaches the user, not just the verdict',
    scoreCandidate(job({ company: 'Acme' }), crit).reason.includes('ghosted me'),
  );

  const kept = scoreCandidate(clean({}), crit);
  check('a matching posting is kept', kept.verdict === 'keep');
  check('a kept posting still carries a reason', kept.reason.length > 0);
}

// ── gates fire only on evidence ─────────────────────────────────────
{
  const crit = { ...emptyCriteria(), locationAllow: ['germany'], seniority: 'senior' };
  check(
    'an unknown location is not a reason to refuse',
    scoreCandidate(job({ location: '' }), crit).verdict === 'keep',
  );
  check(
    'an explicitly remote role survives a region filter',
    scoreCandidate(job({ location: 'Remote (worldwide)' }), crit).verdict === 'keep',
  );
  check(
    '"Junior to Senior Engineer" is not treated as entry level',
    scoreCandidate(job({ role: 'Junior to Senior Engineer' }), crit).verdict === 'keep',
  );
  check(
    'always_allow beats a block on a multi-location string',
    scoreCandidate(
      job({ location: 'Remote, Germany or India' }),
      { ...crit, locationBlock: ['india'], locationAlwaysAllow: ['germany'] },
    ).verdict === 'keep',
  );
}

// ── ranking decides who gets the budget, deterministically ──────────
{
  const crit = { ...emptyCriteria(), targetTitles: ['senior backend engineer'] };
  const rows = [
    job({ url: 'https://boards.test/weak', role: 'Office Coordinator' }),
    job({ url: 'https://boards.test/strong', role: 'Senior Backend Engineer', location: 'Remote' }),
  ];
  const out = prefilter(rows, crit, { budget: 1 });
  check('the budget goes to the closest match, not the first row', out.keep[0].candidate.url.endsWith('strong'));

  const a = prefilter(rows, crit, { budget: 1 });
  const b = prefilter(rows, crit, { budget: 1 });
  check('the same input picks the same posting twice', a.keep[0].candidate.url === b.keep[0].candidate.url);

  const tied = [
    job({ url: 'https://boards.test/first', role: 'Nothing In Common' }),
    job({ url: 'https://boards.test/second', role: 'Nothing In Common' }),
  ];
  check(
    'ties break on the original order rather than arbitrarily',
    prefilter(tied, crit, { budget: 1 }).keep[0].candidate.url.endsWith('first'),
  );
}

// ── duplicates inside one batch ─────────────────────────────────────
{
  const rows = [
    job({ url: 'https://boards.test/x?utm_source=news' }),
    job({ url: 'https://boards.test/x' }),
  ];
  const out = prefilter(rows, emptyCriteria(), { budget: 10 });
  check('the same posting twice is bought once', out.keep.length === 1);
  check('the second copy says why it was dropped', out.dropped[0].reason.includes('duplicate'));
  check('tracking parameters do not make two postings out of one', urlKey(rows[0].url) === urlKey(rows[1].url));
}

// ── untrusted posting text cannot forge a row ───────────────────────
{
  check('a pipe in a reason cannot open a column', !safeReason('remote | senior').includes('|'));
  check('a newline in a reason cannot forge a row', !safeReason('ok\n- [ ] https://evil.test').includes('\n'));
  const crit = { ...emptyCriteria(), blacklist: parseBlacklist('| Evil | | | a\nb |') };
  check(
    'a blacklist reason is sanitised before it is quoted back',
    !scoreCandidate(job({ company: 'Evil' }), crit).reason.includes('\n'),
  );
}

// ── the inputs it reads ─────────────────────────────────────────────
{
  check('company keys ignore suffix and punctuation', companyKey('Acme Corp.') === companyKey('ACME corp'));

  const seen = parseSeenUrls({
    pipeline: '- [x] https://boards.test/done | Acme | Role\n- [ ] https://boards.test/todo | B | R',
    applications: '| 1 | 2026-01-01 | Acme | Role | Applied | 4.0/5 | ✅ | [1](reports/1.md) | https://boards.test/applied |',
  });
  check('a completed pipeline row counts as already evaluated', seen.has(urlKey('https://boards.test/done')));
  check('a tracked application counts as already evaluated', seen.has(urlKey('https://boards.test/applied')));
  check('a still-pending row does not', !seen.has(urlKey('https://boards.test/todo')));

  const pending = parsePending('# Pipeline\n- [ ] https://x.test/1 | Acme | Backend Engineer | Berlin\n- [x] https://x.test/2 | B | R\nnoise');
  check('only unchecked rows are pending', pending.length === 1 && pending[0].company === 'Acme');
  check('the location column is read when present', pending[0].location === 'Berlin');
}

// ── the line the worker parses back into counters ───────────────────
{
  const out = prefilter(
    [job(), job({ url: 'https://boards.test/2', role: 'Sales Rep' })],
    { ...emptyCriteria(), titleNegative: ['sales'] },
    { budget: 5 },
  );
  const lines = summaryLines(out);
  check(
    'the summary states pending, selected, dropped, deferred and the budget',
    /Prefilter: 2 pending, 1 selected, 1 dropped, 0 deferred \(budget 5\)/.test(lines[0]),
  );
  check('each drop reason is reported with its count', lines.some((l) => l.includes('1 removed — title excluded')));
}
