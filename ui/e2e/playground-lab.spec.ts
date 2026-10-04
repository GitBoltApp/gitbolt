import { freshFixture, openUrl } from './fixtures';
import { expect, test, type Page } from './test';

/** The playground's rebase-lab (UX round 3, P): ⚠ on an interactive rebase onto main, and the two Squash rows on a multi-select. */
const grid = (page: Page) => page.getByRole('grid', { name: 'Commit graph' });
const row = (page: Page, subject: string) => grid(page).getByRole('row').filter({ hasText: subject });

test.describe('rebase-lab (playground)', () => {
  test('the interactive rebase onto main predicts a conflict on a row', async ({ page }) => {
    await page.goto(openUrl(freshFixture('rebase_lab')));
    await grid(page).getByText('main', { exact: true }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Interactive rebase lab onto main' }).click();
    const editor = page.getByTestId('irebase');
    await expect(editor).toBeVisible();
    const l2 = editor.locator('[data-irebase-row]', { hasText: 'L2 Reword line two' });
    const warn = l2.locator('[aria-label="Predicted conflict"]');
    await expect(warn).toBeVisible({ timeout: 15_000 });
    // UX4 Q.1: just left of the action dropdown, not at the row's far end.
    const [w, a] = [(await warn.boundingBox())!, (await l2.locator('.irebase-action').boundingBox())!];
    expect(w.x + w.width).toBeLessThanOrEqual(a.x);
    expect(a.x - (w.x + w.width)).toBeLessThan(16);
  });

  test('a multi-selection on the checked-out branch shows both Squash rows', async ({ page }) => {
    await page.goto(openUrl(freshFixture('rebase_lab')));
    await row(page, 'L4 Refine four').click();
    await row(page, 'L6 Add docs').click({ modifiers: ['Shift'] });
    await expect(page.getByTestId('multi-count')).toHaveText('3 commits selected');
    await row(page, 'L5 Add tests').click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Squash 3 commits', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Squash 3 commits interactively…' })).toBeVisible();
  });

  test('stack: the same two rows', async ({ page }) => {
    await page.goto(openUrl(freshFixture('stack')));
    await row(page, 'Work on feature/c').click();
    await row(page, 'Work on feature/a').click({ modifiers: ['Shift'] });
    await expect(page.getByTestId('multi-count')).toHaveText('3 commits selected');
    await row(page, 'Work on feature/b').click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Squash 3 commits', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Squash 3 commits interactively…' })).toBeVisible();
  });
});
