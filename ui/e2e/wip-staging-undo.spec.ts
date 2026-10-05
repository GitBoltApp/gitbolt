import { budgetApplies, expect, test } from './test';
import { git } from './fixtures';
import { fileRow, openWip, section } from './wip';

test.describe('the staging undo log (spec #2 §7.6)', () => {
  test('the file list header’s Undo and Redo, with tooltips', async ({ page }) => {
    await openWip(page);
    await fileRow(page, 'unstaged', 'new.txt').hover();
    await page.getByRole('button', { name: 'Stage new.txt' }).click();
    const undo = page.locator('.wip-view-bar').getByRole('button', { name: 'Undo staging' });
    await undo.hover();
    await expect(page.getByRole('tooltip')).toHaveText('Undo stage new.txt (Ctrl+Z)');
    await undo.click();
    await expect(fileRow(page, 'unstaged', 'new.txt')).toBeVisible();
    await page.locator('.wip-view-bar').getByRole('button', { name: 'Redo staging' }).click();
    await expect(fileRow(page, 'staged', 'new.txt')).toBeVisible();
  });

  test('Ctrl+Z in the file list is staging undo, < 100 ms best of 3; the toolbar Undo is untouched', { tag: '@budget' }, async ({ page }) => {
    const repo = await openWip(page);
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      await fileRow(page, 'unstaged', 'new.txt').hover();
      await page.getByRole('button', { name: 'Stage new.txt' }).click();
      await expect(fileRow(page, 'staged', 'new.txt')).toBeVisible();
      await fileRow(page, 'staged', 'new.txt').click();
      await section(page, 'staged').locator('.file-list').focus();
      const t0 = Date.now();
      await page.keyboard.press('Control+z');
      await expect(fileRow(page, 'unstaged', 'new.txt')).toBeVisible();
      runs.push(Date.now() - t0);
    }
    console.log(`[budget] staging undo (Ctrl+Z): ${runs.join(', ')} ms`);
    if (budgetApplies()) expect(Math.min(...runs), `runs: ${runs.join(', ')}`).toBeLessThan(100);
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('notes.txt');
  });

  test('while editing the working copy, Ctrl+Z is Monaco’s own undo', async ({ page }) => {
    await openWip(page);
    await fileRow(page, 'unstaged', 'new.txt').hover();
    await page.getByRole('button', { name: 'Stage new.txt' }).click();
    await fileRow(page, 'unstaged', 'space name.txt').click();
    const editor = page.locator('.diff-panel [data-editable="true"] .editor.modified .view-lines');
    await expect(editor).toContainText('two', { timeout: 15_000 });
    await editor.click();
    await page.keyboard.type('zzz');
    await page.keyboard.press('Control+z');
    await expect(fileRow(page, 'staged', 'new.txt')).toBeVisible();
    await expect(page.locator('.diff-panel').getByText('zzz')).toHaveCount(0);
  });
});
