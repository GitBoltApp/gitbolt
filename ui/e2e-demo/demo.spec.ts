import { expect, test } from '@playwright/test';
import { armedOverlay, confirmArmed } from '../e2e/armed';

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
    await expect(page).toHaveTitle('GitVolt — basic');
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

  await test.step('zoom: Ctrl+= scales the page, and a click, a context menu and a column drag still follow the pointer', async () => {
    // 150% of a 1,500 px window lays out as the 1,000 px frame does.
    await page.setViewportSize({ width: 1500, height: 1000 });
    const undo = page.getByRole('toolbar', { name: 'Repository toolbar' }).getByRole('button', { name: 'Undo', exact: true });
    const width = (await undo.boundingBox())!.width;
    for (let i = 0; i < 5; i++) await page.keyboard.press('Control+=');
    await expect(page.locator('html')).toHaveAttribute('data-zoom', '150');
    await expect(page.getByRole('contentinfo').getByText('150%')).toBeVisible();
    expect((await undo.boundingBox())!.width).toBeCloseTo(width * 1.5, 0);

    const row = grid.getByRole('row').filter({ hasText: 'Initial commit' });
    const cell = (await row.locator('[data-col="message"]').boundingBox())!;
    await page.mouse.click(cell.x + cell.width / 2, cell.y + cell.height / 2);
    await expect(row).toHaveAttribute('aria-selected', 'true');

    // The menu opens at the pointer (on a row high enough for it to open downwards).
    const high = (await grid.getByRole('row').filter({ hasText: 'Fix typo' }).locator('[data-col="message"]').boundingBox())!;
    const at = { x: high.x + 40, y: high.y + high.height / 2 };
    await page.mouse.click(at.x, at.y, { button: 'right' });
    const menu = (await page.getByRole('menu').boundingBox())!;
    expect(Math.abs(menu.x - at.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(menu.y - at.y)).toBeLessThanOrEqual(2);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);

    // The Branch / Tag column's edge moves with the pointer, 1:1 on screen.
    const handle = page.getByRole('separator', { name: 'Resize Branch / Tag column' });
    const h = (await handle.boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2 - 60, h.y + h.height / 2, { steps: 4 });
    await page.mouse.up();
    expect((await handle.boundingBox())!.x).toBeCloseTo(h.x - 60, 0);

    await page.keyboard.press('Control+0');
    await expect(page.locator('html')).toHaveAttribute('data-zoom', '100');
    await page.setViewportSize({ width: 1000, height: 760 });
  });

  await test.step('a write: Stage all, commit, then Undo puts it back', async () => {
    const mainWip = grid.getByRole('row').filter({ hasText: '// WIP' }).filter({ hasNotText: 'wt-hotfix' });
    await mainWip.locator('[data-col="message"]').click({ position: { x: 3, y: 3 } });
    await expect(page.getByTestId('wip-header')).toBeVisible();
    await page.locator('.wip-section[data-section="unstaged"]').getByRole('button', { name: 'Stage all' }).click();
    await expect(page.getByRole('heading', { name: 'Staged (1)' })).toBeVisible();
    const summary = page.getByTestId('commit-box').getByRole('textbox', { name: 'Commit summary' });
    await summary.fill('Made in the demo');
    await summary.press('Control+Enter');
    await expect(grid.getByText('Made in the demo')).toBeVisible();
    await expect(grid.getByText('// WIP')).toHaveCount(1);
    await page.getByRole('toolbar', { name: 'Repository toolbar' }).getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(grid.getByText('Made in the demo')).toHaveCount(0);
    await expect(grid.getByText('// WIP')).toHaveCount(2);
  });
  await test.step('interactive rebase of lab onto main: predict a conflict, start, see the stop, abort', async () => {
    await page.getByRole('button', { name: /^Tab group: Playground/ }).click();
    await page.getByRole('tab', { name: /rebase_lab/ }).click();
    await grid.getByText('main', { exact: true }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Interactive rebase lab onto main' }).click();
    const editor = page.getByTestId('irebase');
    await expect(editor.locator('[data-irebase-row]', { hasText: 'L2 Reword line two' }).locator('[aria-label="Predicted conflict"]')).toBeVisible();
    await editor.getByRole('button', { name: 'Start Rebase' }).click();
    const status = page.getByRole('region', { name: 'Rebase in progress' });
    await expect(status).toBeVisible();
    const abort = page.getByTestId('commit-box').getByRole('button', { name: 'Abort rebase' });
    await abort.click();
    await confirmArmed(armedOverlay(page, 'Click again to abort the rebase'));
    await expect(status).toBeHidden();
  });

  await test.step("fetch brings in the teammate's commit", async () => {
    await page.getByRole('tab', { name: /^sync/ }).click();
    await page.getByRole('button', { name: 'Fetch', exact: true }).click();
    await expect(grid.getByText('Remote change')).toBeVisible();
  });

  await test.step('an MR: its thread, and a reply', async () => {
    await page.getByRole('tab', { name: /forge_lab/ }).click();
    const list = page.getByRole('complementary', { name: 'Sidebar', exact: true }).getByRole('region', { name: 'Merge requests', exact: true });
    await list.getByRole('treeitem', { name: /Scale the HUD with the window/ }).click();
    const view = page.getByRole('dialog', { name: 'Merge request !1' });
    await expect(view.getByText('Could this round to the nearest step instead?')).toBeVisible();
    await view.getByRole('button', { name: 'Reply' }).first().click();
    await view.getByRole('textbox', { name: 'Reply' }).fill('Done, thanks.');
    await view.getByRole('form', { name: 'Reply' }).getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(view.getByText('Done, thanks.')).toBeVisible();
  });
  expect(violations).toEqual([]);
});
