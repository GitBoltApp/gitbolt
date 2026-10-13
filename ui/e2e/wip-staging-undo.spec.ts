import { budgetApplies, expect, test } from './test';
import { git } from './fixtures';
import { fileRow, openWip, section } from './wip';

test.describe('the staging undo log (spec #2 §7.6)', () => {
  // One repo and page for both (each was a test of its own, paying for a page load): new.txt is
  // left staged by the first, as the second needs it.
  test('the file list header’s Undo and Redo, with tooltips; while editing the working copy, Ctrl+Z is Monaco’s own undo', async ({ page }) => {
    await openWip(page);
    await test.step('the file list header’s Undo and Redo, with tooltips', async () => {
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
    await test.step('a WIP diff’s toolbar has them too, in the toolbar: nothing of them under the editor’s overview ruler', async () => {
      await fileRow(page, 'unstaged', 'src/app.txt').click();
      const panel = page.locator('.diff-panel');
      await panel.getByRole('button', { name: 'Split' }).click();
      await expect(panel.locator('.monaco-diff-editor.side-by-side .diffOverview')).toBeVisible({ timeout: 15_000 });
      // They were placed as in the file list's bar (absolute, top 50%): midway down the panel's
      // right edge, under the overview ruler, where no click reached them.
      const bar = await panel.getByRole('toolbar', { name: 'Diff options' }).boundingBox();
      const undo = panel.getByRole('toolbar', { name: 'Diff options' }).getByRole('button', { name: 'Undo staging' });
      const box = await undo.boundingBox();
      expect(box!.y).toBeGreaterThanOrEqual(bar!.y);
      expect(box!.y + box!.height).toBeLessThanOrEqual(bar!.y + bar!.height);
      const strip = await panel.locator('.diffOverview').evaluate((ruler) => {
        const r = ruler.getBoundingClientRect();
        const stray: string[] = [];
        for (let y = r.top + 2; y < r.bottom; y += 6) {
          for (const x of [r.left + 2, (r.left + r.right) / 2, r.right - 2]) {
            for (const e of document.elementsFromPoint(x, y)) if (e.closest('.diff-toolbar, .staging-undo')) stray.push(e.tagName);
          }
        }
        return stray;
      });
      expect(strip).toEqual([]);
      await undo.click();
      await expect(fileRow(page, 'unstaged', 'new.txt')).toBeVisible();
      await panel.getByRole('button', { name: 'Redo staging' }).click();
      await expect(fileRow(page, 'staged', 'new.txt')).toBeVisible();
    });
    await test.step('while editing the working copy, Ctrl+Z is Monaco’s own undo', async () => {
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

});
