import { test, expect } from 'playwright/test';
import { execFileSync } from 'node:child_process';
import { memberCredentials, operatorCredentials, secondMemberCredentials } from './credentials.mjs';
import { fillAndSubmit } from './auth.helpers.mjs';

const member = memberCredentials();
const memberB = secondMemberCredentials();
const operator = operatorCredentials();
let keyPage;
let readKey;
let writeKey;
let readKeyName;
let readKeyId;
let writeKeyId;
let memberAccount;

function rpc(request, token, method, params = {}) {
  return request.post('/api/mcp', {
    params: { key: token },
    data: { jsonrpc: '2.0', id: Date.now(), method, params },
  });
}

async function callTool(request, token, name, args = {}) {
  const response = await rpc(request, token, 'tools/call', { name, arguments: args });
  const body = await response.json();
  if (body.error?.data?.code === 'MCP_DAILY' || body.error?.data?.code === 'TOOL_BUDGET') {
    test.skip(true, 'member daily MCP quota exhausted — resets midnight UTC');
  }
  return { response, body };
}

async function signIn(page, credentials) {
  if (!/\/signin/.test(page.url())) {
    try {
      await page.goto('/signin', { waitUntil: 'domcontentloaded' });
    } catch (err) {
      if (!/ERR_ABORTED/.test(String(err)) || !/\/signin/.test(page.url())) throw err;
    }
  }
  if (!page.url().includes('/signin')) return;

  const tab = page.getByRole('tab', { name: 'Sign in' });
  if (await tab.isVisible().catch(() => false)) {
    const isSelected = await tab.getAttribute('aria-selected');
    if (isSelected !== 'true') {
      await tab.click();
    }
  }

  const email = page.getByLabel('Email');
  const password = page.getByLabel('Password');
  const submit = page.getByRole('button', { name: 'Sign in', exact: true });

  await fillAndSubmit(page, [[email, credentials.email], [password, credentials.password]], submit);
  // Landing anywhere off /signin is success. A `waitForURL` strictly past
  // /signin can miss an intermediate render under load; wait on the nav
  // instead, and tolerate a brief time for the session cookie to land.
  await expect(page).not.toHaveURL(/\/signin/, { timeout: 25_000 });
}

/** Markdown table body only — search headings echo the query even at count (0). */
function trackerDataRows(text) {
  return (text || '')
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.includes('| ---') && !/^\| Company \|/.test(line))
    .join('\n');
}

/** Every key this suite mints carries this prefix, and nothing else may be revoked. */
const QA_KEY_PREFIX = 'access-matrix-';

/**
 * Reclaim capacity left behind by an earlier run.
 *
 * createToken enforces MAX_MCP_KEYS = 5 live keys per tenant
 * (scripts/mcp-tokens.mjs), and this suite only revokes its keys in a `finally`.
 * A run killed mid-flight therefore leaks one, and after five interruptions the
 * cross-tenant test can no longer mint at all — it fails with a 409 that looks
 * like a product bug and is not one. Cleaning up on the way in makes the suite
 * repeatable; cleaning up only on the way out never could.
 */
/**
 * Keys minted by THIS run. They are off-limits to the reclaimer: the read and
 * write keys are minted in beforeAll and stay live for the whole file, so a
 * naive "revoke every access-matrix- key" would kill the fixtures the later
 * tests are still using and turn their calls into 401s.
 */
const mintedThisRun = new Set();

async function reclaimQaKeys(page) {
  const listed = await page.request.get('/api/account/mcp');
  if (listed.status() !== 200) return 0;
  const { keys = [] } = await listed.json();
  const stale = keys.filter(
    (key) =>
      key.status === 'live' &&
      String(key.name || '').startsWith(QA_KEY_PREFIX) &&
      !mintedThisRun.has(key.id),
  );
  for (const key of stale) {
    await page.request.delete(`/api/account/mcp?id=${encodeURIComponent(key.id)}`).catch(() => {});
  }
  return stale.length;
}

async function mint(page, name, scope) {
  let response = await page.request.post('/api/account/mcp', {
    data: { name, scope, expires: '7d' },
  });
  if (response.status() === 409) {
    // At the live-key cap. Retry once, but only after clearing keys left by an
    // EARLIER run — a 409 that survives that is a real conflict and must fail.
    const reclaimed = await reclaimQaKeys(page);
    expect(reclaimed, 'live-key cap reached and no reclaimable key from a previous run exists').toBeGreaterThan(0);
    response = await page.request.post('/api/account/mcp', {
      data: { name, scope, expires: '7d' },
    });
  }
  expect(response.status()).toBe(200);
  const minted = await response.json();
  if (minted?.id) mintedThisRun.add(minted.id);
  return minted;
}

test.describe('MCP multi-level access matrix', () => {
  test.skip(!member, 'member credentials required');

  test.beforeAll(async ({ browser, baseURL }) => {
    keyPage = await browser.newPage({ baseURL });
    await signIn(keyPage, member);
    memberAccount = await (await keyPage.request.get('/api/account')).json();
    const listed = await keyPage.request.get('/api/account/mcp');
    const existing = await listed.json();
    for (const key of existing.keys || []) {
      if (String(key.name || '').startsWith('access-matrix-')) {
        await keyPage.request.delete('/api/account/mcp?id=' + encodeURIComponent(key.id));
      }
    }
    readKeyName = `access-matrix-read-${Date.now()}`;
    const read = await mint(keyPage, readKeyName, 'read');
    const write = await mint(keyPage, `access-matrix-write-${Date.now()}`, 'read-write');
    readKey = read.token;
    readKeyId = read.id;
    writeKey = write.token;
    writeKeyId = write.id;
  });

  test.afterAll(async () => {
    for (const id of [readKeyId, writeKeyId]) {
      if (id) await keyPage.request.delete('/api/account/mcp?id=' + encodeURIComponent(id)).catch(() => {});
    }
    await keyPage?.close();
  });

  test('L0 anonymous can list tools but cannot call one', async ({ request }) => {
    const listed = await rpc(request, '', 'tools/list');
    expect(listed.status()).toBe(200);
    const called = await rpc(request, '', 'tools/call', { name: 'whoami', arguments: {} });
    expect(called.status()).toBe(401);
  });

  test('L2 read key reads but cannot mutate tenant data', async ({ request }) => {
    const identity = await callTool(request, readKey, 'whoami');
    expect(identity.response.status()).toBe(200);
    expect(identity.body.result?.isError).not.toBe(true);

    const marker = `readonly-denied-${Date.now()}`;
    const denied = await callTool(request, readKey, 'add_application', {
      company: marker,
      role: 'Must not persist',
      status: 'Evaluated',
    });
    expect(denied.response.status()).toBe(200);
    expect(denied.body.result?.isError).toBe(true);
    expect(denied.body.result?.content?.[0]?.text).toContain('read-only');

    for (const [tool, args] of [
      ['resume_update', { find: 'never-used', replace_with: 'never-written' }],
      ['submit_score', { job_id: '1', score: 1, scored_by: 'read-only-qa' }],
    ]) {
      const refused = await callTool(request, readKey, tool, args);
      expect(refused.response.status()).toBe(200);
      expect(refused.body.result?.isError).toBe(true);
      expect(refused.body.result?.content?.[0]?.text).toContain('read-only');
    }

    const searched = await callTool(request, readKey, 'search_applications', { query: marker });
    expect(searched.body.result?.content?.[0]?.text || '').toContain('(0)');
  });

  test('L2 read-write key can mutate its own tenant', async ({ request }) => {
    const marker = `readwrite-allowed-${Date.now()}`;
    const written = await callTool(request, writeKey, 'add_application', {
      company: marker,
      role: 'Scoped key QA',
      status: 'Evaluated',
    });
    expect(written.response.status()).toBe(200);
    expect(written.body.result?.isError).not.toBe(true);

    const searched = await callTool(request, readKey, 'search_applications', { query: marker });
    expect(searched.body.result?.content?.[0]?.text || '').toContain(marker);
  });

  test('L2 expired key returns 401 and frees the live-key cap', async ({ request }) => {
    const temporaryIds = [];
    execFileSync(process.execPath, ['scripts/qa-expire-key.mjs', readKeyName, '--days=1'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    try {
      const rejected = await callTool(request, readKey, 'whoami');
      expect(rejected.response.status()).toBe(401);
      expect(rejected.body.error).toBe('expired — mint a fresh key under Account → MCP');

      const listed = await keyPage.request.get('/api/account/mcp');
      expect(listed.status()).toBe(200);
      const snapshot = await listed.json();
      const expired = snapshot.keys.find((key) => key.id === readKeyId);
      expect(expired?.status).toBe('expired');
      expect(expired?.expiresInDays).toBe(0);

      // Fill document rows to the nominal cap while leaving one slot free in
      // LIVE-key terms. This catches the UI bug where an expired row was still
      // counted by keys.length and disabled Add forever.
      const neededRows = Math.max(0, snapshot.maxKeys - snapshot.keys.length);
      for (let i = 0; i < neededRows; i += 1) {
        const filler = await mint(keyPage, `access-matrix-expiry-fill-${Date.now()}-${i}`, 'read-write');
        temporaryIds.push(filler.id);
      }

      await keyPage.goto('/connect');
      const expiredRow = keyPage.getByRole('row').filter({ hasText: readKeyName });
      await expect(expiredRow.getByText('expired', { exact: true })).toBeVisible();
      await expect(expiredRow).toContainText('0d');

      await keyPage.getByLabel('Name for new key').fill(`access-matrix-after-expiry-${Date.now()}`);
      const add = keyPage.getByRole('button', { name: 'Add key' });
      await expect(add).toBeEnabled();
      const response = keyPage.waitForResponse(
        (res) => new URL(res.url()).pathname === '/api/account/mcp' && res.request().method() === 'POST',
      );
      await add.click();
      const replacement = await response;
      expect(replacement.status()).toBe(200);
      temporaryIds.push((await replacement.json()).id);
    } finally {
      for (const id of temporaryIds) {
        if (id) await keyPage.request.delete('/api/account/mcp?id=' + encodeURIComponent(id)).catch(() => {});
      }
    }
  });

  test('L2 revoked key is rejected while another key remains live', async ({ request }) => {
    const revoked = await keyPage.request.delete('/api/account/mcp?id=' + encodeURIComponent(readKeyId));
    expect(revoked.status()).toBe(200);
    readKeyId = null;

    const oldCall = await callTool(request, readKey, 'whoami');
    expect(oldCall.response.status()).toBe(401);
    const liveCall = await callTool(request, writeKey, 'whoami');
    expect(liveCall.response.status()).toBe(200);
  });

  test('L2 two-member tokens cannot cross tenant boundaries', async ({ browser, request, baseURL }) => {
    test.skip(!memberB, 'set JOBBY_E2E_MEMBER_B_EMAIL/PASSWORD');
    const pageB = await browser.newPage({ baseURL });
    await signIn(pageB, memberB);
    const mintedB = await mint(pageB, `access-matrix-member-b-${Date.now()}`, 'read-write');
    const markerB = `tenant-b-${Date.now()}`;
    const markerA = `tenant-a-${Date.now()}`;
    try {
      await callTool(request, writeKey, 'add_application', { company: markerA, role: 'Tenant A', status: 'Evaluated' });
      await callTool(request, mintedB.token, 'add_application', { company: markerB, role: 'Tenant B', status: 'Evaluated' });

      const aSeesB = await callTool(request, writeKey, 'search_applications', { query: markerB });
      const bSeesA = await callTool(request, mintedB.token, 'search_applications', { query: markerA });
      // Search headings echo `q:<marker> (0)` even when the table is empty.
      // Isolation is row-level: opposite tenant must not list the marker as a company.
      const aText = aSeesB.body.result?.content?.[0]?.text || '';
      const bText = bSeesA.body.result?.content?.[0]?.text || '';
      expect(aText).toMatch(/\(0\)/);
      expect(bText).toMatch(/\(0\)/);
      expect(trackerDataRows(aText)).not.toContain(markerB);
      expect(trackerDataRows(bText)).not.toContain(markerA);

      const identityB = await callTool(request, mintedB.token, 'whoami');
      const expectedTenant = JSON.parse(identityB.body.result.content[0].text).tenantId;
      const forcedTenant = await request.post('/api/mcp', {
        params: { key: mintedB.token, tenantId: 't_evil' },
        data: { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
      });
      const forcedBody = await forcedTenant.json();
      expect(JSON.parse(forcedBody.result.content[0].text).tenantId).toBe(expectedTenant);

      const foreignRevoke = await keyPage.request.delete('/api/account/mcp?id=' + encodeURIComponent(mintedB.id));
      expect(foreignRevoke.status()).toBe(404);
      expect((await callTool(request, mintedB.token, 'whoami')).response.status()).toBe(200);
    } finally {
      await pageB.request.delete('/api/account/mcp?id=' + encodeURIComponent(mintedB.id)).catch(() => {});
      await pageB.close();
    }
  });

  test('L1 suspended member loses MCP access and is restored', async ({ browser, request, baseURL }) => {
    test.setTimeout(180_000);
    test.skip(!operator, 'operator credentials required');
    const page = await browser.newPage({ baseURL });
    await page.goto('/signin');
    const reveal = page.getByRole('button', { name: 'Operator sign-in' });
    if (await reveal.isVisible().catch(() => false)) await reveal.click();
    await fillAndSubmit(
      page,
      [[page.getByLabel('Operator secret'), operator.secret]],
      page.getByRole('button', { name: 'Continue as operator' }),
    );
    await page.waitForURL((url) => !url.href.includes('/signin'));
    const accounts = await (await page.request.get('/api/admin/accounts')).json();
    const target = accounts.accounts.find((account) => account.tenantId === memberAccount.tenantId);
    test.skip(!target, 'member account not found in operator account list');
    try {
      // One authenticated member page; a second concurrent sign-in for the same
      // account would bump sessionVersion and invalidate the first mid-test.
      const memberContext = await browser.newContext({ baseURL });
      const memberPage = await memberContext.newPage();
      await signIn(memberPage, member);

      try {
        const suspended = await page.request.patch('/api/admin/accounts', { data: { accountId: target.accountId, status: 'suspended' } });
        expect(suspended.status()).toBe(200);
        expect((await callTool(request, writeKey, 'whoami')).response.status()).toBe(401);

        // Stale JWT after sessionVersion bump must land on sign-in, never loop
        // / ↔ /signin (ERR_TOO_MANY_REDIRECTS). The product drops the cookie.
        await memberPage.goto('/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await expect(memberPage).toHaveURL(/\/signin/);
        await expect(memberPage.getByRole('heading', { name: /sign in/i })).toBeVisible();
      } finally {
        await memberContext.close();
      }

      // Reactivate BEFORE attempting the restore sign-in. The outer finally
      // also reactivates as a safety net, but this is the point of the journey:
      // an active account must be able to sign back in.
      const reactivated = await page.request.patch('/api/admin/accounts', {
        data: { accountId: target.accountId, status: 'active' },
      });
      expect(reactivated.status()).toBe(200);

      // Reactivated: a fresh sign-in in a clean context must succeed.
      const restoreContext = await browser.newContext({ baseURL });
      const restorePage = await restoreContext.newPage();
      // The status flip can lag one round-trip; retry the sign-in so a stale
      // `active` read on the first attempt doesn't fail a healthy restore.
      await expect
        .poll(
          async () => {
            await restorePage.goto('/signin', { waitUntil: 'domcontentloaded' });
            if (restorePage.url().includes('/signin')) {
              const tab = restorePage.getByRole('tab', { name: 'Sign in' });
              if (await tab.isVisible().catch(() => false)) {
                if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
              }
              await fillAndSubmit(
                restorePage,
                [
                  [restorePage.getByLabel('Email'), member.email],
                  [restorePage.getByLabel('Password'), member.password],
                ],
                restorePage.getByRole('button', { name: 'Sign in', exact: true }),
              );
            }
            await restorePage.waitForTimeout(500);
            return restorePage.url();
          },
          { message: 'reactivated member should be able to sign back in' },
        )
        .not.toMatch(/\/signin/, { timeout: 40_000 });
      await restoreContext.close();
    } finally {
      await page.request.patch('/api/admin/accounts', { data: { accountId: target.accountId, status: 'active' } });
      await page.close();
    }
  });

  test('L3 and L4 plan changes preserve member isolation and apply limits', async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    test.skip(!operator, 'operator credentials required');
    const page = await browser.newPage({ baseURL });
    await page.goto('/signin');
    const reveal = page.getByRole('button', { name: 'Operator sign-in' });
    if (await reveal.isVisible().catch(() => false)) await reveal.click();
    await fillAndSubmit(
      page,
      [[page.getByLabel('Operator secret'), operator.secret]],
      page.getByRole('button', { name: 'Continue as operator' }),
    );
    await page.waitForURL((url) => !url.href.includes('/signin'));
    const accounts = await (await page.request.get('/api/admin/accounts')).json();
    const target = accounts.accounts.find((account) => account.tenantId === memberAccount.tenantId);
    test.skip(!target, 'member account not found in operator account list');
    try {
      for (const [plan, expectedLimit] of [['basic', 120], ['advanced', 500]]) {
        const changed = await page.request.patch('/api/admin/accounts', { data: { accountId: target.accountId, plan } });
        expect(changed.status()).toBe(200);
        const memberPage = await browser.newPage({ baseURL });
        await signIn(memberPage, member);
        const ownKeys = await memberPage.request.get('/api/account/mcp');
        expect(ownKeys.status()).toBe(200);
        expect((await ownKeys.json()).kpi.mcp.limit).toBe(expectedLimit);
        const forbidden = await memberPage.request.get('/api/admin/accounts');
        expect(forbidden.status()).toBe(403);
        if (plan === 'basic') {
          const generated = await callTool(memberPage.request, writeKey, 'resume_generate');
          expect(generated.response.status()).toBe(200);
          expect(generated.body.result?.isError).not.toBe(true);
          expect(generated.body.result?.content?.[0]?.text || '').not.toMatch(/plan does not include/i);
        }
        await memberPage.close();
      }
    } finally {
      await page.request.patch('/api/admin/accounts', { data: { accountId: target.accountId, plan: memberAccount.plan } });
      await page.close();
    }
  });

  test('L5 operator sees account metadata but no MCP secrets or tenant content', async ({ browser, baseURL }) => {
    test.skip(!operator, 'operator credentials required');
    const page = await browser.newPage({ baseURL });
    await page.goto('/signin');
    const reveal = page.getByRole('button', { name: 'Operator sign-in' });
    if (await reveal.isVisible().catch(() => false)) await reveal.click();
    await fillAndSubmit(
      page,
      [[page.getByLabel('Operator secret'), operator.secret]],
      page.getByRole('button', { name: 'Continue as operator' }),
    );
    await page.waitForURL((url) => !url.href.includes('/signin'));

    const accounts = await page.request.get('/api/admin/accounts');
    expect(accounts.status()).toBe(200);
    const text = await accounts.text();
    expect(text).not.toContain(writeKey);
    expect(text).not.toContain('Scoped key QA');

    await page.goto('/admin');
    const accountButton = page.getByRole('button', { name: new RegExp(memberAccount.tenantId) });
    await expect(accountButton).toBeVisible();
    await accountButton.click();
    await expect(page.getByText('Loading usage…')).toHaveCount(0);
    const usage = page
      .getByText('No scan or usage events yet.')
      .or(page.getByRole('columnheader', { name: 'Outcome' }))
      .first();
    await expect(usage).toBeVisible();
    await page.close();
  });
});
