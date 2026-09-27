import { expect, test, type Page } from '@playwright/test';
import { fixtures, openUrl } from './fixtures';

// Diff prefs persist in localStorage (plan 1B amendment 3). Every test starts from the defaults
// (Inline, no toggles): the key is cleared on the test's first page load only, so a reload inside
// a test keeps what it picked.
const DIFF_PREFS_KEY = 'gitbolt.diffPrefs.v1';
const COMMIT = 'Rename guide and update assets';

const fileRow = (page: Page, path: string) => page.getByRole('option').and(page.locator(`[data-path="${path}"]`));
const diff = (page: Page) => page.getByRole('region', { name: 'Diff' });
/** The original editor's width over the modified one's. Monaco 0.57 keeps the original editor in
 * Inline and Hunk too, as a narrow strip for the old line numbers; in Split they share the width. */
const sideRatio = (page: Page) => diff(page).evaluate((d) => {
  const w = (sel: string) => d.querySelector(sel)?.getBoundingClientRect().width ?? 0;
  return w('.editor.original') / w('.editor.modified');
});
/** Monaco has computed the diff: its inserted-line decorations are drawn. */
const computed = (page: Page) => expect(diff(page).locator('.editor.modified .line-insert').first()).toBeVisible();
/** How many diffs (and prefs recomputes) the host has seen finish (`data-diff-computed`). */
const computedCount = (page: Page) => diff(page).locator('.monaco-host').first().evaluate((el) => Number((el as HTMLElement).dataset.diffComputed ?? 0));

async function selectCommit(page: Page) {
  await page.getByRole('row').filter({ hasText: COMMIT }).click();
  await expect(page.getByTestId('file-counts')).toBeVisible();
}

async function open(page: Page, path: string) {
  await fileRow(page, path).click();
  await expect(diff(page).getByTestId('diff-path')).toContainText(path.split('/').pop()!);
}

test.describe('diff viewer controls', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((key) => {
      if (sessionStorage.getItem('diff-prefs-cleared')) return;
      localStorage.removeItem(key);
      sessionStorage.setItem('diff-prefs-cleared', '1');
    }, DIFF_PREFS_KEY);
    await page.goto(openUrl(fixtures.details));
    await selectCommit(page);
  });

  test('Inline pressed by default; Hunk, Inline and Split views', async ({ page }) => {
    await open(page, 'src/app.php');
    const d = diff(page);
    await expect(d.getByRole('button', { name: 'Inline' })).toHaveAttribute('aria-pressed', 'true');
    await computed(page);
    await expect(d.locator('.diff-hidden-lines')).toHaveCount(0);
    await expect.poll(() => sideRatio(page)).toBeLessThan(0.2);
    await d.getByRole('button', { name: 'Hunk' }).click();
    await expect(d.getByRole('button', { name: 'Hunk' })).toHaveAttribute('aria-pressed', 'true');
    // Monaco 0.57's `.diff-hidden-lines` box is 0 px tall; its `.center` is the visible
    // "N hidden lines" bar (as in files.spec.ts).
    await expect(d.locator('.editor.modified .diff-hidden-lines .center').first()).toBeVisible();
    await expect.poll(() => sideRatio(page)).toBeLessThan(0.2);
    await d.getByRole('button', { name: 'Split' }).click();
    await expect.poll(() => sideRatio(page)).toBeGreaterThan(0.8);
    // Monaco 0.57 forces `minimap.enabled = false` on both of the diff's inner editors
    // (DiffEditorEditors._adjustOptionsForSubEditor); the diff's own overview ruler takes its place.
    await expect(d.locator('.monaco-diff-editor .diffOverview')).toBeVisible();
    await d.getByRole('button', { name: 'Inline' }).click();
    await expect.poll(() => sideRatio(page)).toBeLessThan(0.2);
    await expect(d.locator('.diff-hidden-lines')).toHaveCount(0);
  });

  test('the picked mode is remembered across a reload', async ({ page }) => {
    await open(page, 'src/app.php');
    await diff(page).getByRole('button', { name: 'Split' }).click();
    await expect(diff(page).getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await selectCommit(page);
    await open(page, 'src/app.php');
    const d = diff(page);
    await expect(d.getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true');
    await expect(d.getByRole('button', { name: 'Inline' })).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => sideRatio(page)).toBeGreaterThan(0.8);
  });

  test('Ignore whitespace hides a re-indentation', async ({ page }) => {
    await open(page, 'ws.txt');
    const d = diff(page);
    await d.getByRole('button', { name: 'Split' }).click();
    await expect.poll(() => d.locator('.editor.modified .line-insert').count()).toBeGreaterThan(0);
    // The diff recomputes after the toggle: wait for that result, so "no inserted lines" can't be
    // read off the gap in between.
    const before = await computedCount(page);
    await d.getByRole('button', { name: /Ignore whitespace/ }).click();
    await expect(d.getByRole('button', { name: /Ignore whitespace/ })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => computedCount(page)).toBeGreaterThan(before);
    await expect(d.locator('.editor.modified .line-insert')).toHaveCount(0);
  });

  test('Word wrap wraps the long line', async ({ page }) => {
    await open(page, 'src/app.php');
    const d = diff(page);
    await d.getByRole('button', { name: 'Split' }).click();
    const longLine = d.locator('.editor.modified .view-line', { hasText: 'long line' });
    await expect(longLine).toHaveCount(1);
    await d.getByRole('button', { name: 'Word wrap' }).click();
    await expect.poll(() => longLine.count()).toBeGreaterThan(1);
  });

  test('F7 and Shift+F7 move between changes', async ({ page }) => {
    await open(page, 'src/app.php');
    const d = diff(page);
    await d.getByRole('button', { name: 'Split' }).click();
    await computed(page);
    // A click in the diff zone puts the keyboard in the editor; F7 is still the panel's.
    await d.getByTestId('diff-path').click();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.editor.modified'))).toBe(true);
    const active = d.locator('.editor.modified .active-line-number');
    await page.keyboard.press('F7');
    await expect(active).toHaveText('5');
    await page.keyboard.press('F7');
    await expect(active).toHaveText('55');
    await page.keyboard.press('Shift+F7');
    await expect(active).toHaveText('5');
    await d.getByRole('button', { name: 'Next change' }).click();
    await expect(active).toHaveText('55');
  });

  test('F7 wraps from the last change to the first, and Shift+F7 back', async ({ page }) => {
    // src/app.php has exactly two changes, at lines 5 and 55.
    await open(page, 'src/app.php');
    const d = diff(page);
    await computed(page);
    const active = d.locator('.editor.modified .active-line-number');
    await d.getByTestId('diff-path').click();
    await page.keyboard.press('F7');
    await expect(active).toHaveText('5');
    await page.keyboard.press('F7');
    await expect(active).toHaveText('55');
    await page.keyboard.press('F7');
    await expect(active).toHaveText('5');
    await page.keyboard.press('Shift+F7');
    await expect(active).toHaveText('55');
  });

  test('a toolbar click leaves the focus in the file list: ↓ then opens the next file', async ({ page }) => {
    await open(page, 'src/app.php');
    const d = diff(page);
    await expect(page.getByRole('listbox', { name: 'Changed files' })).toBeFocused();
    await d.getByRole('button', { name: 'Split' }).click();
    await expect(d.getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('listbox', { name: 'Changed files' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(d.getByTestId('diff-path')).toContainText('ws.txt');
  });

  test('File View shows the whole file at the commit', async ({ page }) => {
    await open(page, 'src/app.php');
    const d = diff(page);
    await d.getByRole('button', { name: 'File View' }).click();
    await expect(d.getByTestId('file-view')).toContainText('enum Suit: string');
    await d.getByRole('button', { name: 'Diff View' }).click();
    await expect(d.getByTestId('text-diff')).toBeVisible();
  });

  test('an unchanged file from View all files has Diff View disabled', async ({ page }) => {
    await page.getByRole('button', { name: 'View all files' }).click();
    await open(page, 'latin1.txt');
    const d = diff(page);
    await expect(d.getByTestId('file-view')).toBeVisible();
    await expect(d.getByRole('button', { name: 'File View' })).toHaveAttribute('aria-pressed', 'true');
    await expect(d.getByRole('button', { name: 'Diff View' })).toBeDisabled();
  });

  test('an EOL-only change shows a banner', async ({ page }) => {
    await open(page, 'crlf.txt');
    await expect(diff(page).getByRole('note')).toHaveText('Only line endings changed (CRLF → LF)');
  });

  test('a large file asks before loading', async ({ page }) => {
    await open(page, 'big.txt');
    const d = diff(page);
    await expect(d.getByText('Large file — load anyway?')).toBeVisible();
    await d.getByRole('button', { name: 'Load anyway' }).click();
    await expect(d.getByTestId('text-diff')).toContainText('line 00000 of the big file');
  });

  test('a binary file shows its sizes', async ({ page }) => {
    await open(page, 'data.bin');
    await expect(diff(page).getByTestId('binary-summary')).toHaveText('Binary file · 9 B → 10 B');
  });
});
