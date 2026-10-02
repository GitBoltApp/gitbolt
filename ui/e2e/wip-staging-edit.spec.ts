import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from './test';
import { freshFixture, openUrl } from './fixtures';

const modified = (page: Page) => page.locator('.diff-panel .editor.modified .view-lines').first();

/** Opens the `wip_staging` fixture on its WIP row. */
async function openWip(page: Page): Promise<string> {
  const repo = freshFixture('wip_staging');
  await page.goto(openUrl(repo));
  await page.getByRole('grid', { name: 'Commit graph' }).getByRole('row').filter({ hasText: '// WIP' }).locator('[data-col="message"]').click({ position: { x: 3, y: 3 } });
  return repo;
}
const unstagedRow = (page: Page, name: string) => page.getByRole('listbox', { name: 'Unstaged' }).getByRole('option').filter({ hasText: name });

test.describe('the editable working copy (spec #2 §7.5)', () => {
  test('edit, see the dot, Ctrl+S saves to disk', async ({ page }) => {
    const repo = await openWip(page);
    await unstagedRow(page, 'space name.txt').click();
    await expect(modified(page)).toContainText('two', { timeout: 15_000 });
    await modified(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('three');
    await expect(page.getByLabel('Unsaved changes')).toBeVisible();
    await page.keyboard.press('Control+s');
    await expect(page.getByLabel('Unsaved changes')).toHaveCount(0);
    expect(readFileSync(join(repo, 'space name.txt'), 'utf8')).toBe('one\ntwo\nthree');
  });

  test('leaving with unsaved edits asks Save, Discard edits or Cancel', async ({ page }) => {
    await openWip(page);
    await unstagedRow(page, 'space name.txt').click();
    await expect(modified(page)).toContainText('two', { timeout: 15_000 });
    await modified(page).click();
    await page.keyboard.type('x');
    await unstagedRow(page, 'new.txt').click();
    await expect(page.getByRole('alertdialog')).toContainText('Save your changes to space name.txt?');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('diff-path')).toContainText('space name.txt');
    await unstagedRow(page, 'new.txt').click();
    await page.getByRole('button', { name: 'Discard edits' }).click();
    await expect(page.getByTestId('diff-path')).toContainText('new.txt');
  });

  test('a stale save offers Reload and Overwrite', async ({ page }) => {
    const repo = await openWip(page);
    await unstagedRow(page, 'space name.txt').click();
    await expect(modified(page)).toContainText('two', { timeout: 15_000 });
    await modified(page).click();
    await page.keyboard.type('mine ');
    writeFileSync(join(repo, 'space name.txt'), 'changed outside\n');
    await page.keyboard.press('Control+s');
    await expect(page.getByRole('alertdialog')).toContainText('space name.txt changed on disk');
    await page.getByRole('button', { name: 'Overwrite' }).click();
    await expect(page.getByLabel('Unsaved changes')).toHaveCount(0);
    expect(readFileSync(join(repo, 'space name.txt'), 'utf8')).toContain('mine ');
  });
});
