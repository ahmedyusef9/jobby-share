/**
 * BL-061 — RBAC console e2e (#50 coverage). Matrix reference:
 * deploy/design/rbac-matrix.md — this spec walks levels L5 (operator edits)
 * and L2 (member blocked), and leaves the audit trail clean.
 */
import { test, expect } from 'playwright/test';
import { loginMember, loginOperator } from './auth.helpers.mjs';
import { memberCredentials } from './credentials.mjs';

const EDITABLE_CHECKBOXES = 4 * 5; // 4 editable capabilities x 5 plan columns

test.describe('L5 operator: /admin/rbac matrix', () => {
  let published = false;

  test('matrix renders with locked structural rows + Operator nav tabs', async ({ page }) => {
    await loginOperator(page);
    const sidebar = page.getByRole('complementary'); // desktop nav; mobile has one too
    await expect(sidebar.getByRole('link', { name: 'Admin', exact: true })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: 'Access', exact: true })).toBeVisible();
    await page.goto('/admin/rbac');
    await expect(page.getByRole('heading', { name: 'Access control' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'always' }).first()).toBeVisible();
    // only the editable grid offers checkboxes
    await expect(page.getByRole('checkbox')).toHaveCount(20); // 4 editable caps x 5 plans
  });

  test('toggle -> Publish -> audit row -> restore', async ({ page }) => {
    test.setTimeout(90_000);
    await loginOperator(page);
    await page.goto('/admin/rbac');
    // hydration gate: checkboxes exist only after the matrix fetch + mount;
    // clicking earlier flips the raw input without firing React onChange
    await expect(page.getByRole('checkbox')).toHaveCount(20);

    const row = page.locator('tr', { hasText: 'Generate CV' }).first();
    const freeCell = row.locator('td').nth(2); // plans: alpha,free,basic,plus,advanced
    const box = freeCell.getByRole('checkbox');
    const before = await box.isChecked();

    await box.setChecked(!before);
    const publish = page.getByRole('button', { name: 'Publish changes' });
    await publish.click();
    await expect(page.locator('table').last().locator('tbody')).toContainText('rbac.planCaps.set');

    // load() refetches after publish; restoring before it settles gets
    // overwritten by the fetch. Publish going DISABLED again == draft is
    // synced with what persisted.
    await expect(publish).toBeDisabled();

    // restore original state so the suite is idempotent on re-run
    await row.locator('td').nth(2).getByRole('checkbox').setChecked(before);
    await expect(publish).toBeEnabled();
    await publish.click();
    await expect(publish).toBeDisabled();
    await expect(page.locator('table').last().locator('tbody')).toContainText('rbac.planCaps');
    void published;
  });

  test('reset-to-defaults path is offered', async ({ page }) => {
    await loginOperator(page);
    await page.goto('/admin/rbac');
    await expect(page.getByRole('button', { name: 'Reset to release defaults' })).toBeVisible();
  });
});

test.describe('L2 member: console must not exist', () => {
  // skipped unless member creds exist; credentials.mjs drives the skip reason
  test.skip(!memberCredentials(), 'member creds required');
  test('member /admin/rbac renders no matrix + no Operator nav tabs', async ({ page }) => {
    await loginMember(page);
    await expect(page.getByRole('link', { name: 'Access', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);
    await page.goto('/admin/rbac');
    await expect(page.locator('body')).not.toContainText('Access control');
  });
});
