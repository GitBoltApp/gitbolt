import { freshFixture, git, openUrl } from './fixtures';
import { expect, test } from './test';
import { fileRow } from './wip';

const stop = (repo: string, ...args: string[]) => {
  try {
    git(repo, ...args);
  } catch {
    /* a conflict stops it: the point */
  }
};

test.describe('conflicts (spec #2 §13.2)', () => {
  test('a stopped merge shows the banner; Commit is disabled until resolved; Abort ends it', async ({ page }) => {
    const repo = freshFixture('conflicts');
    stop(repo, 'merge', '--no-edit', 'feature/x');
    await page.goto(openUrl(repo));
    const banner = page.getByRole('region', { name: 'Merge in progress' });
    await expect(banner).toContainText('Merging feature/x into main: 3 conflicted files.');
    await expect(banner.getByRole('button', { name: 'Commit' })).toHaveAttribute('aria-disabled', 'true');
    expect(git(repo, 'diff', '--name-only', '--diff-filter=U').split('\n')).toEqual(['a.txt', 'gone.txt', 'logo.bin']);
    await banner.getByRole('button', { name: 'Abort' }).click();
    await expect(banner).toBeHidden();
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  test('a rebase stopped by git shows Continue, Skip and Abort', async ({ page }) => {
    const repo = freshFixture('conflicts');
    git(repo, 'switch', '-q', 'feature/x');
    stop(repo, 'rebase', 'main');
    await page.goto(openUrl(repo));
    const banner = page.getByRole('region', { name: 'Rebase in progress' });
    await expect(banner).toContainText(/Rebasing feature\/x onto main: step 1 of 1, stopped at [0-9a-f]{7} Feature edits\./);
    await expect(banner.getByRole('button', { name: 'Continue' })).toHaveAttribute('aria-disabled', 'true');
    await expect(banner.getByRole('button', { name: 'Skip' })).toBeEnabled();
    await banner.getByRole('button', { name: 'Abort' }).click();
    await expect(banner).toBeHidden();
  });

  // --- 2D T20 ---
  test('the merge tool resolves a text conflict by ticks and a hand edit; non-text ones by buttons', async ({ page }) => {
    const repo = freshFixture('conflicts');
    stop(repo, 'merge', '--no-edit', 'feature/x');
    await page.goto(openUrl(repo));
    await page.getByRole('grid', { name: 'Commit graph' }).getByRole('row').filter({ hasText: '// WIP' }).locator('[data-col="message"]').click({ position: { x: 3, y: 3 } });
    await fileRow(page, 'conflicted', 'a.txt').click();
    const tool = page.getByRole('region', { name: 'Merge tool' });
    await expect(tool.getByText('Current: main')).toBeVisible();
    await expect(tool.getByText('Incoming: feature/x')).toBeVisible();
    const current = tool.getByRole('region', { name: 'Current' });
    const incoming = tool.getByRole('region', { name: 'Incoming' });
    // The output's rendered lines in line order (Monaco reuses line nodes out of DOM order, and
    // paints spaces as no-break spaces).
    const outputText = () => tool.getByRole('region', { name: 'Output' }).locator('.view-lines').evaluate((el) =>
      [...el.querySelectorAll<HTMLElement>('.view-line')]
        .sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top))
        .map((l) => (l.textContent ?? '').replace(/\u00a0/g, ' '))
        .join('\n'));
    // A hunk checkbox (its view zone, real Monaco): conflict 1 from Incoming.
    await incoming.getByRole('checkbox', { name: 'Take conflict 1 from Incoming' }).click();
    await expect.poll(outputText).toContain('incoming three');
    // Conflict 2 has nothing picked: the save asks first.
    await page.keyboard.press('Control+S');
    const ask = page.getByRole('alertdialog');
    await expect(ask).toContainText('1 conflict has no lines picked. Save it empty?');
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(ask).toBeHidden();
    // A line's checkbox in the glyph margin: conflict 1's Current line joins it, before Incoming's.
    await current.locator('.merge-check').first().click();
    await expect.poll(outputText).toMatch(/current three\s+incoming three/);
    // The region is rebuilt: unticking Incoming's hunk leaves Current's line alone.
    await incoming.getByRole('checkbox', { name: 'Take conflict 1 from Incoming' }).click();
    await expect.poll(outputText).not.toContain('incoming three');
    await expect.poll(outputText).toContain('current three');
    // F7 steps from the output's cursor (still on line 1): conflict 1, then conflict 2, which
    // comes into view; take it from Current.
    await page.keyboard.press('F7');
    await page.keyboard.press('F7');
    await current.getByRole('checkbox', { name: 'Take conflict 2 from Current' }).click();
    await expect.poll(outputText).toContain('current fifteen');
    await expect(tool.getByRole('checkbox', { name: 'Take all from this side' }).first()).toBeChecked();
    // A click puts the focus in the output editor (its hidden textarea isn't where keys go).
    await tool.getByRole('region', { name: 'Output' }).locator('.view-lines').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('hand edit\n');
    await page.keyboard.press('Control+S');
    await expect.poll(() => git(repo, 'diff', '--name-only', '--diff-filter=U')).not.toContain('a.txt');
    const text = git(repo, 'show', ':0:a.txt');
    expect(text).toContain('current three');
    expect(text).toContain('current fifteen');
    expect(text).not.toContain('incoming three');
    expect(text).toContain('hand edit');
    await fileRow(page, 'conflicted', 'logo.bin').click();
    await tool.getByRole('button', { name: 'Take incoming' }).click();
    await expect.poll(() => git(repo, 'diff', '--name-only', '--diff-filter=U')).not.toContain('logo.bin');
    await fileRow(page, 'conflicted', 'gone.txt').click();
    await expect(tool.getByText('Deleted in main, modified in feature/x')).toBeVisible();
    await tool.getByRole('button', { name: 'Delete file' }).click();
    await expect.poll(() => git(repo, 'diff', '--name-only', '--diff-filter=U')).toBe('');
    await expect(page.getByRole('region', { name: 'Merge in progress' }).getByRole('button', { name: 'Commit' })).not.toHaveAttribute('aria-disabled', 'true');
  });
  // --- end 2D T20 ---
});
