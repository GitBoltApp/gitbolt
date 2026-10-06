import { expect, test, type Page } from './test';
import { fixtures, openUrl } from './fixtures';

const graphGrid = (page: Page) => page.getByRole('grid', { name: 'Commit graph' });
const row = (page: Page, text: string) => graphGrid(page).getByRole('row').filter({ hasText: text });

test.describe('compare two commits', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(openUrl(fixtures.details));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
  });

  // Each `test.step` below was a test of its own, paying for a page load; each starts with a
  // plain click, which leaves any compare or multi-selection the step before left.
  test('compare and multi-select: click order, swap, Esc; a third Ctrl+click; Shift ranges; dropping one of the pair; a plain click leaves', async ({ page }) => {
    await test.step('a click then a Ctrl+click compares them in click order (FROM → TO), with a summary of each; swap reverses; Esc leaves', async () => {
      // The graph's SHA button holds the whole hash (its column shows what fits); the header uses 6.
      const initial = row(page, 'Initial commit'), rename = row(page, 'Rename guide and update assets');
      const a = (await initial.getByTestId('sha').textContent())!.slice(0, 6);
      const b = (await rename.getByTestId('sha').textContent())!.slice(0, 6);
      // The newer first: it is FROM (K27). Only the second click needs Ctrl.
      await rename.click();
      await initial.click({ modifiers: ['Control'] });
      await expect(page.getByTestId('compare-header')).toHaveText(`Comparing ${b} → ${a}`);
      await expect(initial).toHaveAttribute('aria-selected', 'true');
      await expect(rename).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('compare-summary')).toHaveText(['Rename guide and update assets', 'Initial commit']);
      await expect(page.getByTestId('compare-date')).toHaveCount(2);
      await expect(page.getByTestId('compare-commit').first().getByTestId('avatar')).toBeVisible();
      // Newer → older: what the newer commit added shows as deleted.
      await expect(page.getByTestId('file-counts')).toHaveAccessibleName('6 modified · 1 added · 2 deleted · 1 renamed');
      // No A/B markers on the rows.
      await expect(page.locator('.compare-marker')).toHaveCount(0);
      await expect(page.getByTestId('compare-a')).toHaveCount(0);

      // The swap reverses FROM and TO; the summaries and the file list follow.
      await page.getByRole('button', { name: 'Swap' }).click();
      await expect(page.getByTestId('compare-header')).toHaveText(`Comparing ${a} → ${b}`);
      await expect(page.getByTestId('compare-summary')).toHaveText(['Initial commit', 'Rename guide and update assets']);
      await expect(page.getByTestId('file-counts')).toHaveAccessibleName('6 modified · 2 added · 1 deleted · 1 renamed');

      await page.getByRole('option').first().click();
      await expect(page.getByRole('region', { name: 'Diff' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
      await page.getByRole('grid', { name: 'Commit graph' }).press('Escape');
      await expect(page.getByTestId('compare-header')).toHaveCount(0);
      // Back to the anchor: the one Ctrl+clicked.
      await expect(initial).toHaveAttribute('aria-selected', 'true');
      await expect(rename).toHaveAttribute('aria-selected', 'false');
    });
    await test.step('a third Ctrl+click gives the multi-selection summary; Ctrl+click on a selected row removes it', async () => {
      const initial = row(page, 'Initial commit'), feature = row(page, 'Add feature file'), rename = row(page, 'Rename guide and update assets');
      await initial.click();
      await rename.click({ modifiers: ['Control'] });
      await feature.click({ modifiers: ['Control'] });
      await expect(page.getByTestId('multi-count')).toHaveText('3 commits selected');
      for (const r of [initial, feature, rename]) await expect(r).toHaveAttribute('aria-selected', 'true');
      // One row per commit, newest first, whatever the click order; no compare, no file list.
      const summaries = page.getByTestId('multi-commit').getByTestId('compare-summary');
      await expect(summaries).toHaveCount(3);
      expect((await summaries.allTextContents()).sort()).toEqual(['Add feature file', 'Initial commit', 'Rename guide and update assets']);
      await expect(summaries.last()).toHaveText('Initial commit');
      await expect(page.getByTestId('multi-commit').first().getByTestId('avatar')).toBeVisible();
      await expect(page.getByTestId('compare-header')).toHaveCount(0);
      await expect(page.getByRole('listbox', { name: 'Changed files' })).toHaveCount(0);
      await expect(page.getByRole('complementary', { name: 'Selected commits' })).toBeVisible();

      // Ctrl+click on a selected row removes it: the other two, compared in click order.
      await rename.click({ modifiers: ['Control'] });
      await expect(rename).toHaveAttribute('aria-selected', 'false');
      await expect(page.getByTestId('compare-summary')).toHaveText(['Initial commit', 'Add feature file']);
      // Back in, then Esc: the anchor (the row Ctrl+clicked last) alone.
      await rename.click({ modifiers: ['Control'] });
      await expect(page.getByTestId('multi-count')).toHaveText('3 commits selected');
      await page.getByRole('grid', { name: 'Commit graph' }).press('Escape');
      await expect(page.getByTestId('multi-count')).toHaveCount(0);
      await expect(page.getByTestId('details-summary')).toHaveText('Rename guide and update assets');
      await expect(initial).toHaveAttribute('aria-selected', 'false');
    });
    await test.step('Shift+click selects the range from the anchor; two rows compare with the anchor as FROM', async () => {
      const initial = row(page, 'Initial commit'), rename = row(page, 'Rename guide and update assets');
      const rows = graphGrid(page).getByRole('row');
      const from = Number(await initial.getAttribute('aria-rowindex')) - 1;
      const to = Number(await rename.getAttribute('aria-rowindex')) - 1;
      expect(from - to).toBeGreaterThanOrEqual(2);
      await initial.click();
      await rename.click({ modifiers: ['Shift'] });
      const n = from - to + 1;
      await expect(page.getByTestId('multi-count')).toHaveText(`${n} commits selected`);
      for (let i = to; i <= from; i++) await expect(rows.nth(i)).toHaveAttribute('aria-selected', 'true');
      await expect(graphGrid(page).locator('[role="row"][aria-selected="true"]')).toHaveCount(n);
      // From the same anchor, the row just above it: a compare, the anchor FROM.
      await rows.nth(from - 1).click({ modifiers: ['Shift'] });
      await expect(page.getByTestId('compare-summary').first()).toHaveText('Initial commit');
      await expect(graphGrid(page).locator('[role="row"][aria-selected="true"]')).toHaveCount(2);
    });
    await test.step('Ctrl+click on one of the pair drops it, back to the other alone', async () => {
      const initial = row(page, 'Initial commit'), feature = row(page, 'Add feature file');
      await initial.click();
      await feature.click({ modifiers: ['Control'] });
      await expect(page.getByTestId('compare-header')).toBeVisible();
      await initial.click({ modifiers: ['Control'] });
      await expect(page.getByTestId('compare-header')).toHaveCount(0);
      await expect(page.getByTestId('details-summary')).toHaveText('Add feature file');
      await expect(initial).toHaveAttribute('aria-selected', 'false');
    });
    await test.step('a plain click leaves compare mode', async () => {
      await row(page, 'Initial commit').click();
      await row(page, 'Add feature file').click({ modifiers: ['Control'] });
      await expect(page.getByTestId('compare-header')).toBeVisible();
      await row(page, "Merge branch 'feature/x'").click();
      await expect(page.getByTestId('compare-header')).toHaveCount(0);
      await expect(page.getByTestId('details-summary')).toHaveText("Merge branch 'feature/x'");
    });
  });
});
