/**
 * BL-060 smoke — proves the harness reaches the real stack at both access
 * levels. Deeper per-feature specs land with BL-061..063.
 */
import { test, expect } from 'playwright/test';
import { memberCredentials, operatorCredentials } from './credentials.mjs';
import { fillAndSubmit } from './auth.helpers.mjs';

const member = memberCredentials();
const operator = operatorCredentials();

test('L0: signed-out /pipeline lands on /signin', async ({ page }) => {
  await page.goto('/pipeline');
  await expect(page).toHaveURL(/\/signin/);
});

// ACCESS-L0-02. The member route above only proves a redirect; the operator
// routes have to prove a redirect AND that nothing operator-shaped shipped in
// the response that carried it. A signed-out visitor learning the RBAC matrix
// exists is already a leak, even if they cannot use it.
for (const route of ['/admin', '/admin/rbac']) {
  test(`L0: signed-out ${route} redirects and renders no operator surface`, async ({ page }) => {
    const response = await page.goto(route);
    await expect(page).toHaveURL(/\/signin/);
    expect(page.url()).toContain(`callbackUrl=${encodeURIComponent(route)}`);
    await expect(page.getByRole('heading', { name: /sign in or create your account/i })).toBeVisible();

    const body = page.locator('body');
    await expect(body).not.toContainText('Access control');
    await expect(body).not.toContainText('Permission matrix');
    await expect(page.getByRole('link', { name: 'Operator', exact: true })).toHaveCount(0);
    // The redirect itself must not have served operator HTML on the way past.
    expect(await response.text()).not.toMatch(/rbac-matrix|permission matrix/i);
  });
}

test.describe('member session', () => {
  test.skip(!member, 'set JOBBY_E2E_EMAIL/PASSWORD or .career-ops-web/e2e.local.json');

  test('L2: member sign-in leaves /signin and never sees admin matrix', async ({ page }) => {
    await page.goto('/signin');
    await fillAndSubmit(
      page,
      [
        [page.getByLabel('Email'), member.email],
        [page.getByLabel('Password'), member.password],
      ],
      page.getByRole('button', { name: 'Sign in', exact: true }),
    );
    await expect(page).not.toHaveURL(/signin/, { timeout: 15_000 });
    await page.goto('/admin/rbac');
    // members get a 404 page, by design — the route must not confirm it exists
    await expect(page.locator('body')).not.toContainText('Access control');
  });
});

test.describe('operator session', () => {
  test.skip(!operator, 'set JOBBY_OPERATOR_SECRET');

  test('L5: operator secret reaches the /admin/rbac matrix', async ({ page }) => {
    await page.goto('/signin');
    // The operator form hides behind a reveal link unless publicSignup is on.
    const reveal = page.getByRole('button', { name: 'Operator sign-in' });
    if (await reveal.isVisible().catch(() => false)) await reveal.click();
    await fillAndSubmit(
      page,
      [[page.getByLabel('Operator secret'), operator.secret]],
      page.getByRole('button', { name: 'Continue as operator' }),
    );
    await expect(page).not.toHaveURL(/signin/, { timeout: 15_000 });
    await page.goto('/admin/rbac');
    await expect(page.getByRole('heading', { name: 'Access control' })).toBeVisible();
  });
});
