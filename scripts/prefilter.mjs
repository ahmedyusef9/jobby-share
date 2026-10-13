#!/usr/bin/env node
/**
 * The cheap filter stage — what gets bought an LLM call (JOBBY-BL-055).
 *
 * Discovery is free: `scan.mjs` is HTTP and JSON, no model anywhere. Evaluation
 * is not. `openrouter-runner.mjs pipeline` walks every pending row in
 * `data/pipeline.md` and spends one full evaluation on each, so a sweep that
 * discovers seven thousand postings proposes seven thousand purchases. That is
 * the only place in this product where a scan turns into money.
 *
 * So this module answers one question, with no tokens and no network: **which of
 * these postings is worth paying to read?** Everything it uses is already in
 * hand — the title, the company, the location, the user's own filters and
 * targets, and what has been evaluated before.
 *
 * Three rules it exists to keep:
 *
 *   1. **A budget is a ceiling, not a suggestion.** Even with no criteria at all,
 *      a run cannot exceed `BUDGET_CEILING` evaluations. An empty profile must
 *      not be the difference between 25 calls and 7,527.
 *   2. **Nothing is destroyed.** A decision is returned, never written over the
 *      user's pipeline. Dropped and deferred rows stay pending; deferred ones are
 *      simply next in line. The user can always overrule the filter by evaluating
 *      a row directly.
 *   3. **Every decision carries a reason.** A row that vanished without an
 *      argument the user can push back on is the failure mode, not the feature.
 *
 * Lives in `scripts/` so `update-system.mjs apply` cannot remove it, and depends
 * on no upstream module for the same reason.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';

/** What one run will pay for when the caller names no budget. */
export const DEFAULT_BUDGET = 25;

/**
 * The most any single run can ever pay for.
 *
 * Mirrors `rank-pipeline.mjs`'s `LIMIT_CEILING`: an opt-in cost cap that a
 * caller can raise past the roof is not a cap. Asking for 5,000 gets 100.
 */
export const BUDGET_CEILING = 100;

/* ------------------------------------------------------------------ *
 * Text handling. All of it treats posting text as untrusted.
 * ------------------------------------------------------------------ */

const lower = (v) => String(v ?? '').toLowerCase().trim();

/**
 * Company key, matching how every tracker writer normalizes one, so a blacklist
 * row "Acme Corp." still catches an ATS feed that says "acme corp".
 *
 * Deliberately re-implemented rather than imported from the upstream
 * `tracker-utils.mjs`: this gate must not stop working because an update moved
 * an export.
 */
export function companyKey(name) {
  return lower(name)
    .replace(/[.,''`]/g, '')
    .replace(/\b(inc|llc|ltd|gmbh|corp|corporation|co|sa|bv|ag|plc)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * A reason string ends up in a pipe-delimited markdown row and in a log line.
 * Company and title text comes from a scraped page, so a `|` or a newline in it
 * could forge a column or a row. Neither survives.
 */
export function safeReason(text) {
  return String(text ?? '')
    .replace(/[|\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** URL identity for dedup: scheme and case folded, tracking noise dropped. */
export function urlKey(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|gh_src|ref|source|src)/i.test(p)) u.searchParams.delete(p);
    }
    return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/\/+$/, '');
  }
}

const SENIOR_WORDS = ['senior', 'staff', 'principal', 'lead', 'head of', 'director', 'vp', 'chief'];
const JUNIOR_WORDS = ['intern', 'internship', 'werkstudent', 'working student', 'praktikum', 'apprentice', 'trainee', 'graduate', 'junior', 'entry level', 'entry-level'];
const REMOTE_WORDS = ['remote', 'anywhere', 'distributed', 'home office', 'telework'];

function hasWord(haystack, word) {
  // Short keywords ("ai", "vp") must not fire inside another word; longer ones
  // are matched as substrings so separator and word-order variants still hit.
  if (word.length <= 3) {
    return new RegExp(`(?<![a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'i').test(haystack);
  }
  return haystack.includes(word);
}

function keywordList(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.filter((k) => typeof k === 'string').map(lower).filter(Boolean);
}

function tokens(text) {
  return new Set(lower(text).split(/[^a-z0-9+#]+/).filter((t) => t.length > 2));
}

/* ------------------------------------------------------------------ *
 * Criteria — assembled from files the user already owns
 * ------------------------------------------------------------------ */

/** Criteria that gate nothing but still cap spend. Used when files are absent. */
export function emptyCriteria() {
  return {
    titlePositive: [],
    titleNegative: [],
    locationAllow: [],
    locationBlock: [],
    locationAlwaysAllow: [],
    targetTitles: [],
    seniority: null,
    blacklist: new Map(),
    seenUrls: new Set(),
  };
}

function readIf(file) {
  try {
    return existsSync(file) ? readFileSync(file, 'utf-8') : null;
  } catch {
    return null;
  }
}

function parseYaml(text) {
  try {
    const doc = yaml.load(text ?? '');
    return doc && typeof doc === 'object' ? doc : null;
  } catch {
    return null;
  }
}

/** `| Company | Since | Scope | Reason |` — the user's own do-not-apply list. */
export function parseBlacklist(text) {
  const entries = new Map();
  for (const line of String(text ?? '').replace(/\r/g, '').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((s) => s.trim());
    const company = cells[1] || '';
    if (!company || /^[-: ]+$/.test(company)) continue;
    if (company.toLowerCase() === 'company') continue;
    const key = companyKey(company);
    if (!key || entries.has(key)) continue;
    entries.set(key, { company, reason: cells[4] || '' });
  }
  return entries;
}

/**
 * Every URL this tenant has already spent an evaluation on.
 *
 * Two sources, because the same posting can be recorded in either: a completed
 * pipeline row and a tracker row. Paying twice for one posting is the cheapest
 * waste there is to eliminate.
 */
export function parseSeenUrls({ pipeline, applications }) {
  const seen = new Set();
  for (const line of String(pipeline ?? '').split('\n')) {
    const m = line.match(/^- \[x\]\s+(\S+)/i);
    if (m) seen.add(urlKey(m[1]));
  }
  for (const line of String(applications ?? '').split('\n')) {
    for (const m of line.matchAll(/https?:\/\/[^\s|)]+/g)) seen.add(urlKey(m[0]));
  }
  seen.delete('');
  return seen;
}

/**
 * Assemble the criteria from the tenant's own files. Every one is optional —
 * a missing file weakens the gates, it never breaks the run, and the budget
 * ceiling holds regardless.
 *
 * @param {string} root the tenant's user-data directory
 */
export function loadCriteria(root) {
  const crit = emptyCriteria();
  const at = (rel) => path.join(root, rel);

  const portals = parseYaml(readIf(at('portals.yml')));
  if (portals) {
    crit.titlePositive = keywordList(portals.title_filter?.positive);
    crit.titleNegative = keywordList(portals.title_filter?.negative);
    crit.locationAllow = keywordList(portals.location_filter?.allow);
    crit.locationBlock = keywordList(portals.location_filter?.block);
    crit.locationAlwaysAllow = keywordList(portals.location_filter?.always_allow);
  }

  const profile = parseYaml(readIf(at('config/profile.yml')));
  if (profile) {
    const primary = keywordList(profile.target_roles?.primary);
    const archetypes = Array.isArray(profile.target_roles?.archetypes)
      ? profile.target_roles.archetypes.map((a) => lower(a?.name)).filter(Boolean)
      : [];
    crit.targetTitles = [...new Set([...primary, ...archetypes])];
    const all = crit.targetTitles.join(' ');
    if (SENIOR_WORDS.some((w) => all.includes(w))) crit.seniority = 'senior';
  }

  crit.blacklist = parseBlacklist(readIf(at('data/blacklist.md')));
  crit.seenUrls = parseSeenUrls({
    pipeline: readIf(at('data/pipeline.md')),
    applications: readIf(at('data/applications.md')),
  });
  return crit;
}

/* ------------------------------------------------------------------ *
 * The decision. Pure — this is the testable heart.
 * ------------------------------------------------------------------ */

/**
 * Is this posting worth an LLM call, and why.
 *
 * A `drop` is a claim that no evaluation could change the answer: the company is
 * on the user's own do-not-apply list, the title is one they excluded, the
 * seniority is wrong by a decade. Anything short of that keeps and is ranked, so
 * an uncertain posting competes for the budget rather than being decided here.
 *
 * @param {{url?: string, company?: string, role?: string, location?: string}} cand
 * @param {ReturnType<typeof emptyCriteria>} criteria
 * @returns {{verdict: 'keep'|'drop', reason: string, score: number}}
 */
export function scoreCandidate(cand, criteria = emptyCriteria()) {
  const crit = { ...emptyCriteria(), ...criteria };
  const url = String(cand?.url ?? '').trim();
  const title = lower(cand?.role);
  const company = String(cand?.company ?? '');
  const location = lower(cand?.location);
  const drop = (reason) => ({ verdict: 'drop', reason: safeReason(reason), score: 0 });

  if (!url) return drop('no URL to evaluate');

  if (crit.seenUrls.has(urlKey(url))) return drop('already evaluated');

  const bl = crit.blacklist.get(companyKey(company));
  if (bl) return drop(`blacklisted${bl.reason ? `: ${bl.reason}` : ''}`);

  const hitNegative = crit.titleNegative.find((k) => hasWord(title, k));
  if (hitNegative) return drop(`title excluded by "${hitNegative}"`);

  const hitPositive = crit.titlePositive.find((k) =>
    // " + " means several terms in any order, matching portals.yml's own syntax.
    k.includes(' + ') ? k.split(' + ').every((part) => hasWord(title, part.trim())) : hasWord(title, k),
  );
  if (crit.titlePositive.length > 0 && !hitPositive) {
    return drop('title matches no target keyword');
  }

  const remote = REMOTE_WORDS.some((w) => location.includes(w) || title.includes(w));

  if (crit.seniority === 'senior' && title) {
    const junior = JUNIOR_WORDS.find((w) => hasWord(title, w));
    // "Senior" wins the tie: "Junior to Senior Engineer" and "Graduate Program
    // Lead" are not entry-level roles, and dropping them would be the filter
    // costing the user an opportunity to save a fraction of a cent.
    if (junior && !SENIOR_WORDS.some((w) => title.includes(w))) {
      return drop(`seniority mismatch: "${junior}"`);
    }
  }

  // Location gates only fire on evidence. An unknown location is not a reason to
  // refuse — provider data is missing far more often than it is disqualifying.
  if (location) {
    const always = crit.locationAlwaysAllow.some((k) => location.includes(k));
    if (!always) {
      const blocked = crit.locationBlock.find((k) => location.includes(k));
      if (blocked) return drop(`location blocked by "${blocked}"`);
      if (crit.locationAllow.length > 0 && !crit.locationAllow.some((k) => location.includes(k)) && !remote) {
        return drop('location outside target region');
      }
    }
  }

  /*
   * Ranking, not gating. These decide who gets the budget when more postings
   * survive than the run will pay for, so the numbers only need to order
   * candidates sensibly against each other — they are not a quality score, and
   * nothing downstream should read them as one.
   */
  let score = 0;
  const titleTokens = tokens(title);
  let bestOverlap = 0;
  for (const target of crit.targetTitles) {
    const want = tokens(target);
    if (want.size === 0) continue;
    let hits = 0;
    for (const t of want) if (titleTokens.has(t)) hits += 1;
    bestOverlap = Math.max(bestOverlap, hits / want.size);
  }
  score += 0.5 * bestOverlap;
  if (hitPositive) score += 0.2;
  if (remote) score += 0.2;
  if (crit.seniority === 'senior' && SENIOR_WORDS.some((w) => title.includes(w))) score += 0.1;

  return { verdict: 'keep', reason: 'passes the cheap gates', score: Math.min(1, score) };
}

/**
 * Decide a whole batch: what to drop, what to buy now, what to leave for later.
 *
 * Returns decisions. It writes nothing and removes nothing — see rule 2 at the
 * top of this file.
 *
 * @param {Array<object>} candidates
 * @param {ReturnType<typeof emptyCriteria>} criteria
 * @param {{budget?: number}} [opts]
 */
export function prefilter(candidates, criteria = emptyCriteria(), opts = {}) {
  const requested = Number(opts.budget);
  const budget = Math.max(
    0,
    Math.min(BUDGET_CEILING, Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_BUDGET),
  );

  const rows = Array.isArray(candidates) ? candidates : [];
  const dropped = [];
  const survivors = [];
  const seenInBatch = new Set();

  rows.forEach((cand, index) => {
    const key = urlKey(cand?.url);
    if (key && seenInBatch.has(key)) {
      dropped.push({ candidate: cand, index, reason: 'duplicate of an earlier row in this batch', score: 0 });
      return;
    }
    if (key) seenInBatch.add(key);
    const decision = scoreCandidate(cand, criteria);
    if (decision.verdict === 'drop') {
      dropped.push({ candidate: cand, index, reason: decision.reason, score: 0 });
    } else {
      survivors.push({ candidate: cand, index, reason: decision.reason, score: decision.score });
    }
  });

  // Stable: score first, original order to break ties, so re-running the same
  // pipeline picks the same postings rather than a different arbitrary slice.
  survivors.sort((a, b) => b.score - a.score || a.index - b.index);

  const keep = survivors.slice(0, budget);
  const deferred = survivors.slice(budget).map((row) => ({
    ...row,
    reason: safeReason(`over budget for this run (${budget} of ${survivors.length} eligible)`),
  }));

  const byReason = {};
  for (const row of dropped) byReason[row.reason] = (byReason[row.reason] ?? 0) + 1;

  return {
    keep,
    dropped,
    deferred,
    stats: {
      total: rows.length,
      kept: keep.length,
      dropped: dropped.length,
      deferred: deferred.length,
      budget,
      byReason,
    },
  };
}

/**
 * The decision as lines the scan parser turns into progress events, so the
 * counters in `GET /api/scans` account for what was refused as well as what ran.
 *
 * @param {ReturnType<typeof prefilter>} result
 */
export function summaryLines(result) {
  const s = result.stats;
  const lines = [
    `Prefilter: ${s.total} pending, ${s.kept} selected, ${s.dropped} dropped, ` +
      `${s.deferred} deferred (budget ${s.budget})`,
  ];
  for (const [reason, count] of Object.entries(s.byReason).sort((a, b) => b[1] - a[1])) {
    lines.push(`  Prefilter dropped: ${count} removed — ${reason}`);
  }
  return lines;
}

/* ------------------------------------------------------------------ *
 * CLI — `node scripts/prefilter.mjs [--budget N] [--json]`
 * ------------------------------------------------------------------ */

/** Parse `data/pipeline.md` pending rows, mirroring openrouter-runner's reader. */
export function parsePending(text) {
  const pending = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/^- \[ \] (.+)/);
    if (!m) continue;
    const parts = m[1].split(' | ');
    pending.push({
      url: parts[0]?.trim() ?? '',
      company: parts[1]?.trim() ?? 'Unknown',
      role: parts[2]?.trim() ?? 'Unknown',
      location: parts[3]?.trim() ?? '',
    });
  }
  return pending;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { resolveRoot } = await import('./resolve-root.mjs');
  const root = resolveRoot();
  const args = process.argv.slice(2);
  const budgetArg = args.find((a) => a.startsWith('--budget'));
  const budget = budgetArg
    ? Number(budgetArg.includes('=') ? budgetArg.split('=')[1] : args[args.indexOf(budgetArg) + 1])
    : DEFAULT_BUDGET;

  const pending = parsePending(readIf(path.join(root, 'data/pipeline.md')));
  const result = prefilter(pending, loadCriteria(root), { budget });

  if (args.includes('--json')) {
    console.log(JSON.stringify({
      ...result.stats,
      keep: result.keep.map((r) => ({ url: r.candidate.url, company: r.candidate.company, role: r.candidate.role, score: Number(r.score.toFixed(3)) })),
    }, null, 2));
  } else {
    for (const line of summaryLines(result)) console.log(line);
    if (result.keep.length) console.log('\nSelected for evaluation:');
    for (const r of result.keep) {
      console.log(`  ${r.score.toFixed(2)}  ${safeReason(r.candidate.company)} — ${safeReason(r.candidate.role)}`);
    }
  }
}
