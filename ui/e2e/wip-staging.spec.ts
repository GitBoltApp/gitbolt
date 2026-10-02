import { expect, test } from './test';
import { git } from './fixtures';
import { fileRow, fileRowSelector, openWip, section, timedClick } from './wip';

test.describe('WIP staging (spec #2 §7.1, §7.2)', () => {
  test('hover Stage and Unstage move whole files', async ({ page }) => {
    const repo = await openWip(page);
    await fileRow(page, 'unstaged', 'new.txt').hover();
    await page.getByRole('button', { name: 'Stage new.txt' }).click();
    await expect(fileRow(page, 'staged', 'new.txt')).toBeVisible();
    await expect(fileRow(page, 'unstaged', 'new.txt')).toHaveCount(0);
    expect(git(repo, 'diff', '--cached', '--name-only')).toContain('new.txt');
    await fileRow(page, 'staged', 'new.txt').hover();
    await page.getByRole('button', { name: 'Unstage new.txt' }).click();
    await expect(fileRow(page, 'unstaged', 'new.txt')).toBeVisible();
  });

  test('Stage all and Unstage all', async ({ page }) => {
    const repo = await openWip(page);
    await section(page, 'unstaged').getByRole('button', { name: 'Stage all' }).click();
    await expect(section(page, 'unstaged').locator('.file-row')).toHaveCount(0);
    await section(page, 'staged').getByRole('button', { name: 'Unstage all' }).click();
    await expect(section(page, 'staged').locator('.file-row')).toHaveCount(0);
    expect(git(repo, 'diff', '--cached')).toBe('');
  });

  test('a tree-mode folder row stages every file under it', async ({ page }) => {
    await openWip(page);
    await page.getByRole('button', { name: 'Tree', exact: true }).click();
    const folder = section(page, 'unstaged').locator('.file-row[data-kind="folder"][data-path="src"]');
    await folder.hover();
    await page.getByRole('button', { name: 'Stage src' }).click();
    await expect(section(page, 'staged').locator('.file-row[data-path="src"]')).toBeVisible();
  });

  test('the open diff follows a fully staged file to Staged', async ({ page }) => {
    await openWip(page);
    await fileRow(page, 'unstaged', 'space name.txt').click();
    await expect(page.getByTestId('diff-path')).toContainText('space name.txt');
    await fileRow(page, 'unstaged', 'space name.txt').hover();
    await page.getByRole('button', { name: 'Stage space name.txt' }).click();
    await expect(fileRow(page, 'staged', 'space name.txt')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('diff-path')).toContainText('space name.txt');
  });

  test('budget (§16): stage a file < 100 ms, best of 3', async ({ page }) => {
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
    expect(Math.min(...runs), `runs: ${runs.map((n) => n.toFixed(1)).join(', ')}`).toBeLessThan(100);
  });
});

test.describe('Conflicted, discards and the file menu (spec #2 §7.1, §7.2)', () => {
  test('conflicted files come first, in their own section, with their kind', async ({ page }) => {
    await openWip(page, 'wip_conflict');
    await expect(section(page, 'conflicted')).toContainText('Conflicted (1)');
    await expect(fileRow(page, 'conflicted', 'c.txt')).toContainText('both modified');
    await expect(fileRow(page, 'unstaged', 'c.txt')).toHaveCount(0);
    await expect(fileRow(page, 'unstaged', 'side.txt')).toBeVisible();
  });

  test('Stage all leaves the conflicted files conflicted', async ({ page }) => {
    const repo = await openWip(page, 'wip_conflict');
    await section(page, 'unstaged').getByRole('button', { name: 'Stage all' }).click();
    await expect(fileRow(page, 'staged', 'side.txt')).toBeVisible();
    await expect(fileRow(page, 'conflicted', 'c.txt')).toBeVisible();
    expect(git(repo, 'diff', '--name-only', '--diff-filter=U')).toBe('c.txt');
  });

  test('a row’s Discard needs no confirmation; Discard unstaged keeps the staged half', async ({ page }) => {
    const repo = await openWip(page);
    await fileRow(page, 'unstaged', 'space name.txt').hover();
    await page.getByRole('button', { name: 'Discard space name.txt' }).click();
    await expect(fileRow(page, 'unstaged', 'space name.txt')).toHaveCount(0);
    await section(page, 'unstaged').getByRole('button', { name: 'Discard unstaged' }).click();
    await expect(section(page, 'unstaged').locator('.file-row')).toHaveCount(0);
    expect(git(repo, 'status', '--porcelain')).toBe('M  notes.txt');
  });

  test('Discard all confirms', async ({ page }) => {
    const repo = await openWip(page);
    await page.getByTestId('wip-header').getByRole('button', { name: 'Discard all' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('Staged, unstaged and untracked changes are removed. You can undo this.');
    await page.getByRole('button', { name: 'Cancel' }).click();
    expect(git(repo, 'status', '--porcelain')).not.toBe('');
    await page.getByTestId('wip-header').getByRole('button', { name: 'Discard all' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard all' }).click();
    await expect.poll(() => git(repo, 'status', '--porcelain')).toBe('');
  });

  test('the file menu stages a file, from the keyboard too', async ({ page }) => {
    await openWip(page);
    await fileRow(page, 'unstaged', 'new.txt').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Stage' }).click();
    await expect(fileRow(page, 'staged', 'new.txt')).toBeVisible();
    await fileRow(page, 'staged', 'new.txt').click();
    await page.keyboard.press('Shift+F10');
    await page.getByRole('menuitem', { name: 'Unstage' }).click();
    await expect(fileRow(page, 'unstaged', 'new.txt')).toBeVisible();
  });
});
