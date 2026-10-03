import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from './test';
import { freshFixture, git, openUrl } from './fixtures';
import { fileRow, openWip, selectWip } from './wip';

const fileView = (page: Page) => page.getByTestId('file-view').locator('.view-lines');
const undoButton = (page: Page) => page.getByRole('toolbar', { name: 'Repository toolbar' }).getByRole('button', { name: 'Undo', exact: true });
const notes = (repo: string) => readFileSync(join(repo, 'notes.txt'), 'utf8');

test.describe('UX round 2 G: editing a working-tree file in File View', () => {
  test('a staged file: File View edits the working-tree file, Ctrl+S saves it, Undo restores it', async ({ page }) => {
    const repo = await openWip(page);
    const before = notes(repo);
    await fileRow(page, 'staged', 'notes.txt').click();
    await page.getByRole('button', { name: 'File View' }).click();
    // The working-tree file: its unstaged line 30 too, not just the staged version.
    await expect(fileView(page)).toContainText('note 01', { timeout: 15_000 });
    await fileView(page).click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.type('X');
    await expect(page.getByLabel('Unsaved changes')).toBeVisible();
    await page.keyboard.press('Control+s');
    await expect(page.getByLabel('Unsaved changes')).toHaveCount(0);
    expect(notes(repo)).toBe(`X${before}`);
    expect(notes(repo)).toContain('note 30 unstaged');
    // Journaled: the toolbar's Undo puts the file back, and the File View shows it again.
    await expect(undoButton(page)).toBeEnabled();
    await undoButton(page).click();
    await expect.poll(() => notes(repo)).toBe(before);
    await expect(fileView(page)).not.toContainText('Xnote 01');
  });

  test('saves of one file in a row are one Undo step, back to before the first', async ({ page }) => {
    const repo = await openWip(page);
    const before = notes(repo);
    await fileRow(page, 'staged', 'notes.txt').click();
    await page.getByRole('button', { name: 'File View' }).click();
    await expect(fileView(page)).toContainText('note 01', { timeout: 15_000 });
    await fileView(page).click();
    await page.keyboard.press('Control+Home');
    for (const ch of ['A', 'B']) {
      await page.keyboard.type(ch);
      await page.keyboard.press('Control+s');
      await expect(page.getByLabel('Unsaved changes')).toHaveCount(0);
      await expect.poll(() => notes(repo).startsWith(ch === 'A' ? 'A' : 'AB')).toBe(true);
    }
    await undoButton(page).click();
    await expect.poll(() => notes(repo)).toBe(before);
  });

  test('View all files on the WIP opens an unchanged tracked file, editable (what a clean Edit stop needs)', async ({ page }) => {
    const repo = freshFixture('wip_staging');
    writeFileSync(join(repo, 'clean.txt'), 'clean 1\nclean 2\n');
    git(repo, 'add', 'clean.txt');
    git(repo, 'commit', '-q', '-m', 'clean');
    await page.goto(openUrl(repo));
    await selectWip(page);
    await page.locator('.wip-view-bar').getByRole('button', { name: 'View all files' }).click();
    await fileRow(page, 'unstaged', 'clean.txt').click();
    await expect(fileView(page)).toContainText('clean 1', { timeout: 15_000 });
    await fileView(page).click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.type('edited ');
    await page.keyboard.press('Control+s');
    await expect(page.getByLabel('Unsaved changes')).toHaveCount(0);
    expect(readFileSync(join(repo, 'clean.txt'), 'utf8')).toBe('edited clean 1\nclean 2\n');
  });

  test("G.1: a read-only editor's message draws over the file bar, not under it", async ({ page }) => {
    await openWip(page);
    // A staged file's Diff View is read-only.
    await fileRow(page, 'staged', 'notes.txt').click();
    const line = page.locator('.diff-panel .editor.modified .view-line', { hasText: 'note 03 staged' }).first();
    await expect(line).toBeVisible({ timeout: 15_000 });
    await line.click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.type('x');
    const message = page.locator('.monaco-editor-overlaymessage');
    await expect(message).toContainText('Cannot edit in read-only editor');
    // In the overflow layer on <body>, and what's on screen at its centre is the message itself.
    expect(await message.evaluate((el) => !!el.closest('.monaco-overflow-layer'))).toBe(true);
    const box = (await message.boundingBox())!;
    const hit = await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('.monaco-editor-overlaymessage'), [box.x + box.width / 2, box.y + box.height / 2]);
    expect(hit).toBe(true);
  });
});
