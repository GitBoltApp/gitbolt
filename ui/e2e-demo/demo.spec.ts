import { expect, test } from '@playwright/test';

test('the demo boots into basic: its graph and sidebar, narrow panels in a small frame, no CSP violation', async ({ page }) => {
  const violations: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => { console.warn(`[csp-violation] ${e.effectiveDirective} ${e.blockedURI}`); });
  });
  page.on('console', (m) => { if (m.text().startsWith('[csp-violation]')) violations.push(m.text()); });
  await page.goto('/demo.html');
  const grid = page.getByRole('grid', { name: 'Commit graph' });

  await test.step("the graph: every row of basic, both worktrees' WIP", async () => {
    await expect(grid.getByRole('row')).toHaveCount(10);
    await expect(grid.getByText("Merge branch 'feature/login'")).toBeVisible();
    await expect(grid.getByText('// WIP')).toHaveCount(2);
    await expect(page).toHaveTitle('GitBolt — basic');
  });

  await test.step('the sidebar: its branches, at the narrow width', async () => {
    const sidebar = page.getByRole('complementary', { name: 'Sidebar', exact: true });
    await expect(sidebar.getByRole('region', { name: 'Local', exact: true }).getByText('main', { exact: true })).toBeVisible();
    // 190 px of content plus the panel's 1 px border.
    expect(Math.round((await sidebar.boundingBox())?.width ?? 0)).toBeLessThanOrEqual(191);
    expect(Math.round((await sidebar.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(190);
  });

  await test.step('the details panel opens at the narrow width', async () => {
    await grid.getByText('Fix typo').click();
    const details = page.getByRole('complementary', { name: 'Commit details' });
    await expect(details).toBeVisible();
    // 300 px of content plus the border.
    expect((await details.boundingBox())?.width).toBeLessThanOrEqual(301);
  });

  expect(violations).toEqual([]);
});
