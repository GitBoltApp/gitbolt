import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from './test';
import { fileRow, openWip, section } from './wip';

const undoButton = (page: Page) => page.getByRole('toolbar', { name: 'Repository toolbar' }).getByRole('button', { name: 'Undo', exact: true });

/** Types into the File View that should have the keyboard, saves, and checks it reached the file. */
async function editAndSave(page: Page, repo: string, path: string): Promise<void> {
  await expect(page.getByTestId('file-view')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('region', { name: 'Diff' })).toContainText(path);
  // Focused: the keys go straight into the editor.
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.monaco-editor'))).toBe(true);
  await page.keyboard.type('hello');
  await expect(page.getByLabel('Unsaved changes')).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect(page.getByLabel('Unsaved changes')).toHaveCount(0);
  await expect.poll(() => readFileSync(join(repo, path), 'utf8')).toBe('hello');
}

test.describe('UX round 3 O.1: Create file…', () => {
  test('from the Unstaged list\'s empty space: a new folder and file, open in File View, editable; Undo removes it', async ({ page }) => {
    const repo = await openWip(page);
    // Staged collapsed: Unstaged takes the space, so its list has room below its rows.
    await section(page, 'staged').locator('.wip-section-head').click();
    const scroll = section(page, 'unstaged').locator('.file-list-scroll');
    const box = (await scroll.boundingBox())!;
    await scroll.click({ button: 'right', position: { x: 30, y: box.height - 6 } });
    await page.getByRole('menuitem', { name: 'Create file…' }).click();
    const input = page.getByLabel('New file path');
    await expect(input).toBeFocused();
    // The live check: .. and .git are refused before anything is sent.
    await input.fill('../x');
    await expect(section(page, 'unstaged').getByRole('alert')).toHaveText('The path can\'t leave the repository (..)');
    await input.fill('notes.txt');
    await input.press('Enter');
    // It exists: the core refuses it, and the input keeps the name to fix.
    await expect(input).toHaveValue('notes.txt');
    await input.fill('newdir/deep/hello.md');
    await input.press('Enter');
    await expect(input).toHaveCount(0);
    expect(readFileSync(join(repo, 'newdir/deep/hello.md'), 'utf8')).toBe('');
    await expect(fileRow(page, 'unstaged', 'newdir/deep/hello.md')).toBeVisible();
    await editAndSave(page, repo, 'newdir/deep/hello.md');
    // Undo the save, then the create: the file and the folders it made are gone.
    await undoButton(page).click();
    await expect.poll(() => readFileSync(join(repo, 'newdir/deep/hello.md'), 'utf8')).toBe('');
    // Answered (the file can change before the reply): an Undo pressed while one is in flight
    // is ignored (undo/feature.ts `once`).
    await expect(page.getByRole('status').filter({ hasText: 'Undid save newdir/deep/hello.md' })).toBeVisible();
    await undoButton(page).click();
    await expect.poll(() => existsSync(join(repo, 'newdir'))).toBe(false);
    await expect(fileRow(page, 'unstaged', 'newdir/deep/hello.md')).toHaveCount(0);
  });

  test('from a file row\'s menu, for a list its rows fill: the input opens at the top of that list', async ({ page }) => {
    const repo = await openWip(page);
    await fileRow(page, 'unstaged', 'notes.txt').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Create file…' }).click();
    const input = section(page, 'unstaged').getByLabel('New file path');
    await expect(input).toBeFocused();
    await input.fill('from-row.txt');
    await input.press('Enter');
    await expect(input).toHaveCount(0);
    await editAndSave(page, repo, 'from-row.txt');
  });

  test('from the palette: a dialog, then the file in File View, editable', async ({ page }) => {
    const repo = await openWip(page);
    await page.keyboard.press('Control+p');
    await page.getByLabel('Command palette query').fill('>Create file');
    await page.getByRole('option', { name: /Create file…/ }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Create a file' });
    await dialog.getByLabel('File path').fill('from-palette.txt');
    await dialog.getByRole('button', { name: 'Create file' }).click();
    await expect(dialog).toHaveCount(0);
    await editAndSave(page, repo, 'from-palette.txt');
  });
});
