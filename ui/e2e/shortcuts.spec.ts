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
  await expect(dlg.getByText('Zoom in')).toBeVisible();
  await expect(dlg.getByText('Next tab')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  // Ctrl+/ toggles
  await page.keyboard.press('Control+/');
  await expect(dlg).toBeVisible();
  await page.keyboard.press('Control+/');
  await expect(dlg).toHaveCount(0);
});
