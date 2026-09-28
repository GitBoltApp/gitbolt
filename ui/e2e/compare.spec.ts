import { expect, test, type Page } from '@playwright/test';
import { fixtures, openUrl } from './fixtures';

const row = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text });

test.describe('compare two commits', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(openUrl(fixtures.details));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
  });

  test('Ctrl+click twice compares A → B; swap reverses; Esc leaves', async ({ page }) => {
    // The graph's SHA button holds the whole hash (its column shows what fits); the header uses 6.
    const a = (await row(page, 'Initial commit').getByTestId('sha').textContent())!.slice(0, 6);
    const b = (await row(page, 'Rename guide and update assets').getByTestId('sha').textContent())!.slice(0, 6);
    await row(page, 'Initial commit').click({ modifiers: ['Control'] });
    await expect(page.getByText('Ctrl+click another commit to compare')).toBeVisible();
    await row(page, 'Rename guide and update assets').click({ modifiers: ['Control'] });
    await expect(page.getByTestId('compare-header')).toHaveText(`Comparing ${a} → ${b}`);
    await expect(row(page, 'Initial commit').getByTestId('compare-a')).toBeVisible();
    await expect(row(page, 'Rename guide and update assets').getByTestId('compare-b')).toBeVisible();
    await expect(page.getByTestId('file-counts')).toHaveAccessibleName('6 modified · 2 added · 1 deleted · 1 renamed');

    await page.getByRole('button', { name: 'Swap' }).click();
    await expect(page.getByTestId('compare-header')).toHaveText(`Comparing ${b} → ${a}`);
    await expect(page.getByTestId('file-counts')).toHaveAccessibleName('6 modified · 1 added · 2 deleted · 1 renamed');

    await page.getByRole('option').and(page.locator('[data-path="docs/guide.txt"]')).click();
    await expect(page.getByRole('region', { name: 'Diff' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    await page.getByRole('grid', { name: 'Commit graph' }).press('Escape');
    await expect(page.getByTestId('compare-header')).toHaveCount(0);
    await expect(page.getByTestId('compare-a')).toHaveCount(0);
  });

  test('a plain click leaves compare mode', async ({ page }) => {
    await row(page, 'Initial commit').click({ modifiers: ['Control'] });
    await row(page, 'Add feature file').click({ modifiers: ['Control'] });
    await expect(page.getByTestId('compare-header')).toBeVisible();
    await row(page, "Merge branch 'feature/x'").click();
    await expect(page.getByTestId('compare-header')).toHaveCount(0);
    await expect(page.getByTestId('details-summary')).toHaveText("Merge branch 'feature/x'");
  });
});
