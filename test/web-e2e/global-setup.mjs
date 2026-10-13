/**
 * Reclaim leftover QA keys before the suite starts.
 *
 * createToken enforces MAX_MCP_KEYS = 5 live keys per tenant
 * (scripts/mcp-tokens.mjs:184). Several specs mint keys and revoke them in a
 * `finally`, so any run killed mid-flight leaks one. After five interruptions
 * the next run cannot mint at all: mints fail with a 409 that surfaces as
 * "Expected: 200, Received: 409" in whichever spec happens to run first, which
 * reads as an access-control defect and is not one.
 *
 * Per-spec cleanup could never fix this — by the time a spec discovers the cap
 * it is already mid-run and cannot tell a sibling spec's live fixture from last
 * week's litter. Doing it once, before anything mints, can: at this point every
 * QA-prefixed key on the account is by definition from a previous run.
 *
 * Deliberately narrow: only keys whose name starts with a known QA prefix are
 * touched, so a real key a person minted through the UI is never revoked, and
 * a failure here never fails the run — a stack that is merely unreachable
 * should be reported by the tests, not by setup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { memberCredentials, secondMemberCredentials, mcpKey } from './credentials.mjs';
import { fillAndSubmit } from './auth.helpers.mjs';

/** Stable Connect key for journeys.spec + mcp-tools.spec (bootstrap-mcp-key.mjs). */
const SUITE_KEY_NAME = 'e2e-suite';

/**
 * Every prefix this suite mints keys under, derived from the specs:
 *   grep -rhoE '`[a-z][a-z0-9-]*-\$\{Date\.now\(\)\}`' test/web-e2e/*.mjs
 * Anything not on this list is a real key a person minted, and is never touched.
 * Add to it when a spec introduces a new name, or that spec's litter will hold
 * a slot against the 5-key cap forever.
 */
const QA_KEY_PREFIXES = [
  'access-matrix-',
  'conformance-',
  'connect-ui-',
  'e2e-',
  'funnel-',
  'journey-',
  'performance-',
  'qa-',
];

const isQaKey = (name) => {
  const n = String(name || '');
  // Never reclaim the long-lived suite key — journeys/mcp-tools read
  // JOBBY_E2E_MCP_KEY at import time; deleting e2e-suite mid-setup → 401.
  if (n === SUITE_KEY_NAME) return false;
  return QA_KEY_PREFIXES.some((p) => n.startsWith(p));
};

async function suiteKeyLive(request, token) {
  if (!token) return false;
  const res = await request.post('/api/mcp', {
    params: { key: token },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    },
  });
  return res.status() === 200;
}

/** Mint or refresh e2e-suite and publish token for specs that import mcpKey(). */
async function ensureSuiteKey(page) {
  const current = process.env.JOBBY_E2E_MCP_KEY || mcpKey();
  if (await suiteKeyLive(page.request, current)) {
    process.env.JOBBY_E2E_MCP_KEY = current;
    return { action: 'reused' };
  }

  const listed = await page.request.get('/api/account/mcp');
  if (listed.status() !== 200) return { action: 'skipped', reason: `list HTTP ${listed.status()}` };
  const { keys = [] } = await listed.json();
  for (const key of keys.filter((k) => k.name === SUITE_KEY_NAME)) {
    await page.request.delete(`/api/account/mcp?id=${encodeURIComponent(key.id)}`).catch(() => {});
  }

  const minted = await page.request.post('/api/account/mcp', {
    data: { name: SUITE_KEY_NAME, scope: 'read-write', expires: '7d' },
  });
  if (minted.status() !== 200) return { action: 'failed', status: minted.status() };
  const body = await minted.json();
  process.env.JOBBY_E2E_MCP_KEY = body.token;

  const file = path.resolve('.career-ops-web', 'e2e.local.json');
  let local = {};
  try {
    local = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* first run */
  }
  local.mcpKey = body.token;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(local, null, 2)}\n`, { mode: 0o600 });
  return { action: 'minted', prefix: body.prefix };
}

async function reclaimFor(browser, baseURL, credentials, label) {
  if (!credentials) return { label, skipped: 'no credentials' };
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  try {
    await page.goto('/signin');
    await fillAndSubmit(
      page,
      [
        [page.getByLabel('Email'), credentials.email],
        [page.getByLabel('Password'), credentials.password],
      ],
      page.getByRole('button', { name: 'Sign in', exact: true }),
    );
    await page.waitForURL((url) => !url.href.includes('/signin'), { timeout: 20_000 });

    const listed = await page.request.get('/api/account/mcp');
    if (listed.status() !== 200) return { label, skipped: `key list HTTP ${listed.status()}` };
    const { keys = [] } = await listed.json();
    const stale = keys.filter((key) => isQaKey(key.name));
    for (const key of stale) {
      await page.request.delete(`/api/account/mcp?id=${encodeURIComponent(key.id)}`).catch(() => {});
    }
    const suite = label === 'member A' ? await ensureSuiteKey(page) : null;
    return { label, live: keys.length, reclaimed: stale.length, suite };
  } catch (error) {
    return { label, skipped: error.message.split('\n')[0] };
  } finally {
    await context.close();
  }
}

export default async function globalSetup(config) {
  const baseURL = config.projects?.[0]?.use?.baseURL || process.env.JOBBY_E2E_BASE_URL;
  if (!baseURL) return;

  const browser = await chromium.launch();
  try {
    const results = await Promise.all([
      reclaimFor(browser, baseURL, memberCredentials(), 'member A'),
      reclaimFor(browser, baseURL, secondMemberCredentials(), 'member B'),
    ]);
    for (const r of results) {
      if (r.skipped) console.log(`[qa-setup] ${r.label}: skipped (${r.skipped})`);
      else {
        const suite = r.suite ? `, suite ${r.suite.action}${r.suite.prefix ? ` (${r.suite.prefix}…)` : ''}` : '';
        console.log(`[qa-setup] ${r.label}: ${r.live} live key(s), reclaimed ${r.reclaimed} from previous runs${suite}`);
      }
    }
  } finally {
    await browser.close();
  }
}
