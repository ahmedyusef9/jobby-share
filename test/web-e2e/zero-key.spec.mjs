/**
 * BL-062 — zero-key member experience e2e (#54 coverage).
 * Product rule (deploy/design/rbac-matrix.md): members run no AI through
 * jobby; every refusal surface points at Account → MCP.
 */
import { test, expect } from 'playwright/test';
import { loginMember, loginOperator } from './auth.helpers.mjs';
import { memberCredentials, operatorCredentials } from './credentials.mjs';

test.describe('L2 member: zero-key everywhere', () => {
  const member = memberCredentials();
  test.skip(!member, 'set JOBBY_E2E_EMAIL/PASSWORD or .career-ops-web/e2e.local.json');

  test('Config is keyless and points at MCP', async ({ page }) => {
    await loginMember(page);
    await page.goto('/config');
    await expect(page.getByText(/Zero-key release/)).toBeVisible();
    await expect(page.getByText('Paste an AI key')).toHaveCount(0);
  });

  test('Connect first paint waits for live key and KPI data', async ({ page }) => {
    await loginMember(page);
    await page.route('**/api/account/mcp', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.continue();
    });
    await page.goto('/connect');
    await expect(page.getByText(/Loading MCP account/)).toBeVisible();
    await expect(page.getByText(/Loading MCP account/)).toHaveCount(0);
    await expect(page.getByText(/No live key yet/)).toHaveCount(0);
    await expect(page.getByText('uncapped')).toHaveCount(0);
  });

  test('/api/clis returns the zero-key contract', async ({ page }) => {
    await loginMember(page); // fresh context per test — authenticate first
    const res = await page.request.get('/api/clis');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.clis).toEqual([]);
    expect(body.zeroKey).toBe(true);
  });

  test('assistant setup line points at MCP', async ({ page }) => {
    await loginMember(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Open assistant' }).click(); // floating "Ask" launcher
    const line = page
      .getByText(/Scoring runs in your own assistant/i)
      .or(page.getByText(/connect under Account → MCP/i))
      .first();
    await expect(line).toBeVisible();
  });

  test('admin area stays invisible', async ({ page }) => {
    await loginMember(page);
    const sidebar = page.getByRole('complementary');
    await expect(sidebar.getByRole('link', { name: 'Admin' })).toHaveCount(0);
    await page.goto('/admin/rbac');
    await expect(page.locator('body')).not.toContainText('Access control');
  });
});

test.describe('L5 operator: engines remain available', () => {
  const operator = operatorCredentials();
  test.skip(!operator, 'set JOBBY_OPERATOR_SECRET');

  test('operator Config keeps engine chooser + paste-key path', async ({ page }) => {
    await loginOperator(page);
    await page.goto('/config');
    await expect(page.getByText('Paste an AI key').first()).toBeVisible();
    await expect(page.getByText(/Use an AI tool you have/)).toBeVisible();
  });
});
