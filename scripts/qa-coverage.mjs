#!/usr/bin/env node
/**
 * qa-coverage.mjs — compute feature coverage against qa/features.yml.
 *
 * "47 tests passed" is not coverage; it has no denominator and it counts a
 * silently skipped test as a pass. This reads the requirement list in
 * qa/features.yml, resolves every `automated_by` against the real Playwright
 * test list, and reports what is automated, what is manual-only, and what is
 * an open gap.
 *
 *   node scripts/qa-coverage.mjs --summary
 *   node scripts/qa-coverage.mjs                      # JSON
 *   node scripts/qa-coverage.mjs --run-report r.json  # count skipped as NOT covered
 *   node scripts/qa-coverage.mjs --min 60             # ratchet gate for CI
 *
 * Exit 1 when a link is broken (renamed/deleted test) or --min is missed.
 * A broken link is a build failure by design: the alternative is a manifest
 * that quietly drifts away from the suite and reports a number nobody earned.
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import * as yamlModule from 'js-yaml';

const yaml = yamlModule.default || yamlModule;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const MANIFEST = value('--manifest', 'qa/features.yml');
const CONFIG = value('--config', 'playwright.web.config.mjs');
const RUN_REPORT = value('--run-report');
const MIN = value('--min') ? Number(value('--min')) : null;

function die(message) {
  console.error(`qa-coverage: ${message}`);
  process.exit(2);
}

if (!existsSync(MANIFEST)) die(`manifest not found at ${MANIFEST}`);

const manifest = yaml.load(readFileSync(MANIFEST, 'utf8'));
if (!manifest?.features?.length) die(`${MANIFEST} declares no features`);

/** Playwright's JSON list/report nests specs under arbitrarily deep suites. */
function flattenSpecs(suite, ancestry = []) {
  const here = suite.title && suite.title !== suite.file ? [...ancestry, suite.title] : ancestry;
  const out = [];
  for (const spec of suite.specs || []) {
    const tests = spec.tests || [];
    out.push({
      file: suite.file || spec.file,
      title: [...here, spec.title].join(' › '),
      line: spec.line,
      // In a real run report every test carries results; in --list mode it does not.
      statuses: tests.flatMap((t) => (t.results || []).map((r) => r.status)),
    });
  }
  for (const child of suite.suites || []) out.push(...flattenSpecs(child, here));
  return out;
}

function loadSpecs() {
  if (RUN_REPORT) {
    if (!existsSync(RUN_REPORT)) die(`run report not found at ${RUN_REPORT}`);
    return JSON.parse(readFileSync(RUN_REPORT, 'utf8'));
  }
  const raw = execFileSync(
    'npx',
    ['playwright', 'test', '--config', CONFIG, '--list', '--reporter', 'json'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return JSON.parse(raw);
}

const report = loadSpecs();
const specs = (report.suites || []).flatMap((s) => flattenSpecs(s));
if (!specs.length) die('the Playwright test list came back empty');

/** `automated_by` is "<spec path>::<unique substring of the test title>". */
function resolve(link) {
  const [file, needle] = String(link).split('::');
  if (!file || !needle) return { state: 'malformed' };
  const base = path.basename(file);
  const hits = specs.filter((s) => path.basename(s.file) === base && s.title.includes(needle.trim()));
  if (hits.length === 0) return { state: 'unresolved' };
  if (hits.length > 1) return { state: 'ambiguous', hits: hits.map((h) => h.title) };
  return { state: 'ok', spec: hits[0] };
}

const rows = [];
const claimed = new Set();

for (const feature of manifest.features) {
  for (const criterion of feature.criteria || []) {
    const row = {
      feature: feature.id,
      id: criterion.id,
      expected: criterion.expected,
      risk: criterion.risk || feature.risk || 'medium',
      level: criterion.level || 'api',
      state: 'gap',
      detail: criterion.note || null,
    };

    if (criterion.manual_only) {
      row.state = 'manual';
      row.detail = criterion.manual_evidence || row.detail;
    } else if (criterion.automated_by) {
      const hit = resolve(criterion.automated_by);
      row.link = criterion.automated_by;
      if (hit.state !== 'ok') {
        row.state = 'broken';
        row.detail = hit.state === 'ambiguous'
          ? `matches ${hit.hits.length} tests: ${hit.hits.join(' | ')}`
          : `no test matches this link (${hit.state})`;
      } else {
        claimed.add(`${path.basename(hit.spec.file)}::${hit.spec.title}`);
        // A test that did not actually execute proves nothing.
        const ran = hit.spec.statuses;
        if (RUN_REPORT && ran.length && ran.every((s) => s === 'skipped')) {
          row.state = 'skipped';
          row.detail = 'the linked test was skipped in this run';
        } else {
          row.state = 'automated';
          row.detail = `${path.basename(hit.spec.file)}:${hit.spec.line}`;
        }
      }
    }
    rows.push(row);
  }
}

const unmapped = specs
  .map((s) => `${path.basename(s.file)}::${s.title}`)
  .filter((key) => !claimed.has(key));

const count = (state) => rows.filter((r) => r.state === state).length;
const total = rows.length;
const manual = count('manual');
const automatable = total - manual;
const automated = count('automated');
const pct = automatable ? Math.round((automated / automatable) * 1000) / 10 : 0;

const result = {
  manifest: MANIFEST,
  release: manifest.release,
  mode: RUN_REPORT ? 'run-report' : 'static',
  totals: {
    criteria: total,
    automatable,
    automated,
    manual_only: manual,
    gaps: count('gap'),
    skipped: count('skipped'),
    broken_links: count('broken'),
    feature_coverage_pct: pct,
  },
  tests: { discovered: specs.length, mapped: claimed.size, unmapped: unmapped.length },
  criteria: rows,
  unmapped_tests: unmapped,
};

if (flag('--summary')) {
  const t = result.totals;
  const product = manifest.product || path.basename(process.cwd());
  console.log(`\n${product} QA coverage — ${MANIFEST} (${result.release}, ${result.mode})\n`);
  console.log(`  feature coverage   ${t.feature_coverage_pct}%  (${t.automated}/${t.automatable} automatable criteria)`);
  console.log(`  manual only        ${t.manual_only}`);
  console.log(`  open gaps          ${t.gaps}`);
  if (t.skipped) console.log(`  skipped in run     ${t.skipped}`);
  if (t.broken_links) console.log(`  BROKEN LINKS       ${t.broken_links}`);
  console.log(`  playwright tests   ${result.tests.discovered} discovered, ${result.tests.mapped} mapped, ${result.tests.unmapped} unmapped\n`);

  const byFeature = new Map();
  for (const r of rows) {
    const f = byFeature.get(r.feature) || { automated: 0, manual: 0, gap: 0, broken: 0, skipped: 0 };
    f[r.state] = (f[r.state] || 0) + 1;
    byFeature.set(r.feature, f);
  }
  console.log('  feature              auto  man  gap  broken');
  for (const [id, f] of byFeature) {
    console.log(
      `  ${id.padEnd(20)}  ${String(f.automated || 0).padStart(4)} ${String(f.manual || 0).padStart(4)} ` +
      `${String(f.gap || 0).padStart(4)} ${String(f.broken || 0).padStart(7)}`,
    );
  }

  const open = rows.filter((r) => r.state === 'gap' || r.state === 'broken' || r.state === 'skipped');
  if (open.length) {
    console.log(`\n  open criteria (${open.length}), highest risk first:\n`);
    const order = manifest.risk_order || ['critical', 'high', 'medium', 'low'];
    open.sort((a, b) => order.indexOf(a.risk) - order.indexOf(b.risk));
    for (const r of open) {
      console.log(`  [${r.state}] ${r.risk.padEnd(8)} ${r.id}  ${r.expected}`);
      if (r.detail) console.log(`           ↳ ${r.detail}`);
    }
  }
  console.log('');
} else {
  console.log(JSON.stringify(result, null, 2));
}

if (result.totals.broken_links > 0) process.exit(1);
if (MIN !== null && pct < MIN) {
  console.error(`qa-coverage: ${pct}% is below the --min ${MIN}% gate`);
  process.exit(1);
}
