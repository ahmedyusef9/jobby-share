// Regression repros for MEMBER-JOURNEY-01/02. Executes actual page/API logic
// against a disposable CPA tenant; does not access a live account or browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cleanChips } from '../web/src/lib/clean-chips.mjs';
import * as profiles from '../scripts/search-profiles.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireWeb = createRequire(path.join(repo, 'web/package.json'));
const ts = requireWeb('typescript');
const yaml = requireWeb('js-yaml');

const CPA_PROFILE = { title: 'CPA Roles', queries: ['CPA', 'רואה חשבון'], locations: ['Israel'] };

// The REAL shipped default (templates/portals.example.yml) — the provenance
// baseline explicitExclusions() diffs a tenant's portals.yml against. Read
// live rather than hand-copied so this suite can never drift from the file it
// is testing against.
const TEMPLATE = yaml.load(fs.readFileSync(path.join(repo, 'templates/portals.example.yml'), 'utf8'));
const RAW_TEMPLATE_NEGATIVE = TEMPLATE.title_filter.negative;
assert.ok(RAW_TEMPLATE_NEGATIVE.includes('Ruby') && RAW_TEMPLATE_NEGATIVE.includes('Java ') && RAW_TEMPLATE_NEGATIVE.includes('FPGA'),
  'sanity: the shipped template still carries the software-stack excludes these tests are about');
// seedExploreFilters() runs every portals.yml list through cleanChips (trim +
// case-insensitive dedupe + 16-item cap, order-dependent on which 16 survive)
// before a tenant's filters ever reach the page/API — this is what "the
// default, as the app actually sees it" means, not the raw 35-entry file.
// Unrelated pre-existing behavior (web/src/lib/clean-chips.mjs); assertions
// below compare against this processed form, not the raw template.
const DEFAULT_NEGATIVE = cleanChips(RAW_TEMPLATE_NEGATIVE);
assert.ok(DEFAULT_NEGATIVE.length === 16 && DEFAULT_NEGATIVE.length < RAW_TEMPLATE_NEGATIVE.length,
  'sanity: the raw template exceeds the 16-item chip cap, so this suite must compare against the capped form');

/**
 * @param {Array<{title:string,queries?:string[],locations?:string[],enabled?:boolean}>} [profileSpecs]
 *   Defaults to a single enabled CPA profile. Pass [] for "no profiles at all".
 * @param {{positive?:string[], negative?:string[], allow?:string[], block?:string[]}} [portalsOverrides]
 *   Defaults to an UNTOUCHED onboarding install: the real template's full negative
 *   list, no block. Pass negative/block to simulate a member who has edited them —
 *   the #42-review repro (a short, non-tech negative list; a non-empty block) is
 *   exactly this: content that differs from the shipped default.
 */
function fixture(profileSpecs = [CPA_PROFILE], portalsOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobby-cpa-regression-'));
  const positive = portalsOverrides.positive ?? ['software engineer'];
  const negative = portalsOverrides.negative ?? DEFAULT_NEGATIVE;
  const allow = portalsOverrides.allow ?? ['United States'];
  const block = portalsOverrides.block ?? [];
  const locationFilter = { allow, ...(block.length ? { block } : {}) };
  fs.writeFileSync(path.join(root, 'portals.yml'), yaml.dump({
    title_filter: { positive, negative },
    location_filter: locationFilter,
  }));
  for (const spec of profileSpecs) profiles.createProfile(root, spec);
  const cache = new Map();
  const bindings = {
    '@/lib/tenant': { tenantRoot: () => root, platformRoot: () => repo },
    '@/lib/tenant/http': { withTenantPage: fn => fn(), withTenant: fn => fn },
    '@/lib/career-ops': { readInbox: () => [], readApplications: () => [] },
    '@/lib/core/search-profiles': profiles,
    '@/components/explore/explorer-view': { ExplorerView: () => null },
    './clean-chips.mjs': { cleanChips },
    'next/server': { NextResponse: { json: value => Response.json(value) } },
  };
  function load(rel) {
    const file = path.join(repo, rel);
    if (cache.has(file)) return cache.get(file);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: file,
    }).outputText;
    const module = { exports: {} };
    const req = name => {
      if (Object.hasOwn(bindings, name)) return bindings[name];
      if (name.startsWith('@/')) return load('web/src/' + name.slice(2) + '.ts');
      return requireWeb(name);
    };
    new Function('require', 'module', 'exports', code)(req, module, module.exports);
    cache.set(file, module.exports);
    return module.exports;
  }
  return { root, load, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('CPA Explore does not inherit legacy software exclusions', async () => {
  const f = fixture();
  try {
    const page = await f.load('web/src/app/explore/page.tsx').default();
    assert.equal(page.props.profiles[0].title, 'CPA Roles');
    assert.deepEqual(page.props.seed.filters.negative, [],
      'legacy Ruby/Java/FPGA exclusions must not apply to this CPA profile');
  } finally { f.cleanup(); }
});

test('CPA Pipeline match hints use enabled profile queries', async () => {
  const f = fixture();
  try {
    const response = await f.load('web/src/app/api/match-hints/route.ts').GET();
    const body = await response.json();
    assert.ok(body.positive.includes('cpa'), 'CPA must be a ranking keyword');
    assert.ok(!body.positive.includes('software engineer'), 'legacy software targeting must not rank CPA jobs');
    assert.deepEqual(body.negative, [], 'legacy software exclusions must not affect CPA ranking');
  } finally { f.cleanup(); }
});

// --- Boundary coverage: explicit exclusions preserved, disabled profiles, multi-profile union, tenant isolation ---

test('No enabled profile: legacy portals.yml exclusions still apply (explicit member exclusions preserved)', async () => {
  const f = fixture([]); // no profiles at all — a plain portals.yml-only member
  try {
    const page = await f.load('web/src/app/explore/page.tsx').default();
    assert.deepEqual(page.props.profiles, []);
    assert.deepEqual(page.props.seed.filters.negative, DEFAULT_NEGATIVE,
      "a member's own saved portals.yml exclusions must still apply when no profile overrides them");
    assert.deepEqual(page.props.seed.filters.positive, ['software engineer']);
  } finally { f.cleanup(); }
});

test('Disabled-only profile: legacy portals.yml exclusions still apply, disabled profile contributes nothing', async () => {
  const f = fixture([{ ...CPA_PROFILE, enabled: false }]);
  try {
    const page = await f.load('web/src/app/explore/page.tsx').default();
    assert.deepEqual(page.props.seed.filters.negative, DEFAULT_NEGATIVE,
      'a disabled profile must not switch off the legacy portal exclusions it did not opt into');
    assert.deepEqual(page.props.seed.filters.profileIds, [], 'a disabled profile must not be seeded as active');

    const response = await f.load('web/src/app/api/match-hints/route.ts').GET();
    const body = await response.json();
    assert.ok(!body.positive.includes('cpa'), 'a disabled profile must not rank its own jobs');
    assert.ok(body.positive.includes('software engineer'), 'falls back to portals.yml when nothing is enabled');
  } finally { f.cleanup(); }
});

test('Multiple enabled profiles: match hints union every enabled profile, excluding the disabled one', async () => {
  const f = fixture([
    CPA_PROFILE,
    { title: 'Backend Roles', queries: ['Backend Engineer'], locations: ['Remote'], enabled: true },
    { title: 'Old Java Search', queries: ['Java'], locations: ['United States'], enabled: false },
  ]);
  try {
    const response = await f.load('web/src/app/api/match-hints/route.ts').GET();
    const body = await response.json();
    assert.ok(body.positive.includes('cpa'), 'first enabled profile must contribute');
    assert.ok(body.positive.includes('backend engineer'), 'second enabled profile must also contribute');
    assert.ok(!body.positive.includes('java'), 'a disabled profile must not contribute its queries');
    assert.deepEqual(body.negative, []);
  } finally { f.cleanup(); }
});

test('Two tenants in the same process stay isolated (no cross-tenant profile/exclusion leakage)', async () => {
  const cpaTenant = fixture([CPA_PROFILE]);
  const javaTenant = fixture([{ title: 'Java Roles', queries: ['Java'], locations: ['United States'], enabled: true }]);
  try {
    const cpaBody = await (await cpaTenant.load('web/src/app/api/match-hints/route.ts').GET()).json();
    const javaBody = await (await javaTenant.load('web/src/app/api/match-hints/route.ts').GET()).json();
    assert.ok(cpaBody.positive.includes('cpa') && !cpaBody.positive.includes('java'),
      "tenant A's ranking must reflect only tenant A's profile");
    assert.ok(javaBody.positive.includes('java') && !javaBody.positive.includes('cpa'),
      "tenant B's ranking must reflect only tenant B's profile, not tenant A's");
    assert.notEqual(cpaTenant.root, javaTenant.root, 'tenants must resolve to distinct roots');
  } finally { cpaTenant.cleanup(); javaTenant.cleanup(); }
});

// --- #42 review correction: a blanket clear silently discarded genuine, non-profession-specific
// explicit preferences along with stale profession-specific defaults. Provenance must be per field,
// not per profile-enabled-or-not. ---

test('#42 review repro: explicit non-default exclusions survive an enabled CPA profile (Explore)', async () => {
  const f = fixture([CPA_PROFILE], { negative: ['Internship'], block: ['Tel Aviv'] });
  try {
    const page = await f.load('web/src/app/explore/page.tsx').default();
    assert.deepEqual(page.props.seed.filters.negative, ['Internship'],
      'a member-edited negative list (not the shipped default) must survive a profile-driven search, whatever it says');
    assert.deepEqual(page.props.seed.filters.block, ['Tel Aviv'],
      'a non-empty location block is never the shipped default (which ships empty) — always explicit, always kept');
    // Positive/allow still overlay from the profile — unrelated to this repro, must not regress.
    assert.deepEqual(page.props.seed.filters.positive, []);
    assert.deepEqual(page.props.seed.filters.allow, []);
  } finally { f.cleanup(); }
});

test('#42 review repro: explicit non-default exclusions survive an enabled CPA profile (match-hints)', async () => {
  const f = fixture([CPA_PROFILE], { negative: ['Internship'], block: ['Tel Aviv'] });
  try {
    const response = await f.load('web/src/app/api/match-hints/route.ts').GET();
    const body = await response.json();
    assert.ok(body.positive.includes('cpa'), 'CPA profile still ranks');
    assert.deepEqual(body.negative, ['internship'],
      'an explicit "no internships" preference must still suppress internship postings for a CPA profile too — ' +
      'it is not profession-specific, unlike the stale Ruby/Java/FPGA defaults MEMBER-JOURNEY-01/02 are about');
  } finally { f.cleanup(); }
});

test('A negative list identical to the shipped default is still dropped for a profile-driven pass, even reordered', async () => {
  // Reorder the already-capped 16-item default (not the raw 35), so cleanChips's
  // own 16-cap can't turn "same set, different order" into "different subset" —
  // this isolates order-independence from the unrelated truncation behavior.
  const reordered = [...DEFAULT_NEGATIVE].reverse();
  const f = fixture([CPA_PROFILE], { negative: reordered });
  try {
    const page = await f.load('web/src/app/explore/page.tsx').default();
    assert.deepEqual(page.props.seed.filters.negative, [],
      'provenance compares the exclusion SET, not array order — an untouched default in a different order is still the default');
  } finally { f.cleanup(); }
});

test('One entry removed from the shipped default is treated as a real edit, not the default', async () => {
  const almostDefault = DEFAULT_NEGATIVE.filter((k) => k !== 'Ruby'); // member deliberately un-excluded Ruby
  const f = fixture([CPA_PROFILE], { negative: almostDefault });
  try {
    const page = await f.load('web/src/app/explore/page.tsx').default();
    assert.deepEqual(page.props.seed.filters.negative, almostDefault,
      'even a near-default list the member has touched at all must be treated as explicit, not guessed at entry-by-entry');
  } finally { f.cleanup(); }
});
