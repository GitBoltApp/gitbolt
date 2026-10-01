import { expect, test, type Page } from './test';
import { fixtures, openUrl } from './fixtures';

const row = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text });

test.describe('compare two commits', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(openUrl(fixtures.details));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
  });

  test('with one commit selected, Ctrl+click a second: both selected, compared older → newer, with a summary of each; Esc leaves', async ({ page }) => {
    // The graph's SHA button holds the whole hash (its column shows what fits); the header uses 6.
    const initial = row(page, 'Initial commit'), rename = row(page, 'Rename guide and update assets');
    const a = (await initial.getByTestId('sha').textContent())!.slice(0, 6);
    const b = (await rename.getByTestId('sha').textContent())!.slice(0, 6);
    // Newer first: the direction is still by commit date (K16).
    await rename.click();
    await initial.click({ modifiers: ['Control'] });
    await expect(page.getByTestId('compare-header')).toHaveText(`Comparing ${a} → ${b}`);
    await expect(initial).toHaveAttribute('aria-selected', 'true');
    await expect(rename).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('compare-summary')).toHaveText(['Initial commit', 'Rename guide and update assets']);
    await expect(page.getByTestId('compare-date')).toHaveCount(2);
    await expect(page.getByTestId('compare-commit').first().getByTestId('avatar')).toBeVisible();
    await expect(page.getByTestId('file-counts')).toHaveAccessibleName('6 modified · 2 added · 1 deleted · 1 renamed');
    await expect(page.getByRole('button', { name: 'Swap' })).toHaveCount(0);

    await page.getByRole('option').first().click();
    await expect(page.getByRole('region', { name: 'Diff' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    await page.getByRole('grid', { name: 'Commit graph' }).press('Escape');
    await expect(page.getByTestId('compare-header')).toHaveCount(0);
    // Back to the one Ctrl+clicked last.
    await expect(initial).toHaveAttribute('aria-selected', 'true');
    await expect(rename).toHaveAttribute('aria-selected', 'false');
  });

  test('Ctrl+click on one of the pair drops it, back to the other alone', async ({ page }) => {
    const initial = row(page, 'Initial commit'), feature = row(page, 'Add feature file');
    await initial.click();
    await feature.click({ modifiers: ['Control'] });
    await expect(page.getByTestId('compare-header')).toBeVisible();
    await initial.click({ modifiers: ['Control'] });
    await expect(page.getByTestId('compare-header')).toHaveCount(0);
    await expect(page.getByTestId('details-summary')).toHaveText('Add feature file');
    await expect(initial).toHaveAttribute('aria-selected', 'false');
  });

  test('a plain click leaves compare mode', async ({ page }) => {
    await row(page, 'Initial commit').click();
    await row(page, 'Add feature file').click({ modifiers: ['Control'] });
    await expect(page.getByTestId('compare-header')).toBeVisible();
    await row(page, "Merge branch 'feature/x'").click();
    await expect(page.getByTestId('compare-header')).toHaveCount(0);
    await expect(page.getByTestId('details-summary')).toHaveText("Merge branch 'feature/x'");
  });
});
