import { expect, test } from './test';
import { fileRow, openWip, section } from './wip';

test.describe('UX round 4 R: WIP file lists', () => {
  // One repo and page for these (each was a test of its own, paying for a page load and a
  // fixture); none writes.
  test('the header filter narrows Unstaged and Staged at once; Create file… on a folder row prefills "folder/"; Collapse all\'s icon lines up with the section carets', async ({ page }) => {
    await openWip(page);
    await test.step('the header filter narrows Unstaged and Staged at once ("n of m"); Esc clears and closes it', async () => {
      const head = page.getByTestId('wip-header');
      await head.getByRole('button', { name: 'Filter files' }).click();
      const input = page.getByRole('textbox', { name: 'Filter files' });
      await expect(input).toBeFocused();
      await input.fill('notes');
      await expect(fileRow(page, 'unstaged', 'notes.txt')).toBeVisible();
      await expect(fileRow(page, 'unstaged', 'src/app.txt')).toHaveCount(0);
      await expect(section(page, 'unstaged').locator('.file-section-title')).toContainText(/\(1 of \d+\)/);
      await expect(section(page, 'staged').locator('.file-section-title')).toContainText(/\(1 of 1\)/);
      await input.press('Escape');
      await expect(input).toHaveCount(0);
      await expect(fileRow(page, 'unstaged', 'src/app.txt')).toBeVisible();
      await expect(section(page, 'unstaged').locator('.file-section-title')).not.toContainText('of');
    });
    await test.step('Create file… on a folder row prefills "folder/" with the caret at its end', async () => {
      await page.getByRole('button', { name: 'Tree', exact: true }).click();
      await section(page, 'unstaged').locator('.file-row[data-kind="folder"][data-path="src"]').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Create file…' }).click();
      const input = page.getByLabel('New file path');
      await expect(input).toHaveValue('src/');
      expect(await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([4, 4]);
      await input.press('Escape');
      await expect(input).toHaveCount(0);
    });
    await test.step('Collapse all\'s icon lines up with the section carets, and Staged has no filter box of its own', async () => {
      // Tree mode (the step before).
      await page.getByRole('button', { name: 'View all files' }).click();
      await expect(page.getByRole('textbox', { name: 'Filter files' })).toHaveCount(0);
      await page.getByRole('button', { name: 'View all files' }).click();
      const unstaged = section(page, 'unstaged');
      const icon = unstaged.locator('.list-tool-line .list-tool svg').first();
      const caret = unstaged.locator('.wip-section-head button svg').first();
      await expect(icon).toBeVisible();
      const [a, b] = [(await icon.boundingBox())!, (await caret.boundingBox())!];
      expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(1);
    });
  });
});
