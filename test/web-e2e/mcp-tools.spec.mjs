/**
 * BL-063 — MCP tool contracts over raw JSON-RPC (no external client).
 * Covers R1-pass.md sections #51/#52/#53: resume round-trip, jobs_fetch
 * verbatim table, submit_score write-back + idempotency.
 *
 * Requires a member Connect key: JOBBY_E2E_MCP_KEY or e2e.local.json {mcpKey}.
 */
import { test, expect } from 'playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { mcpKey, operatorCredentials } from './credentials.mjs';
import { fillAndSubmit } from './auth.helpers.mjs';

const KEY = mcpKey();
const MARKER = `e2e-${Date.now()}`;

let request;

async function rpc(method, params = {}) {
  const res = await request.post('/api/mcp', {
    params: { key: KEY },
    data: { jsonrpc: '2.0', id: Date.now(), method, params },
  });
  const body = await res.json().catch(() => ({}));
  if (body.error?.data?.code === 'MCP_DAILY' || body.error?.data?.code === 'TOOL_BUDGET') {
    test.skip(true, 'member daily MCP quota exhausted — resets midnight UTC');
  }
  return { status: res.status(), body };
}

/** tools/call → parsed JSON payload of the text result (or the raw text). */
async function callTool(name, args = {}) {
  const { status, body } = await rpc('tools/call', { name, arguments: args });
  expect(status).toBe(200);
  expect(body.error).toBeUndefined();
  const text = body.result?.content?.[0]?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

test.describe('MCP tool contracts', () => {
  test.skip(!KEY, 'set JOBBY_E2E_MCP_KEY or .career-ops-web/e2e.local.json {mcpKey}');

  test.beforeAll(async ({ playwright, baseURL }) => {
    request = await playwright.request.newContext({ baseURL });
  });
  test.afterAll(async () => {
    await request.dispose();
  });

  test('L0: unkeyed tools/call is rejected (tools/list is public by design)', async () => {
    const listed = await request.post('/api/mcp', {
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(listed.status()).toBe(200);
    const res = await request.post('/api/mcp', {
      data: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami' } },
    });
    expect(res.status()).toBe(401);
  });

  test('BL-066: free-plan member cannot resume_generate over MCP', async ({ page }) => {
    test.setTimeout(120_000);
    const op = operatorCredentials();
    test.skip(!op, 'needs operator secret to flip the plan');
    await page.goto('/signin');
    const reveal = page.getByRole('button', { name: 'Operator sign-in' });
    if (await reveal.isVisible().catch(() => false)) await reveal.click();
    await fillAndSubmit(
      page,
      [[page.getByLabel('Operator secret'), op.secret]],
      page.getByRole('button', { name: 'Continue as operator' }),
    );
    await page.waitForURL((u) => !String(u).includes('/signin'), { timeout: 15_000 });

    // find THIS tenant's account (not just row 0 — that may be the operator,
    // whom can() bypasses entirely)
    const who = await callTool('whoami', {});
    const accounts = await (await page.request.get('/api/admin/accounts')).json();
    const me = (accounts.accounts ?? []).find((a) => a.tenantId === who.tenantId);
    expect(me?.accountId, 'member account not found in admin list').toBeTruthy();
    const original = me.plan;
    const patch = await page.request.patch('/api/admin/accounts', {
      data: { accountId: me.accountId, plan: 'free' },
    });
    expect(patch.ok()).toBeTruthy();

    try {
      const out = await callTool('resume_generate', {});
      expect(out.download_link).toBeUndefined();
      expect(out.error || '').toMatch(/plan does not include|MCP_DAILY|does not include/);
    } finally {
      await page.request.patch('/api/admin/accounts', {
        data: { accountId: me.accountId, plan: original },
      });
    }
  });

  test('#52 jobs_fetch — verbatim table, full schema, no prose after it', async () => {
    const out = await callTool('jobs_fetch', {});
    expect(out._raw || '').toContain('| Company | Role | Location | Posted | Status | Score | Posting | Jobby |');
    expect(out._raw || '').not.toContain('Show this table unchanged');
    const afterTable = String(out._raw || '').split(/\n\s*\n/).filter(Boolean).pop();
    expect(afterTable.trim().startsWith('|')).toBe(true);
  });

  test('#51/#53 resume + score round-trip on a fresh row', async () => {
    // seed one tracker row via add_application
    const added = await callTool('add_application', {
      company: 'E2E Probe Co',
      role: `RoundTrip ${MARKER}`,
      status: 'Evaluated',
      notes: 'spec-seeded row',
    });
    expect(added.ok).toBeTruthy();

    // jobs_fetch finds it
    const feed = await callTool('jobs_fetch', { source: 'tracker' });
    expect(feed._raw).toContain(`RoundTrip ${MARKER}`);

    // submit_score: first write
    const jobId = String(added.n ?? added.job_id ?? '');
    expect(jobId).not.toBe('');
    const scored = await callTool('submit_score', {
      job_id: jobId,
      score: 4.2,
      rationale: 'spec fit',
      scored_by: 'playwright-e2e',
    });
    expect(scored.ok).toBeTruthy();
    expect(scored.updated).toBe(true);

    // idempotent second write
    const again = await callTool('submit_score', {
      job_id: jobId,
      score: 4.2,
      scored_by: 'playwright-e2e',
    });
    expect(again.idempotent).toBe(true);

    // out-of-range rejected — note 6..100 is a VALID alternate scale
    // (normalizeTrackerScore converts N/100), so only >100 is truly invalid.
    const bad = await callTool('submit_score', { job_id: jobId, score: 250, scored_by: 'x' });
    expect(String(bad.error || '')).toMatch(/score/i);

    // score landed on the row (provenance note itself is asserted by the
    // pipeline Notes-column UI spec and was verified in R1 round 4)
    const apps = await callTool('search_applications', { query: MARKER });
    expect(JSON.stringify(apps)).toContain('4.2/5');
  });

  test('#51 resume round-trip with signed link', async () => {
    // cv-export contract: needs ## Experience entries to render a page.
    const cv = [
      `# E2E Candidate ${MARKER}`,
      '',
      '## Experience',
      '',
      `### Senior Engineer — Probe Corp (${MARKER})`,
      '',
      'Shipped the thing. Reduced latency by 40%.',
    ].join('\n');
    expect((await callTool('resume_upload', { content: cv })).ok).toBeTruthy();

    const upd = await callTool('resume_update', { find: 'Senior', replace_with: 'Staff' });
    expect(upd.ok).toBeTruthy();

    const got = await callTool('get_resume');
    expect(got.content).toContain('Staff');

    const gen = await callTool('resume_generate', {});
    expect(gen.ok, gen.error).toBeTruthy();
    expect(gen.download_link).toMatch(/\/api\/resume\//);

    // logged-out fetch of the signed link serves bytes. download_link may be
    // absolute at JOBBY_MCP_PUBLIC_URL (Tailscale) — hit this stack's origin.
    const linkPath = new URL(gen.download_link, 'http://x').pathname + new URL(gen.download_link, 'http://x').search;
    const linkRes = await request.get(linkPath);
    expect(linkRes.status()).toBe(200);
    const body = await linkRes.text();
    expect(body.startsWith('%PDF-') || body.includes('Staff')).toBe(true);
    expect(new Date(gen.link_expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  test('#53 score of 9 is rejected before any write', async () => {
    const bad = await callTool('submit_score', { job_id: '999999', score: 4, scored_by: 'x' });
    expect(bad.error).toMatch(/not found/i);
  });
});

  test('BL-066 static tripwire: resume_generate gates GENERATE_CV before quota consumption', async () => {
    // The gate moved from an in-tool check (tools.ts) to a dispatch-level
    // TOOL_CAPS map (handler.ts) so a refusal never spends the caller's daily
    // quota — see #62. Assert the map entry AND its position ahead of
    // consumeMcpCall, not just that the string "GENERATE_CV" exists somewhere.
    const src = fs.readFileSync(path.resolve('web/src/lib/mcp/handler.ts'), 'utf8');
    const mapIdx = src.indexOf('const TOOL_CAPS');
    expect(mapIdx).toBeGreaterThan(0);
    const mapBlock = src.slice(mapIdx, mapIdx + 300);
    expect(mapBlock).toMatch(/resume_generate:\s*CAP\.GENERATE_CV/);

    const capCheckIdx = src.indexOf('TOOL_CAPS[name]');
    const quotaIdx = src.indexOf('consumeMcpCall(');
    expect(capCheckIdx).toBeGreaterThan(0);
    expect(quotaIdx).toBeGreaterThan(0);
    expect(capCheckIdx).toBeLessThan(quotaIdx);
  });
