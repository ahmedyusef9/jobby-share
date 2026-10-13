/**
 * One-time bootstrap: log in as operator through the real /signin UI, mint a
 * Connect key via POST /api/account/mcp, and store it for the MCP tool specs.
 *
 *   node test/web-e2e/bootstrap-mcp-key.mjs
 *
 * Writes .career-ops-web/e2e.local.json {mcpKey} (gitignored). Safe to re-run:
 * each run mints a NEW key; pass --rotate to retire old ones first.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { memberCredentials } from './credentials.mjs';
import { fillAndSubmit } from './auth.helpers.mjs';

const BASE = process.env.JOBBY_E2E_BASE_URL || 'http://localhost:3001';
const member = memberCredentials();
if (!member) {
  console.error('No member creds (set JOBBY_E2E_EMAIL/PASSWORD or e2e.local.json)');
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${BASE}/signin`);
await fillAndSubmit(
  page,
  [
    [page.getByLabel('Email'), member.email],
    [page.getByLabel('Password'), member.password],
  ],
  page.getByRole('button', { name: 'Sign in', exact: true }),
);
await page.waitForURL((u) => !String(u).includes('/signin'), { timeout: 20_000 });

const res = await page.request.post(`${BASE}/api/account/mcp`, {
  data: { name: 'e2e-suite' },
});
const raw = await res.text();
let body = {};
try { body = JSON.parse(raw); } catch {}
if (!res.ok || !body.token) {
  console.error('mint failed:', res.status(), raw.slice(0, 300));
  process.exit(1);
}

const file = path.resolve('.career-ops-web', 'e2e.local.json');
let local = {};
try {
  local = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {}
local.mcpKey = body.token;
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `${JSON.stringify(local, null, 2)}\n`, { mode: 0o600 });
console.log(`minted key ${body.prefix}… → ${file}`);
await browser.close();
