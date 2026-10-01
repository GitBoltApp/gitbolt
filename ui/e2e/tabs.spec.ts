import { freshFixture, harnessHttp } from './fixtures';
import { expect, test } from './test';

const openBoth = (a: string, b: string) => `/?repo=${encodeURIComponent(a)}&repo=${encodeURIComponent(b)}`;

test.describe('tabs', () => {
  test('only the active tab\'s repo is watched', async ({ page, request }) => {
    const a = freshFixture('basic');
    const b = freshFixture('long_labels');
    await page.goto(openBoth(a, b));
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    const watched = async () => (await (await request.get(`${harnessHttp}/test/watched`)).json()) as number[];
    await expect.poll(watched).toHaveLength(1);
    const first = (await watched())[0];
    await page.keyboard.press('Control+Tab');
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => { const w = await watched(); return w.length === 1 && w[0] !== first; }).toBe(true);
  });

  test('rename via the tab menu persists across reload', async ({ page }) => {
    const a = freshFixture('basic');
    await page.goto(`/?repo=${encodeURIComponent(a)}`);
    const tab = page.getByRole('tab').first();
    await tab.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Rename/ }).click();
    await page.getByLabel('Tab name').fill('Backend');
    await page.keyboard.press('Enter');
    await expect(tab).toContainText('Backend');
    await page.evaluate(() => window.__gb!.flush());
    await page.goto('/');
    await expect(page.getByRole('tab').first()).toContainText('Backend');
  });

  test('middle-click closes, Ctrl+Shift+T reopens at the same place, Ctrl+W closes', async ({ page }) => {
    const a = freshFixture('basic');
    const b = freshFixture('long_labels');
    await page.goto(openBoth(a, b));
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveCount(2);
    const firstLabel = await tabs.nth(0).innerText();
    await tabs.nth(0).click({ button: 'middle' });
    await expect(tabs).toHaveCount(1);
    await page.keyboard.press('Control+Shift+T');
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(0)).toHaveText(firstLabel);
    await page.keyboard.press('Control+w');
    await expect(tabs).toHaveCount(1);
  });

  test('drag reorders tabs', async ({ page }) => {
    const a = freshFixture('basic');
    const b = freshFixture('long_labels');
    await page.goto(openBoth(a, b));
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveCount(2);
    const [l0, l1] = [await tabs.nth(0).innerText(), await tabs.nth(1).innerText()];
    const box0 = (await tabs.nth(0).boundingBox())!;
    const box1 = (await tabs.nth(1).boundingBox())!;
    await page.mouse.move(box0.x + box0.width / 2, box0.y + box0.height / 2);
    await page.mouse.down();
    await page.mouse.move(box0.x + box0.width / 2 + 10, box0.y + 5, { steps: 3 });
    await page.mouse.move(box1.x + box1.width - 4, box1.y + 5, { steps: 5 });
    await page.mouse.up();
    await expect(tabs.nth(0)).toHaveText(l1);
    await expect(tabs.nth(1)).toHaveText(l0);
  });

  test('profiles swap the tab set', async ({ page }) => {
    const a = freshFixture('basic');
    await page.goto(`/?repo=${encodeURIComponent(a)}`);
    await expect(page.getByRole('tab')).toHaveCount(1);
    await page.getByRole('button', { name: /Profile: Default/ }).click();
    await page.getByRole('menuitem', { name: 'New profile…' }).click();
    await page.getByLabel('Profile name').fill('Work');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('button', { name: /Profile: Work/ })).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(0);
    await page.getByRole('button', { name: /Profile: Work/ }).click();
    await page.getByRole('menuitem', { name: 'Default' }).click();
    await expect(page.getByRole('tab')).toHaveCount(1);
  });

  test('the hamburger lists only working actions, with shortcuts', async ({ page }) => {
    const a = freshFixture('basic');
    await page.goto(`/?repo=${encodeURIComponent(a)}`);
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('menuitem', { name: 'File' }).hover();
    await expect(page.getByRole('menuitem', { name: /Open repository…/ })).toContainText('Ctrl+O');
    // Quit isn't offered in the e2e harness (not running in Tauri): no placeholder UI.
    await expect(page.getByRole('menuitem', { name: 'Quit' })).toHaveCount(0);
    // Esc closes the open submenu first, then the root menu (spec §7).
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('context-menu')).toBeHidden();
  });

  test('the About dialog shows the app and git version', async ({ page }) => {
    const a = freshFixture('basic');
    await page.goto(`/?repo=${encodeURIComponent(a)}`);
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('menuitem', { name: 'Help' }).hover();
    await page.getByRole('menuitem', { name: 'About GitBolt' }).click();
    const dialog = page.getByRole('dialog', { name: 'About GitBolt' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('git');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
