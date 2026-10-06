import { fixtures, openUrl } from './fixtures';
import { expect, test } from './test';

test.describe('command palette', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(openUrl(fixtures.basic));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
  });

  // Each `test.step` below was a test of its own, paying for a page load; they run in an order
  // where each starts from what it needs (the palette and Settings closed).
  test('the palette: ">" runs an action, no prefix groups, "/" lists files and "#" opens a setting, the Actions button and the keys, "@" jumps to a branch', async ({ page }) => {
    await test.step('Ctrl+P: ">" actions run the action', async () => {
      await page.keyboard.press('Control+p');
      await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
      await page.keyboard.type('>find');
      await expect(page.getByRole('option').first()).toContainText('Find in graph');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
      await expect(page.getByRole('search', { name: 'Find in graph' })).toBeVisible();
    });
    await test.step('no prefix searches every group, grouped', async () => {
      await page.keyboard.press('Control+p');
      await page.keyboard.type('hotfix');
      await expect(page.locator('.palette-group').first()).toHaveText('Branches & tags');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
    });
    await test.step('"/" lists files at HEAD; "#" opens the setting', async () => {
      await page.keyboard.press('Control+p');
      await page.keyboard.type('/file_2');
      await expect(page.getByRole('option', { name: /file_2\.txt/ })).toBeVisible();
      await page.getByLabel('Command palette query').fill('#date');
      await page.keyboard.press('Enter');
      const row = page.locator('[data-setting-id="dateFormat"]');
      await expect(row).toBeVisible();
      await expect(row).toHaveClass(/flash/);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    });
    await test.step('the toolbar Actions button opens it; arrows move, Esc closes', async () => {
      await page.getByRole('button', { name: 'Actions' }).click();
      await expect(page.getByLabel('Command palette query')).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
    });
    await test.step('"@" jumps to a branch', async () => {
      await page.getByRole('button', { name: 'Actions' }).click();
      await page.keyboard.type('@hotfix');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('row').filter({ hasText: 'Hotfix: null check' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
    });
  });
});
