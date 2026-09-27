import { expect, test, type Page } from '@playwright/test';
import { fixtures, openUrl } from './fixtures';

// Diff prefs persist in localStorage (plan 1B amendment 3). Playwright gives every test a fresh
// browser context, so each test starts from the default (Inline) unless it stores a mode itself.
const DIFF_PREFS_KEY = 'gitbolt.diffPrefs.v1';

async function selectRow(page: Page, text: string) {
  await page.getByRole('row').filter({ hasText: text }).click();
}
const fileRow = (page: Page, path: string) => page.getByRole('option').and(page.locator(`[data-path="${path}"]`));

test.describe('file list and diff takeover', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(openUrl(fixtures.details));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
  });

  test('the header counts changes and renames read old → new', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    await expect(page.getByTestId('file-counts')).toHaveText('6 modified · 2 added · 1 deleted · 1 renamed');
    await expect(page.getByTestId('file-totals')).toContainText('+');
    await expect(fileRow(page, 'docs/manual.txt')).toContainText('docs/guide.txt → docs/manual.txt');
    await expect(fileRow(page, 'logo.png')).toHaveAttribute('title', 'binary');
  });

  test('opening a file takes over the center with a Shiki-highlighted Inline diff (the default)', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    await fileRow(page, 'src/app.php').click();
    const diff = page.getByRole('region', { name: 'Diff' });
    await expect(diff).toBeVisible();
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeHidden();
    await expect(diff.getByTestId('diff-path')).toContainText('app.php');
    await expect(diff.getByTestId('diff-encoding')).toHaveText('UTF-8');
    await expect(diff.locator('.monaco-diff-editor')).toBeVisible();
    const keyword = diff.locator('.editor.modified .view-line span span').filter({ hasText: /^function$/ }).first();
    await expect(keyword).toHaveCSS('color', 'rgb(86, 156, 214)');
    // Inline: once the diff is computed (its inserted-line decorations are drawn), nothing is
    // folded away.
    await expect(diff.locator('.editor.modified .line-insert').first()).toBeVisible();
    await expect(diff.locator('.diff-hidden-lines')).toHaveCount(0);
  });

  test('a remembered Hunk mode folds the unchanged regions', async ({ page }) => {
    await page.evaluate(([key]) => localStorage.setItem(key, JSON.stringify({ mode: 'hunk', ignoreWhitespace: false, wordWrap: false })), [DIFF_PREFS_KEY]);
    await page.reload();
    await selectRow(page, 'Rename guide and update assets');
    await fileRow(page, 'src/app.php').click();
    const diff = page.getByRole('region', { name: 'Diff' });
    await expect(diff.locator('.monaco-diff-editor')).toBeVisible();
    // Monaco 0.57's `.diff-hidden-lines` box is 0 px tall; its `.center` is the visible
    // "N hidden lines" bar. Checked in the modified editor, the one that holds the text.
    await expect(diff.locator('.editor.modified .diff-hidden-lines .center').first()).toBeVisible();
  });

  test('Up/Down in the file list opens the next file immediately', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    await fileRow(page, 'crlf.txt').click();
    const path = page.getByTestId('diff-path');
    await expect(path).toContainText('crlf.txt');
    await page.keyboard.press('ArrowDown');
    await expect(path).toContainText('data.bin');
    await page.keyboard.press('ArrowUp');
    await expect(path).toContainText('crlf.txt');
  });

  test('× closes the diff; Enter in the graph opens the first file and → focuses the files', async ({ page }) => {
    await selectRow(page, "Merge branch 'feature/x'");
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('diff-path')).toContainText('feature.txt');
    await page.getByRole('button', { name: 'Close diff' }).click();
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('listbox', { name: 'Changed files' })).toBeFocused();
  });

  test('after Esc, Enter opens the first file as displayed (Tree mode) and the list highlights it', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    await page.getByRole('button', { name: 'Tree' }).click();
    await fileRow(page, 'src/app.php').click();
    await expect(page.getByTestId('diff-path')).toContainText('app.php');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeFocused();
    await page.keyboard.press('Enter');
    // Folders first: "dir with space/ünï.txt" leads the tree (the backend's first is big.txt).
    await expect(page.getByTestId('diff-path')).toContainText('ünï.txt');
    await expect(fileRow(page, 'dir with space/ünï.txt')).toHaveAttribute('aria-selected', 'true');
    await expect(fileRow(page, 'src/app.php')).toHaveAttribute('aria-selected', 'false');
    await expect(page.getByRole('listbox', { name: 'Changed files' })).toBeFocused();
  });

  test('tree mode nests folders and ←/→ collapse and expand them', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    await page.getByRole('button', { name: 'Tree' }).click();
    const docs = fileRow(page, 'docs');
    await expect(docs).toHaveAttribute('aria-expanded', 'true');
    await docs.click();
    await expect(docs).toHaveAttribute('aria-expanded', 'false');
    await expect(fileRow(page, 'docs/manual.txt')).toHaveCount(0);
    await page.keyboard.press('ArrowRight');
    await expect(docs).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: 'Collapse all' }).click();
    await expect(fileRow(page, 'src/app.php')).toHaveCount(0);
  });

  test('a merge commit diffs against the parent picked', async ({ page }) => {
    await selectRow(page, "Merge branch 'feature/x'");
    await expect(page.getByRole('button', { name: 'vs 1st parent' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.getByRole('button', { name: 'vs 2nd parent' }).click();
    await expect(page.getByTestId('file-counts')).toHaveText('6 modified · 2 added · 1 deleted · 1 renamed');
  });

  test('View all files opens unchanged files in File View with their encoding', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    await page.getByRole('button', { name: 'View all files' }).click();
    await expect(page.getByRole('option')).toHaveCount(12);
    await fileRow(page, 'latin1.txt').click();
    await expect(page.getByTestId('diff-encoding')).toHaveText('ISO-8859-1');
    await expect(page.getByTestId('file-view')).toContainText('café crème brûlée');
    await fileRow(page, 'utf16.txt').click();
    await expect(page.getByTestId('diff-encoding')).toHaveText('UTF-16LE');
  });
});

test('Esc returns to the graph with its selection and scroll position unchanged', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 500 });
  await page.goto(openUrl(fixtures.longHistory));
  const grid = page.getByRole('grid', { name: 'Commit graph' });
  await expect(grid).toBeVisible();
  await grid.evaluate((el) => { el.scrollTop = 600; });
  await page.getByRole('row').filter({ hasText: 'Commit 30' }).click();
  const top = await grid.evaluate((el) => el.scrollTop);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Diff' })).toBeVisible();
  // The hidden graph hands focus to the file list, so Escape has somewhere to land.
  await expect(page.getByRole('listbox', { name: 'Changed files' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(grid).toBeVisible();
  await expect(grid).toBeFocused();
  expect(await grid.evaluate((el) => el.scrollTop)).toBe(top);
  await expect(page.getByRole('row').filter({ hasText: 'Commit 30' })).toHaveAttribute('aria-selected', 'true');
});
