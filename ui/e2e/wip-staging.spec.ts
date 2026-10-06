import { budgetApplies, expect, test, confirmArmed, armedOverlay } from './test';
import { git } from './fixtures';
import { fileRow, fileRowSelector, openWip, section, timedClick } from './wip';

test.describe('WIP staging (spec #2 §7.1, §7.2)', () => {
  // One repo and page for these (each was a test of its own, paying for a page load), in an order
  // where each starts from what it needs: the reversible ones first, Stage all / Unstage all last.
  test('staging whole files: hover Stage and Unstage, the file menu, no revert arrow, the diff moves on, a tree folder, Stage all and Unstage all', async ({ page }) => {
    const repo = await openWip(page);
    await test.step('hover Stage and Unstage move whole files', async () => {
      await fileRow(page, 'unstaged', 'new.txt').hover();
      await page.getByRole('button', { name: 'Stage new.txt' }).click();
      await expect(fileRow(page, 'staged', 'new.txt')).toBeVisible();
      await expect(fileRow(page, 'unstaged', 'new.txt')).toHaveCount(0);
      expect(git(repo, 'diff', '--cached', '--name-only')).toContain('new.txt');
      await fileRow(page, 'staged', 'new.txt').hover();
      await page.getByRole('button', { name: 'Unstage new.txt' }).click();
      await expect(fileRow(page, 'unstaged', 'new.txt')).toBeVisible();
    });
    await test.step('the file menu stages a file, from the keyboard too', async () => {
      await fileRow(page, 'unstaged', 'new.txt').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Stage' }).click();
      await expect(fileRow(page, 'staged', 'new.txt')).toBeVisible();
      await fileRow(page, 'staged', 'new.txt').click();
      await page.keyboard.press('Shift+F10');
      await page.getByRole('menuitem', { name: 'Unstage' }).click();
      await expect(fileRow(page, 'unstaged', 'new.txt')).toBeVisible();
    });
    await test.step('an unstaged diff has no unlabeled revert arrow in its gutter', async () => {
      await fileRow(page, 'unstaged', 'new.txt').click();
      await expect(page.getByTestId('diff-path')).toContainText('new.txt');
      const editor = page.locator('.monaco-diff-editor').first();
      await expect(editor.locator('.view-lines').first()).toBeVisible();
      const box = await editor.boundingBox();
      // Sweep the pointer across the editor: Monaco's gutter menu and revert icon show on hover.
      for (let x = 0.1; x < 1; x += 0.1) await page.mouse.move(box!.x + box!.width * x, box!.y + 20);
      await expect(editor.locator('.gutter .codicon, .codicon-arrow-right, .codicon-arrow-left, .codicon-discard')).toHaveCount(0);
    });
    await test.step('the open diff moves on to the next unstaged file after a whole-file stage', async () => {
      await fileRow(page, 'unstaged', 'space name.txt').click();
      await expect(page.getByTestId('diff-path')).toContainText('space name.txt');
      await fileRow(page, 'unstaged', 'space name.txt').hover();
      await page.getByRole('button', { name: 'Stage space name.txt' }).click();
      await expect(fileRow(page, 'staged', 'space name.txt')).toBeVisible();
      await expect(page.getByTestId('diff-path')).not.toContainText('space name.txt');
      await expect(section(page, 'unstaged').locator('.file-row[aria-selected="true"]')).toHaveCount(1);
    });
    await test.step('a tree-mode folder row stages every file under it', async () => {
      await page.getByRole('button', { name: 'Tree', exact: true }).click();
      const folder = section(page, 'unstaged').locator('.file-row[data-kind="folder"][data-path="src"]');
      await folder.hover();
      await page.getByRole('button', { name: 'Stage src' }).click();
      await expect(section(page, 'staged').locator('.file-row[data-path="src"]')).toBeVisible();
    });
    await test.step('Stage all and Unstage all', async () => {
      await section(page, 'unstaged').getByRole('button', { name: 'Stage all' }).click();
      await expect(section(page, 'unstaged').locator('.file-row')).toHaveCount(0);
      await section(page, 'staged').getByRole('button', { name: 'Unstage all' }).click();
      await expect(section(page, 'staged').locator('.file-row')).toHaveCount(0);
      expect(git(repo, 'diff', '--cached')).toBe('');
    });
  });

  test('with "After staging a file, show the next one" off, the diff follows the file to Staged', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('gitbolt.fileList.v1', JSON.stringify({ mode: 'path', sort: 'path', advanceAfterStage: false })));
    await openWip(page);
    await fileRow(page, 'unstaged', 'space name.txt').click();
    await expect(page.getByTestId('diff-path')).toContainText('space name.txt');
    await fileRow(page, 'unstaged', 'space name.txt').hover();
    await page.getByRole('button', { name: 'Stage space name.txt' }).click();
    await expect(fileRow(page, 'staged', 'space name.txt')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('diff-path')).toContainText('space name.txt');
  });

  test('budget (§16): stage a file < 100 ms, best of 3', { tag: '@budget' }, async ({ page }) => {
    await openWip(page);
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      await fileRow(page, 'unstaged', 'new.txt').hover();
      runs.push(await timedClick(page, page.getByRole('button', { name: 'Stage new.txt' }), fileRowSelector('staged', 'new.txt')));
      await expect(fileRow(page, 'staged', 'new.txt')).toBeVisible();
      await fileRow(page, 'staged', 'new.txt').hover();
      await page.getByRole('button', { name: 'Unstage new.txt' }).click();
      await expect(fileRow(page, 'unstaged', 'new.txt')).toBeVisible();
    }
    console.log(`[budget] stage a file: ${runs.map((n) => n.toFixed(1)).join(', ')} ms`);
    if (budgetApplies()) expect(Math.min(...runs), `runs: ${runs.map((n) => n.toFixed(1)).join(', ')}`).toBeLessThan(100);
  });
});

test.describe('Conflicted, discards and the file menu (spec #2 §7.1, §7.2)', () => {
  // One repo and page for both (each was a test of its own, paying for a page load).
  test('conflicted files come first, in their own section, with their kind; Stage all leaves them conflicted', async ({ page }) => {
    const repo = await openWip(page, 'wip_conflict');
    await test.step('conflicted files come first, in their own section, with their kind', async () => {
      await expect(section(page, 'conflicted')).toContainText('Conflicted (1)');
      await expect(fileRow(page, 'conflicted', 'c.txt')).toContainText('changed in both');
      await expect(fileRow(page, 'unstaged', 'c.txt')).toHaveCount(0);
      await expect(fileRow(page, 'unstaged', 'side.txt')).toBeVisible();
    });
    await test.step('Stage all leaves the conflicted files conflicted', async () => {
      await section(page, 'unstaged').getByRole('button', { name: 'Stage all' }).click();
      await expect(fileRow(page, 'staged', 'side.txt')).toBeVisible();
      await expect(fileRow(page, 'conflicted', 'c.txt')).toBeVisible();
      expect(git(repo, 'diff', '--name-only', '--diff-filter=U')).toBe('c.txt');
    });
  });

  // One repo and page for both (each was a test of its own, paying for a page load): the row's
  // Discard first, then Discard all of what is left.
  test('a row’s Discard arms in place and Discard unstaged keeps the staged half; Discard all arms in place, Esc disarms, a second click discards', async ({ page }) => {
    const repo = await openWip(page);
    await test.step('a row’s Discard arms in place; Discard unstaged keeps the staged half', async () => {
      await fileRow(page, 'unstaged', 'space name.txt').hover();
      await page.getByRole('button', { name: 'Discard space name.txt' }).click();
      await confirmArmed(armedOverlay(page, 'Click again to discard space name.txt'));
      await expect(fileRow(page, 'unstaged', 'space name.txt')).toHaveCount(0);
      await section(page, 'unstaged').getByRole('button', { name: 'Discard unstaged' }).click();
      await expect(section(page, 'unstaged').locator('.file-row')).toHaveCount(0);
      expect(git(repo, 'status', '--porcelain')).toBe('M  notes.txt');
    });
    await test.step('Discard all arms in place: Esc disarms, a second click discards', async () => {
      await page.getByTestId('wip-header').getByRole('button', { name: 'Discard all' }).click();
      const armed = armedOverlay(page, /^Click again to discard \d+ files?$/);
      await expect(armed).toBeVisible();
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(armed).toBeHidden();
      expect(git(repo, 'status', '--porcelain')).not.toBe('');
      await page.getByTestId('wip-header').getByRole('button', { name: 'Discard all' }).click();
      await confirmArmed(armed);
      await expect.poll(() => git(repo, 'status', '--porcelain')).toBe('');
    });
  });
});
