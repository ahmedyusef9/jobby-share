import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { test, expect } from 'playwright/test';
import * as yamlModule from 'js-yaml';
import { loginMember } from './auth.helpers.mjs';
import { memberCredentials } from './credentials.mjs';

const yaml = yamlModule.default || yamlModule;
const budgets = yaml.load(readFileSync('qa/performance-budgets.yml', 'utf8'));
const KEY_PREFIX = 'performance-';

function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

async function removePerformanceKeys(request) {
  const listed = await request.get('/api/account/mcp');
  if (listed.status() !== 200) return;
  const { keys = [] } = await listed.json();
  for (const key of keys.filter((item) => String(item.name || '').startsWith(KEY_PREFIX))) {
    await request.delete(`/api/account/mcp?id=${encodeURIComponent(key.id)}`).catch(() => {});
  }
}

test.describe('versioned performance budgets', () => {
  test.skip(!memberCredentials(), 'member credentials required');

  test('MCP tools/call p95 stays inside the load SLO', async ({ page }) => {
    test.setTimeout(90_000);
    await loginMember(page);
    await removePerformanceKeys(page.request);

    const created = await page.request.post('/api/account/mcp', {
      data: { name: `${KEY_PREFIX}${Date.now()}`, scope: 'read', expires: '1d' },
    });
    expect(created.status()).toBe(200);
    const key = await created.json();
    const budget = budgets.mcp_tools_call;
    let requestId = 0;

    const call = async () => {
      const started = performance.now();
      const response = await page.request.post(budget.endpoint, {
        params: { key: key.token },
        data: {
          jsonrpc: '2.0',
          id: ++requestId,
          method: 'tools/call',
          params: { name: budget.tool, arguments: {} },
        },
      });
      const body = await response.json().catch(() => null);
      return {
        elapsed: performance.now() - started,
        ok: response.status() === 200 && body?.result?.isError !== true,
      };
    };

    try {
      for (let i = 0; i < budget.warmup; i += 1) await call();

      const results = new Array(budget.samples);
      await Promise.all(
        Array.from({ length: budget.virtual_users }, async (_, worker) => {
          for (let index = worker; index < budget.samples; index += budget.virtual_users) {
            results[index] = await call();
          }
        }),
      );

      const p95 = percentile(results.map((result) => result.elapsed), 0.95);
      const errorRate = results.filter((result) => !result.ok).length / results.length;
      expect(errorRate, `MCP error rate ${errorRate}`).toBeLessThanOrEqual(budget.max_error_rate);
      expect(p95, `MCP tools/call p95 ${p95.toFixed(1)}ms`).toBeLessThanOrEqual(budget.p95_ms);
    } finally {
      if (key.id) await page.request.delete(`/api/account/mcp?id=${encodeURIComponent(key.id)}`).catch(() => {});
    }
  });

  test('/connect Web Vitals stay inside the versioned budget', async ({ page }) => {
    test.setTimeout(90_000);
    await loginMember(page);
    const budget = budgets.connect_web_vitals;

    await page.context().addInitScript(() => {
      window.__qaVitals = { cls: 0, fcp: 0, lcp: 0 };
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === 'first-contentful-paint') window.__qaVitals.fcp = entry.startTime;
        }
      }).observe({ type: 'paint', buffered: true });
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const latest = entries[entries.length - 1];
        if (latest) window.__qaVitals.lcp = latest.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) window.__qaVitals.cls += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });

    const samples = [];
    for (let i = 0; i < budget.samples; i += 1) {
      const measured = await page.context().newPage();
      await measured.goto(budget.route, { waitUntil: 'networkidle' });
      await measured.getByRole('heading', { name: 'MCP', exact: true }).waitFor();
      await measured.waitForTimeout(budget.settle_ms);
      samples.push(await measured.evaluate(() => window.__qaVitals));
      await measured.close();
    }

    for (const [index, sample] of samples.entries()) {
      expect(sample.fcp, `sample ${index + 1} recorded FCP`).toBeGreaterThan(0);
      expect(sample.lcp, `sample ${index + 1} recorded LCP`).toBeGreaterThan(0);
    }

    const fcpP75 = percentile(samples.map((sample) => sample.fcp), 0.75);
    const lcpP75 = percentile(samples.map((sample) => sample.lcp), 0.75);
    const clsP75 = percentile(samples.map((sample) => sample.cls), 0.75);
    expect(fcpP75, `/connect FCP p75 ${fcpP75.toFixed(1)}ms`).toBeLessThanOrEqual(budget.fcp_p75_ms);
    expect(lcpP75, `/connect LCP p75 ${lcpP75.toFixed(1)}ms`).toBeLessThanOrEqual(budget.lcp_p75_ms);
    expect(clsP75, `/connect CLS p75 ${clsP75.toFixed(3)}`).toBeLessThanOrEqual(budget.cls_p75);
  });
});
