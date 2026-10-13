import { test, expect } from 'playwright/test';
import { memberCredentials } from './credentials.mjs';
import { fillAndSubmit } from './auth.helpers.mjs';

const PUBLIC_URL = (process.env.JOBBY_MCP_PUBLIC_URL || process.env.JOBBY_E2E_BASE_URL || '').replace(/\/$/, '');
const MCP_ONLY_URL = (process.env.JOBBY_MCP_PUBLIC_URL || '').replace(/\/$/, '');
let request;
let key;
let keyId;
let keyManagementBase;

function external(path, body, method = 'POST') {
  return request[method === 'GET' ? 'get' : 'post'](PUBLIC_URL + path, {
    data: body ? JSON.stringify(body) : undefined,
    headers: { 'content-type': 'application/json', accept: method === 'GET' ? 'text/event-stream' : 'application/json' },
  });
}

test.describe('External-vantage MCP Funnel', () => {
  test.skip(!PUBLIC_URL, 'set JOBBY_E2E_BASE_URL or JOBBY_MCP_PUBLIC_URL');
  test.skip(!memberCredentials(), 'set member credentials');

  test.beforeAll(async ({ playwright, baseURL }) => {
    request = await playwright.request.newContext();
    const browser = await playwright.chromium.launch();
    const page = await browser.newPage();
    const creds = memberCredentials();
    const appBase = (baseURL || PUBLIC_URL).replace(/\/$/, '');

    await page.goto(appBase + '/signin');
    await fillAndSubmit(
      page,
      [
        [page.getByLabel('Email'), creds.email],
        [page.getByLabel('Password'), creds.password],
      ],
      page.getByRole('button', { name: 'Sign in', exact: true }),
    );
    await page.waitForURL((url) => !url.href.includes('/signin'));

    keyManagementBase = appBase;
    const listed = await page.request.get(keyManagementBase + '/api/account/mcp');
    expect(listed.status()).toBe(200);
    const existing = await listed.json();
    for (const item of existing.keys || []) {
      if (String(item.name || '').startsWith('funnel-')) {
        await page.request.delete(keyManagementBase + '/api/account/mcp?id=' + encodeURIComponent(item.id)).catch(() => {});
      }
    }

    const minted = await page.request.post(keyManagementBase + '/api/account/mcp', {
      data: { name: `funnel-${Date.now()}` },
      headers: { 'content-type': 'application/json' },
    });
    expect(minted.status()).toBe(200);
    const payload = await minted.json();
    key = payload.token;
    keyId = payload.id;

    await browser.close();
  });

  test.afterAll(async ({ playwright, baseURL }) => {
    if (keyId) {
      const browser = await playwright.chromium.launch();
      const page = await browser.newPage();
      const creds = memberCredentials();
      const appBase = (baseURL || PUBLIC_URL).replace(/\/$/, '');
      await page.goto((keyManagementBase || appBase) + '/signin');
      await fillAndSubmit(
        page,
        [
          [page.getByLabel('Email'), creds.email],
          [page.getByLabel('Password'), creds.password],
        ],
        page.getByRole('button', { name: 'Sign in', exact: true }),
      );
      await page.waitForURL((url) => !url.href.includes('/signin'));
      await page.request.delete((keyManagementBase || appBase) + '/api/account/mcp?id=' + encodeURIComponent(keyId)).catch(() => {});
      await browser.close();
    }
    await request?.dispose();
  });

  test('GET SSE handshake works over the public URL', async () => {
    const response = await external('/api/mcp', null, 'GET');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/event-stream');
  });

  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } };

  test('initialize works through query authentication', async () => {
    const response = await external('/api/mcp?key=' + key, initialize);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.result.protocolVersion).toBe('2025-03-26');
    expect(body.result.serverInfo.version.length).toBeGreaterThan(0);
  });

  test('initialize works through one-link path authentication', async () => {
    const response = await external('/mcp/' + key, initialize);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.result.serverInfo.name).toBeTruthy();
  });

  test('tools/list works over the public URL', async () => {
    const response = await external('/api/mcp?key=' + key, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const body = await response.json();
    expect(body.result.tools.length).toBeGreaterThan(0);
  });

  test('whoami tools/call works over the public URL', async () => {
    const response = await external('/api/mcp?key=' + key, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.result?.content?.[0]?.text).toBeTruthy();
  });

  test('MCP-only host returns 404 for account, admin and dashboard routes', async () => {
    test.skip(!MCP_ONLY_URL, 'set JOBBY_MCP_PUBLIC_URL to the MCP-only origin');
    for (const path of ['/api/account', '/admin', '/dashboard', '/pipeline']) {
      const response = await request.get(MCP_ONLY_URL + path, { maxRedirects: 0 });
      expect(response.status(), path).toBe(404);
    }
  });
});
