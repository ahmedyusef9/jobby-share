import { spawnSync } from 'node:child_process';
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from 'playwright/test';
import { loginMember, loginOperator } from './auth.helpers.mjs';
import { memberCredentials, operatorCredentials } from './credentials.mjs';
import { ConnectPage } from './pages/connect.page.mjs';

const KEY_PREFIX = 'connect-ui-';

test.describe('/connect member experience', () => {
  test.skip(!memberCredentials(), 'member credentials required');

  let connect;

  test.beforeEach(async ({ page }) => {
    await loginMember(page);
    connect = new ConnectPage(page);
    await connect.removeKeys(KEY_PREFIX);
  });

  test.afterEach(async () => {
    if (connect) await connect.removeKeys(KEY_PREFIX);
  });

  test('Show QR renders a PNG data URL', async ({ page }) => {
    await connect.open();
    await connect.addKey({ name: `${KEY_PREFIX}qr-${Date.now()}`, scope: 'read', expiry: '7d' });
    await page.getByRole('button', { name: 'Show QR' }).click();

    const qr = page.getByRole('img', { name: 'QR code for this Jobby MCP connection URL' });
    await expect(qr).toBeVisible();
    await expect(qr).toHaveAttribute('src', /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
  });

  test('minted token is shown exactly once and its row shows scope expiry and status', async ({ page }) => {
    const before = await (await page.request.get('/api/account/mcp')).json();
    const existingIds = new Set((before.keys || []).map((key) => key.id));
    const name = `${KEY_PREFIX}once-${Date.now()}`;

    await connect.open();
    const minted = await connect.addKey({ name, scope: 'read', expiry: '7d' });
    await expect(page.getByText(minted.token, { exact: true })).toBeVisible();

    const row = connect.keyRow(name);
    await expect(row).toContainText('read');
    await expect(row).toContainText('7d');
    await expect(row.getByText('live', { exact: true })).toBeVisible();
    for (const id of existingIds) expect(minted.keys.some((key) => key.id === id)).toBe(true);

    await page.getByRole('button', { name: 'Done — I copied it' }).click();
    await expect(page.getByText(minted.token, { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByText(minted.token, { exact: true })).toHaveCount(0);
    expect(await (await page.request.get('/api/account/mcp')).text()).not.toContain(minted.token);
  });

  test('/connect has no serious or critical axe violation', async ({ page }) => {
    await connect.open();
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    const violations = result.violations.filter((item) => ['serious', 'critical'].includes(item.impact));
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});

test('empty MCP body becomes a readable error', async ({ page }) => {
  test.skip(!operatorCredentials(), 'operator secret required');
  await loginOperator(page);
  await page.route('**/api/account/mcp', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '' });
      return;
    }
    await route.continue();
  });
  await page.goto('/connect');
  await expect(page.getByRole('alert').filter({ hasText: /Empty response|Could not load MCP/ })).toBeVisible();
  await expect(page.getByText('Unexpected end of JSON input')).toHaveCount(0);
});

test('key lifecycle keeps named keys and enforces rotation and cap', async () => {
  const result = spawnSync(process.execPath, ['--test', 'tests/mcp-tokens.test.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stdout).toContain('adding a second named key keeps the first');
  expect(result.stdout).toContain('rotate: true retires every prior key');
  expect(result.stdout).toContain('cap rejects a sixth live key');
});

test('operator default MCP keys skip Appwrite and member timeouts return empty', async () => {
  const local = spawnSync(process.execPath, ['--test', 'tests/mcp-tokens-local.test.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  expect(local.status, local.stderr || local.stdout).toBe(0);
  expect(local.stdout).toContain('operator default tenant mints without Appwrite');

  const timeout = spawnSync(process.execPath, ['--test', 'tests/mcp-tokens.test.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  expect(timeout.status, timeout.stderr || timeout.stdout).toBe(0);
  expect(timeout.stdout).toContain('listTokens returns empty when Appwrite times out');
});
