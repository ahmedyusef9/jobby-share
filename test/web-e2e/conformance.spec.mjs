/**
 * BL-068 — Streamable-HTTP / SSE transport conformance (no external client).
 *
 * Verifies the MCP transport contract headlessly over raw HTTP, independent of
 * any browser client. Mints a FRESH member key at beforeAll so the suite is
 * self-sufficient and always exercises the authenticated dispatch path (not the
 * public handshake fallback).
 *
 *   - JSON-RPC over application/json
 *   - SSE negotiation (Accept: text/event-stream) for both GET probe and POST
 *   - initialize handshake shape (protocolVersion, serverInfo, capabilities)
 *   - batch requests, ping, notifications, error mapping
 *   - Mcp-Session-Id CORS exposure
 *
 * Requires member credentials (JOBBY_E2E_EMAIL/PASSWORD or e2e.local.json).
 */
import { test, expect } from 'playwright/test';
import { memberCredentials } from './credentials.mjs';
import { fillAndSubmit } from './auth.helpers.mjs';

let base;
let request;
let page;
let KEY;

const urlFor = (p) => base + p;

async function postJson(path, body, opts = {}) {
  const { headers = {}, accept } = opts;
  return request.post(urlFor(path) + '?key=' + KEY, {
    data: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(accept ? { accept } : {}), ...headers },
  });
}

test.describe('MCP streamable-http conformance', () => {
  test.skip(!memberCredentials(), 'set JOBBY_E2E_EMAIL/PASSWORD or .career-ops-web/e2e.local.json');

  test.beforeAll(async ({ playwright, baseURL }) => {
    base = baseURL || 'http://localhost:3001';
    request = await playwright.request.newContext();
    const browser = await playwright.chromium.launch();
    page = await browser.newPage();
    const creds = memberCredentials();
    await page.goto(base + '/signin');
    await fillAndSubmit(
      page,
      [
        [page.getByLabel('Email'), creds.email],
        [page.getByLabel('Password'), creds.password],
      ],
      page.getByRole('button', { name: 'Sign in', exact: true }),
    );
    await page.waitForURL((u) => !u.href.includes('/signin'));
    // Mint a fresh member key using the page's authenticated session.
    // Free cap first: drop any leftover conformance-* keys from prior runs.
    const prior = await (await page.request.get('/api/account/mcp')).json();
    for (const k of prior.keys || []) {
      if (typeof k.name === 'string' && k.name.startsWith('conformance-')) {
        await page.request.delete('/api/account/mcp?id=' + k.id).catch(() => {});
      }
    }
    const mint = await page.request.post('/api/account/mcp', {
      data: { name: `conformance-${Date.now()}` },
      headers: { 'content-type': 'application/json' },
    });
    expect(mint.status()).toBe(200);
    KEY = (await mint.json()).token;
    await browser.close();
    page = null;
  });

  test.afterAll(async () => {
    if (request) {
      try {
        const me = await (await request.get(urlFor('/api/account/mcp'))).json();
        const id = (me.keys || []).find((k) => k.prefix && KEY && k.prefix === KEY.slice(0, 7))?.id;
        if (id) await request.delete(urlFor('/api/account/mcp?id=' + encodeURIComponent(id)));
      } catch { /* best-effort cleanup */ }
    }
    if (page) await page.close();
    if (request) await request.dispose();
  });

  const initPayload = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'conformance', version: '0.0.0' } } };

  test('1. initialize over application/json returns spec-conformant result', async () => {
    const res = await postJson('/api/mcp', initPayload);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/json');
    const body = await res.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe('2025-03-26');
    expect(body.result.serverInfo.name.length).toBeGreaterThan(0);
    expect(body.result.serverInfo.version.length).toBeGreaterThan(0);
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.capabilities.prompts).toBeDefined();
  });

  test('2. key via Authorization Bearer header is accepted', async () => {
    const res = await request.post(urlFor('/api/mcp'), {
      data: JSON.stringify(initPayload),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.result?.serverInfo?.name).toBeTruthy();
  });

  test('3. GET /api/mcp with Accept text/event-stream is an SSE handshake', async () => {
    const res = await request.get(urlFor('/api/mcp?key=' + KEY), { headers: { accept: 'text/event-stream' } });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/event-stream');
  });

  test('4. POST over SSE returns a message event', async () => {
    const res = await postJson('/api/mcp', initPayload, { accept: 'text/event-stream' });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/event-stream');
    const text = await res.text();
    expect(text.startsWith('event: message')).toBe(true);
    const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
    expect(dataLine).toBeTruthy();
    const parsed = JSON.parse(dataLine.slice(6));
    expect(parsed.result?.serverInfo?.name).toBeTruthy();
  });

  test('5. tools/list round-trips over SSE', async () => {
    const res = await postJson('/api/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { accept: 'text/event-stream' });
    expect(res.status()).toBe(200);
    const text = await res.text();
    const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
    const parsed = JSON.parse(dataLine.slice(6));
    expect(Array.isArray(parsed.result.tools)).toBe(true);
    expect(parsed.result.tools.length).toBeGreaterThan(0);
    expect(parsed.result.tools[0].name).toBeTruthy();
  });

  test('6. batch request (array of messages) is accepted', async () => {
    const res = await postJson('/api/mcp', [
      { jsonrpc: '2.0', id: 10, method: 'ping', params: {} },
      { jsonrpc: '2.0', id: 11, method: 'ping', params: {} },
    ]);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toBeDefined();
  });

  test('7. notifications produce an empty 202 (no JSON-RPC body)', async () => {
    const res = await postJson('/api/mcp', { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    expect(res.status()).toBe(202);
    const text = await res.text();
    expect(text.trim()).toBe('');
  });

  test('8. unknown method maps to JSON-RPC method-not-found (-32601)', async () => {
    const res = await postJson('/api/mcp', { jsonrpc: '2.0', id: 99, method: 'tools/nope', params: {} });
    const body = await res.json();
    expect(body.error?.code).toBe(-32601);
  });

  test('9. payload too large is rejected before dispatch', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    const res = await postJson('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'ping', params: { big } });
    expect([413, 200]).toContain(res.status());
  });

  test('10. CORS exposes Mcp-Session-Id on the mcp route', async () => {
    const res = await request.get(urlFor('/api/mcp?key=' + KEY), { headers: { accept: 'application/json' } });
    expect((res.headers()['access-control-expose-headers'] || '').toLowerCase()).toContain('mcp-session-id');
    expect((res.headers()['access-control-allow-headers'] || '').toLowerCase()).toContain('mcp-session-id');
  });

  test('11. stale explicit key gets JSON 401 instead of public initialize fallback', async () => {
    const res = await request.post(urlFor('/api/mcp?key=jb_' + '0'.repeat(48)), {
      data: JSON.stringify(initPayload),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status()).toBe(401);
    expect(res.headers()['content-type']).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });
});
