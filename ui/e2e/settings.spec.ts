import type { Page } from '@playwright/test';
import { DENSITY_STORAGE_KEY } from '../src/theme/density';
import { freshFixture, git, openUrl } from './fixtures';
import { expect, test, confirmArmed, armedOverlay } from './test';

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
const open = async (page: Page, path = freshFixture('basic')) => {
  await page.goto(openUrl(path));
  await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
  return path;
};
/** Opens the dropdown button and picks a row from the app's menu. */
const pick = async (page: Page, button: string, row: string | RegExp) => {
  await dialog(page).getByRole('button', { name: button }).click();
  await page.getByRole('menuitem', { name: row }).click();
};
const openSettings = async (page: Page) => {
  await page.keyboard.press('Control+,');
  await expect(dialog(page)).toBeVisible();
};

test.describe('settings', () => {
  test('K102: the gear opens settings; K103: a label click leaves the dropdown closed and its background matches the inputs', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await expect(dialog(page)).toBeVisible();
    await dialog(page).getByText('Date format', { exact: true }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await dialog(page).getByText('Date format', { exact: true }).hover();
    const bg = (sel: string) => dialog(page).locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);
    const select = await bg('button.select');
    expect(select).toBe(await bg('input:not([type="checkbox"]):not([type="radio"])'));
  });

  test('Ctrl+, opens it and Esc closes it', async ({ page }) => {
    await open(page);
    await openSettings(page);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
  });

  test('the date format applies to the graph', async ({ page }) => {
    await open(page);
    const dateCell = page.getByRole('row').filter({ hasText: 'Fix typo' }).locator('[data-col="date"]');
    await expect(dateCell).toContainText(/ (AM|PM)$/);
    await openSettings(page);
    await pick(page, 'Date format', '2026-09-26 15:14');
    await expect(dateCell).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    await pick(page, 'Date format', '26/09/2026 15:14');
    await expect(dateCell).toHaveText(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  });

  test('the commit limit reloads the graph window', async ({ page }) => {
    await open(page);
    const rows = page.getByRole('grid', { name: 'Commit graph' }).getByRole('row');
    const before = await rows.count();
    expect(before).toBeGreaterThan(3);
    await openSettings(page);
    const limit = dialog(page).getByLabel('Commits loaded in the graph');
    await limit.fill('3');
    await limit.press('Enter');
    await expect.poll(() => rows.count()).toBeLessThan(before);
  });

  test('density and sticky scroll persist behind their stores', async ({ page }) => {
    await open(page);
    await openSettings(page);
    await dialog(page).getByRole('radio', { name: 'Compact' }).check();
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), DENSITY_STORAGE_KEY)).toBe('compact');
    await dialog(page).getByRole('button', { name: 'Editor' }).click();
    const sticky = dialog(page).getByLabel('Sticky scroll in the diff viewer');
    await sticky.check();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('gitbolt.editorSettings.v1'))).toBe('{"stickyScroll":true}');
    // The tooltip shows at once.
    await dialog(page).getByText('Sticky scroll in the diff viewer').hover();
    await expect(page.getByRole('tooltip')).toContainText("Sticky scroll pins the enclosing scope's first line");
  });

  test('a host override switches a generic remote to GitLab, in the graph and the sidebar', async ({ page }) => {
    const repo = freshFixture('basic');
    git(repo, 'remote', 'set-url', 'origin', 'git@code.example.com:acme/shop.git');
    await open(page, repo);
    const icons = page.locator('[aria-label="remote origin"]');
    await expect(icons.first()).toHaveAttribute('data-host-kind', 'generic');
    await openSettings(page);
    await dialog(page).getByRole('button', { name: 'Hosts' }).click();
    await pick(page, 'Forge type for code.example.com', 'GitLab');
    await page.keyboard.press('Escape');
    await expect(icons.first()).toHaveAttribute('data-host-kind', 'gitlab');
    // Every origin icon follows, the sidebar's folder included.
    for (const icon of await icons.all()) await expect(icon).toHaveAttribute('data-host-kind', 'gitlab');
    // And it is the profile's: it survives a reload.
    await page.reload();
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    await expect(icons.first()).toHaveAttribute('data-host-kind', 'gitlab');
  });

  test('a Custom editor command the guard refuses shows its error inline; a valid one is kept', async ({ page }) => {
    await open(page);
    await openSettings(page);
    await dialog(page).getByRole('button', { name: 'Editor' }).click();
    await pick(page, 'Default editor', 'Custom command…');
    const command = dialog(page).getByLabel('Custom editor command');
    await command.fill('sh -c "geany {file}"');
    await expect(dialog(page).getByRole('alert')).toContainText("can't contain {file}, {line} or {repo}");
    await command.fill('/bin/echo --goto {file}:{line}');
    await expect(dialog(page).getByRole('alert')).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    await openSettings(page);
    await dialog(page).getByRole('button', { name: 'Editor' }).click();
    await expect(dialog(page).getByLabel('Custom editor command')).toHaveValue('/bin/echo --goto {file}:{line}');
  });

  test('reset arms in place first; Esc disarms it and leaves Settings open', async ({ page }) => {
    await open(page);
    await openSettings(page);
    await pick(page, 'Date format', '09/26/2026 3:14 PM');
    await dialog(page).getByRole('button', { name: /Reset settings to defaults/ }).click();
    const armed = armedOverlay(page, 'Click again to reset every setting here to its default');
    await expect(armed).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(armed).toBeHidden();
    await expect(dialog(page).getByLabel('Date format')).toHaveText('09/26/2026 3:14 PM');
    await dialog(page).getByRole('button', { name: /Reset settings to defaults/ }).click();
    await confirmArmed(armed);
    await expect(dialog(page).getByLabel('Date format')).toHaveText('2026-09-26 @ 3:14 PM');
  });

  test('K92: a dropdown opens on click and with the keyboard, changes its value, and Esc closes only the menu', async ({ page }) => {
    await open(page);
    await openSettings(page);
    const date = dialog(page).getByRole('button', { name: 'Date format' });
    await date.click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.getByRole('menuitem', { name: '26/09/2026 15:14' }).click();
    await expect(date).toHaveText('26/09/2026 15:14');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await date.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(dialog(page)).toBeVisible();
    await expect(date).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(date).toHaveText('09/26/2026 3:14 PM');
    await expect(dialog(page)).toBeVisible();
  });

  test('K93: the tabs are separate sections, and the palette deep link opens the right one and focuses the setting', async ({ page }) => {
    await open(page);
    await openSettings(page);
    await expect(dialog(page).getByRole('region', { name: 'General' })).toBeVisible();
    await expect(dialog(page).getByRole('region', { name: 'Fetch' })).toHaveCount(0);
    await dialog(page).getByRole('button', { name: 'Fetch' }).click();
    await expect(dialog(page).getByRole('region', { name: 'Fetch' })).toBeVisible();
    await expect(dialog(page).getByRole('region', { name: 'General' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await openSettings(page);
    await expect(dialog(page).getByRole('region', { name: 'Fetch' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+p');
    await page.getByLabel('Command palette query').fill('#sticky');
    await page.keyboard.press('Enter');
    await expect(dialog(page).getByRole('region', { name: 'Editor' })).toBeVisible();
    await expect(dialog(page).getByLabel('Sticky scroll in the diff viewer')).toBeFocused();
  });

  test('K94: the close button is the shared icon button, not a bordered box', async ({ page }) => {
    await open(page);
    await openSettings(page);
    const close = dialog(page).getByRole('button', { name: 'Close settings' });
    await expect(close).toHaveClass(/icon-button/);
    await expect(close).toHaveCSS('border-top-width', '0px');
    await expect(close).toHaveCSS('border-top-left-radius', '3px');
    await close.click();
    await expect(dialog(page)).toHaveCount(0);
  });
});
