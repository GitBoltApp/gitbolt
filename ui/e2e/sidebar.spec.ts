import { fixtures, openUrl } from './fixtures';
import { expect, test } from './test';

test.describe('sidebar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(openUrl(fixtures.basic));
    await expect(page.getByRole('tree', { name: /Branches/ })).toBeVisible();
  });

  const count = (page: import('@playwright/test').Page, label: string) => page.getByLabel(`${label} count`);

  test('lists every section with counts, nesting branches by "/"', async ({ page }) => {
    await expect(count(page, 'Local')).toHaveText('3');
    await expect(count(page, 'origin')).toHaveText('2');
    await expect(count(page, 'Worktrees')).toHaveText('2');
    await expect(count(page, 'Stashes')).toHaveText('1');
    await expect(count(page, 'Tags')).toHaveText('1');
    await expect(page.getByRole('treeitem', { name: 'feature/login' }).first()).toBeVisible();
    await expect(page.getByRole('treeitem', { name: 'main' }).first().getByLabel('current branch')).toBeVisible();
  });

  test('filter keeps parents and shows matched/total; Esc clears', async ({ page }) => {
    await page.keyboard.press('Control+Alt+f');
    await expect(page.getByLabel('Filter branches')).toBeFocused();
    await page.keyboard.type('login');
    await expect(count(page, 'Local')).toHaveText('1/3');
    await expect(count(page, 'origin')).toHaveText('1/2');
    await expect(page.getByRole('treeitem', { name: 'hotfix' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(count(page, 'Local')).toHaveText('3');
  });

  test('sort toggle flattens a section; folder collapse persists across reload', async ({ page }) => {
    await page.getByRole('button', { name: 'Sort Local: tree' }).click();
    await expect(page.getByRole('button', { name: 'Sort Local: recent' })).toBeVisible();
    await page.getByRole('button', { name: 'Sort Local: recent' }).click();
    const folder = page.locator('.sb-folder').filter({ hasText: 'feature' }).first();
    await folder.click();
    await expect(folder).toHaveAttribute('aria-expanded', 'false');
    await page.evaluate(() => window.__gb!.flush());
    await page.reload();
    await expect(page.locator('.sb-folder').filter({ hasText: 'feature' }).first()).toHaveAttribute('aria-expanded', 'false');
  });

  test('clicking a branch selects its commit in the graph', async ({ page }) => {
    // Exact: a plain 'hotfix' also substring-matches the Worktrees section's 'wt-hotfix' row.
    await page.getByRole('treeitem', { name: 'hotfix', exact: true }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Hotfix: null check' })).toHaveAttribute('aria-selected', 'true');
  });

  test('hover card shows the last push', async ({ page }) => {
    await page.getByRole('treeitem', { name: 'main' }).first().hover();
    await expect(page.getByRole('tooltip', { name: 'main details' })).toContainText('Last push:');
  });

  test('Ctrl+B toggles narrow mode', async ({ page }) => {
    await page.keyboard.press('Control+b');
    await expect(page.getByRole('complementary', { name: 'Sidebar (collapsed)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Local (3)' })).toBeVisible();
    await page.keyboard.press('Control+b');
    await expect(page.getByRole('complementary', { name: 'Sidebar', exact: true })).toBeVisible();
  });

  test('the sidebar narrows while a diff is open', async ({ page }) => {
    await page.getByRole('row').filter({ hasText: 'Fix typo' }).click();
    await page.keyboard.press('Enter'); // spec §11.1: Enter on the graph opens the first changed file's diff
    await expect(page.getByRole('complementary', { name: 'Sidebar (collapsed)' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('complementary', { name: 'Sidebar', exact: true })).toBeVisible();
  });
});
