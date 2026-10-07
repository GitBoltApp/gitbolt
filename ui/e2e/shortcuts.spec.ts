import { fixtures, openUrl } from './fixtures';
import { expect, test } from './test';

test('Ctrl+/ opens the Keyboard Shortcuts panel; it filters; Esc closes', async ({ page }) => {
  await page.goto(openUrl(fixtures.basic));
  await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
  await page.keyboard.press('Control+/');
  const dlg = page.getByRole('dialog', { name: 'Keyboard Shortcuts' });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByPlaceholder('Filter shortcuts (Ctrl+F)')).toBeFocused();
  await expect(dlg.getByRole('region', { name: 'Repo actions' })).toBeVisible();
  await page.keyboard.type('zoom');
  // The app's Zoom in (Navigation); the image viewer has its own (Image viewer section).
  await expect(dlg.getByRole('region', { name: 'Navigation' }).getByText('Zoom in')).toBeVisible();
  await expect(dlg.getByText('Next tab')).toHaveCount(0);
  // Every binding is listed, usable now or not: no file is open here.
  await page.keyboard.press('Control+A');
  await page.keyboard.type('stage file');
  await expect(dlg.getByRole('region', { name: 'Staging' }).getByText('Stage file', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  // Ctrl+/ toggles
  await page.keyboard.press('Control+/');
  await expect(dlg).toBeVisible();
  await page.keyboard.press('Control+/');
  await expect(dlg).toHaveCount(0);
});
