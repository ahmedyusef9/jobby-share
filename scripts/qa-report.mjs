#!/usr/bin/env node
/**
 * qa-report.mjs — one round report over three sources that never agreed before.
 *
 *   qa/features.yml                     what the product owes  (the denominator)
 *   test-results/web-e2e-report.json    what the suite executed (not what it declared)
 *   qa/runs/round-<N>.jsonl             what a human or agent saw with their eyes
 *
 * It answers the two questions a round actually has to answer:
 *
 *   1. Where do we stand?      every criterion, its state, and the evidence behind it
 *   2. What changed since?     newly passing, regressed, and — the one everybody
 *                              skips — criteria that were verified against code
 *                              that has since changed, so their PASS is expired
 *
 * That last part is what `touches:` in the manifest is for. A round that only
 * ever adds green is not incremental, it is cumulative, and cumulative rounds
 * are how a suite ends up certifying a build nobody tested.
 *
 *   node scripts/qa-report.mjs --round 9 --summary
 *   node scripts/qa-report.mjs --round 9 --write   # qa/reports/round-9.md + .json
 *   node scripts/qa-report.mjs --round 9 --gate    # exit 1 unless the round is shippable
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import * as yamlModule from 'js-yaml';

const yaml = yamlModule.default || yamlModule;
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const MANIFEST = opt('manifest', 'qa/features.yml');
const CONFIG = opt('config', 'playwright.web.config.mjs');
const RUN_REPORT = opt('run-report', 'test-results/web-e2e-report.json');
const RUNS_DIR = 'qa/runs';
const ROUND = opt('round');

function die(m, c = 2) { console.error(`qa-report: ${m}`); process.exit(c); }
if (!ROUND) die('--round <n> is required');
if (!existsSync(MANIFEST)) die(`manifest not found at ${MANIFEST}`);

const manifest = yaml.load(readFileSync(MANIFEST, 'utf8'));
const riskOrder = manifest.risk_order || ['critical', 'high', 'medium', 'low'];

// ---------------------------------------------------------- playwright side

function flattenSpecs(suite, ancestry = []) {
  const here = suite.title && suite.title !== suite.file ? [...ancestry, suite.title] : ancestry;
  const out = [];
  for (const spec of suite.specs || []) {
    const statuses = (spec.tests || []).flatMap((t) => (t.results || []).map((r) => r.status));
    out.push({ file: suite.file || spec.file, title: [...here, spec.title].join(' > '), line: spec.line, statuses });
  }
  for (const child of suite.suites || []) out.push(...flattenSpecs(child, here));
  return out;
}

const reportOnDisk = existsSync(RUN_REPORT);
const pwJson = reportOnDisk
  ? JSON.parse(readFileSync(RUN_REPORT, 'utf8'))
  : JSON.parse(execFileSync('npx', ['playwright', 'test', '--config', CONFIG, '--list', '--reporter', 'json'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }));
const specs = (pwJson.suites || []).flatMap((s) => flattenSpecs(s));

// `--list` writes the same JSON shape as a real run, with every result array
// empty. Trusting the filename alone would let a leftover listing masquerade
// as run evidence, which is the exact confusion this tool exists to end.
const usedRunReport = reportOnDisk && specs.some((s) => s.statuses.length > 0);
const reportIsListingOnly = reportOnDisk && !usedRunReport;

function resolveLink(link) {
  const [file, needle] = String(link).split('::');
  if (!file || !needle) return { state: 'malformed' };
  const base = path.basename(file);
  const hits = specs.filter((s) => path.basename(s.file) === base && s.title.includes(needle.trim()));
  if (hits.length !== 1) return { state: hits.length ? 'ambiguous' : 'unresolved' };
  return { state: 'ok', spec: hits[0] };
}

// --------------------------------------------------------------- ledger side

function readLedger(round) {
  const file = path.join(RUNS_DIR, `round-${round}.jsonl`);
  if (!existsSync(file)) return { open: null, verdicts: new Map(), file, exists: false };
  const entries = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const verdicts = new Map();
  // Append-only: the last verdict for a criterion is the round's answer, but
  // every earlier one stays in the file and in the history array.
  for (const e of entries.filter((x) => x.kind === 'verdict')) {
    const prior = verdicts.get(e.criterion);
    verdicts.set(e.criterion, { ...e, history: [...(prior?.history || []), ...(prior ? [prior.verdict] : [])] });
  }
  return { open: entries.find((e) => e.kind === 'round-open') || null, verdicts, file, exists: true };
}

function previousRound(current) {
  if (!existsSync(RUNS_DIR)) return null;
  const rounds = readdirSync(RUNS_DIR)
    .map((f) => /^round-(\d+)\.jsonl$/.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .filter((n) => n < Number(current))
    .sort((a, b) => b - a);
  return rounds.length ? rounds[0] : null;
}

const ledger = readLedger(ROUND);
const prevRoundNumber = previousRound(ROUND);
const prevLedger = prevRoundNumber ? readLedger(prevRoundNumber) : null;

// ------------------------------------------------------- staleness from git

function globToRegExp(glob) {
  // Escape each literal run, then join: `*` stops at a path separator, `**`
  // crosses them. Built by splitting rather than by substituting a sentinel
  // character, so no byte that cannot appear in source ever lands in this file.
  const escapeLiteral = (s) => s.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  const body = glob
    .split('**')
    .map((segment) => segment.split('*').map(escapeLiteral).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${body}$`);
}

const baselineCommit = prevLedger?.open?.commit || null;
let changedFiles = [];
let staleBasis = 'no previous round, so nothing to compare against';
if (baselineCommit) {
  try {
    changedFiles = execFileSync('git', ['diff', '--name-only', `${baselineCommit}..HEAD`], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    staleBasis = `${changedFiles.length} file(s) changed since round ${prevRoundNumber} at ${baselineCommit}`;
  } catch {
    staleBasis = `could not diff ${baselineCommit}..HEAD (commit missing from this checkout)`;
  }
}

function featureStaleFiles(feature) {
  const globs = feature.touches || [];
  if (!globs.length || !changedFiles.length) return null;
  const patterns = globs.map(globToRegExp);
  const hit = changedFiles.filter((f) => patterns.some((re) => re.test(f)));
  return hit.length ? hit : null;
}

// ------------------------------------------------------------ effective state

const rows = [];
const claimed = new Set();

for (const feature of manifest.features || []) {
  const staleFiles = featureStaleFiles(feature);
  for (const criterion of feature.criteria || []) {
    const row = {
      feature: feature.id,
      id: criterion.id,
      expected: criterion.expected,
      risk: criterion.risk || feature.risk || 'medium',
      level: criterion.level || 'api',
      state: 'gap',
      source: 'none',
      evidence: criterion.note || null,
      stale: staleFiles,
    };

    const verdict = ledger.verdicts.get(criterion.id);
    if (verdict) {
      // A person or an agent looked at it this round. That outranks everything.
      row.state = verdict.verdict;
      row.source = verdict.mode;
      row.evidence = verdict.evidence;
      row.actor = verdict.actor;
      if (verdict.artifacts?.length) row.artifacts = verdict.artifacts;
    } else if (criterion.automated_by) {
      const hit = resolveLink(criterion.automated_by);
      row.link = criterion.automated_by;
      if (hit.state !== 'ok') {
        row.state = 'broken';
        row.evidence = `automated_by resolves to ${hit.state === 'ambiguous' ? 'several tests' : 'no test'}`;
      } else {
        claimed.add(`${path.basename(hit.spec.file)}::${hit.spec.title}`);
        row.source = 'auto';
        row.evidence = `${path.basename(hit.spec.file)}:${hit.spec.line}`;
        const statuses = hit.spec.statuses;
        if (!usedRunReport || !statuses.length) {
          // The test exists, but nothing in this round proves it ran.
          row.state = 'untested';
          row.evidence += usedRunReport ? ' (no result in this run)' : ' (suite not run this round)';
        } else if (statuses.every((s) => s === 'skipped')) {
          row.state = 'skipped';
          row.evidence += ' - skipped in this run';
        } else if (statuses.some((s) => s === 'failed' || s === 'timedOut' || s === 'interrupted')) {
          row.state = 'fail';
        } else {
          row.state = 'pass';
        }
      }
    } else if (criterion.manual_only) {
      row.state = 'unverified';
      row.source = 'manual';
      row.evidence = criterion.manual_evidence || 'manual-only, not recorded this round';
    }

    rows.push(row);
  }
}

const unmapped = specs.map((s) => `${path.basename(s.file)}::${s.title}`).filter((k) => !claimed.has(k));

// ------------------------------------------------------------- incremental

let delta = null;
if (prevLedger?.exists) {
  const before = new Map();
  for (const [id, v] of prevLedger.verdicts) before.set(id, v.verdict);
  const BROKE = new Set(['fail', 'skipped', 'blocked', 'broken']);
  const newlyPassing = [];
  const regressed = [];
  const needsRecheck = [];
  const carriedOver = [];
  for (const row of rows) {
    const was = before.get(row.id);
    if (!was) continue;
    if (was !== 'pass' && row.state === 'pass') newlyPassing.push(row.id);
    if (was !== 'pass') continue;

    if (BROKE.has(row.state)) {
      // It actively broke: something this round contradicts the old PASS.
      regressed.push({ id: row.id, now: row.state });
    } else if (row.state !== 'pass') {
      // Nobody re-verified it. Whether the old PASS still counts depends
      // entirely on whether the code underneath it moved.
      if (row.stale) needsRecheck.push({ id: row.id, changed: row.stale });
      else carriedOver.push(row.id);
    }
  }
  delta = {
    previous_round: prevRoundNumber,
    baseline_commit: baselineCommit,
    basis: staleBasis,
    newly_passing: newlyPassing,
    regressed,
    needs_recheck: needsRecheck,
    carried_over: carriedOver,
  };
}

const count = (s) => rows.filter((r) => r.state === s).length;
const criticalOpen = rows.filter((r) => r.risk === 'critical' && r.state !== 'pass');
const totals = {
  criteria: rows.length,
  pass: count('pass'),
  fail: count('fail'),
  skipped: count('skipped'),
  untested: count('untested'),
  unverified_manual: count('unverified'),
  blocked: count('blocked'),
  gaps: count('gap'),
  broken_links: count('broken'),
  stale: rows.filter((r) => r.stale).length,
  verified_pct: Math.round((count('pass') / rows.length) * 1000) / 10,
  critical_open: criticalOpen.length,
};

// A round ships only when nothing failed, no link rotted, and every critical
// criterion is a green with evidence behind it.
const shippable = totals.fail === 0 && totals.broken_links === 0 && totals.critical_open === 0;

const result = {
  round: Number(ROUND),
  release: manifest.release,
  commit: ledger.open?.commit || null,
  actor: ledger.open?.actor || null,
  base_url: ledger.open?.base_url || null,
  evidence_basis: usedRunReport
    ? `run report ${RUN_REPORT}`
    : reportIsListingOnly
      ? `${RUN_REPORT} holds a --list listing, not a run: the suite has not been executed for this round`
      : 'static test list (suite not run)',
  totals,
  shippable,
  delta,
  criteria: rows,
  unmapped_tests: unmapped,
};

// ---------------------------------------------------------------- rendering

function markdown() {
  const t = totals;
  const L = [];
  const esc = (s) => String(s || '').replace(/\|/g, '\\|');
  L.push(`# QA round ${ROUND} - jobby ${manifest.release}`);
  L.push('');
  L.push(`- **Verdict:** ${shippable ? 'SHIPPABLE' : 'NOT SHIPPABLE'}`);
  L.push(`- **Verified:** ${t.pass}/${t.criteria} criteria (${t.verified_pct}%)`);
  L.push(`- **Commit:** ${result.commit || 'round not opened'}`);
  L.push(`- **Evidence basis:** ${result.evidence_basis}`);
  if (!shippable) {
    const why = [];
    if (t.fail) why.push(`${t.fail} failing`);
    if (t.broken_links) why.push(`${t.broken_links} broken manifest link(s)`);
    if (t.critical_open) why.push(`${t.critical_open} critical criteria not verified`);
    L.push(`- **Blocking:** ${why.join(', ')}`);
  }
  L.push('');
  L.push('| state | count |');
  L.push('|---|---|');
  const table = {
    pass: t.pass, fail: t.fail, skipped: t.skipped, untested: t.untested,
    'unverified (manual)': t.unverified_manual, blocked: t.blocked,
    gap: t.gaps, 'broken link': t.broken_links, stale: t.stale,
  };
  for (const [k, v] of Object.entries(table)) L.push(`| ${k} | ${v} |`);
  L.push('');
  if (delta) {
    L.push(`## Since round ${delta.previous_round}`);
    L.push('');
    L.push(`${delta.basis}.`);
    L.push('');
    L.push(`- **newly passing:** ${delta.newly_passing.length ? delta.newly_passing.join(', ') : 'none'}`);
    L.push(`- **regressed:** ${delta.regressed.length ? delta.regressed.map((r) => `${r.id} -> ${r.now}`).join(', ') : 'none'}`);
    L.push(`- **passed before, but their code changed since, so re-run:** ${delta.needs_recheck.length ? delta.needs_recheck.map((r) => r.id).join(', ') : 'none'}`);
    L.push(`- **carried over (passed before, nothing underneath changed):** ${delta.carried_over.length ? delta.carried_over.join(', ') : 'none'}`);
    L.push('');
    if (delta.needs_recheck.length) {
      L.push('Why each needs a re-run:');
      L.push('');
      for (const r of delta.needs_recheck) L.push(`- \`${r.id}\` - changed: ${r.changed.join(', ')}`);
      L.push('');
    }
  }
  L.push('## Open criteria');
  L.push('');
  const open = rows.filter((r) => r.state !== 'pass')
    .sort((a, b) => riskOrder.indexOf(a.risk) - riskOrder.indexOf(b.risk));
  if (!open.length) {
    L.push('None - every criterion carries a verified pass.');
  } else {
    L.push('| risk | criterion | state | expected | note |');
    L.push('|---|---|---|---|---|');
    for (const r of open) L.push(`| ${r.risk} | \`${r.id}\` | ${r.state} | ${esc(r.expected)} | ${esc(r.evidence)} |`);
  }
  L.push('');
  L.push('## Verified this round');
  L.push('');
  const passed = rows.filter((r) => r.state === 'pass');
  if (!passed.length) {
    L.push('Nothing carries a verified pass yet.');
  } else {
    L.push('| criterion | via | evidence |');
    L.push('|---|---|---|');
    for (const r of passed) L.push(`| \`${r.id}\` | ${r.source} | ${esc(r.evidence)} |`);
  }
  L.push('');
  return L.join('\n');
}

if (flag('write')) {
  mkdirSync('qa/reports', { recursive: true });
  writeFileSync(`qa/reports/round-${ROUND}.md`, `${markdown()}\n`);
  writeFileSync(`qa/reports/round-${ROUND}.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`wrote qa/reports/round-${ROUND}.md and qa/reports/round-${ROUND}.json`);
}

if (flag('summary')) console.log(`\n${markdown()}\n`);
else if (!flag('write')) console.log(JSON.stringify(result, null, 2));

if (totals.broken_links > 0) process.exit(1);
if (flag('gate') && !shippable) process.exit(1);
