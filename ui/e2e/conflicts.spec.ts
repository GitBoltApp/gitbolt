import { freshFixture, git, openUrl } from './fixtures';
import { expect, test, confirmArmed, armedOverlay } from './test';
import { fileRow } from './wip';

const stop = (repo: string, ...args: string[]) => {
  try {
    git(repo, ...args);
  } catch {
    /* a conflict stops it: the point */
  }
};

test.describe('conflicts (spec #2 §13.2)', () => {
  test('a stopped merge shows in the commit panel; Commit and merge is disabled until resolved; Abort ends it', async ({ page }) => {
    const repo = freshFixture('conflicts');
    stop(repo, 'merge', '--no-edit', 'feature/x');
    await page.goto(openUrl(repo));
    // Ux round 1: no window-wide bar; the WIP is selected and its commit panel holds the merge.
    const status = page.getByRole('region', { name: 'Merge in progress' });
    await expect(status).toContainText('Merging feature/x into main');
    await expect(status).toContainText('Resolve 3 conflicted files first');
    const box = page.getByTestId('commit-box');
    await expect(box.getByRole('button', { name: 'Commit and merge' })).toHaveAttribute('aria-disabled', 'true');
    expect(git(repo, 'diff', '--name-only', '--diff-filter=U').split('\n')).toEqual(['a.txt', 'gone.txt', 'logo.bin']);
    // Abort arms in place (spec §ui confirms, board D); the second click runs it.
    await box.getByRole('button', { name: 'Abort merge' }).click();
    await confirmArmed(armedOverlay(page, 'Click again to abort the merge'));
    await expect(status).toBeHidden();
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  test('a rebase stopped by git: its message in the box, Continue rebase, Skip and Abort', async ({ page }) => {
    const repo = freshFixture('conflicts');
    git(repo, 'switch', '-q', 'feature/x');
    stop(repo, 'rebase', 'main');
    await page.goto(openUrl(repo));
    const status = page.getByRole('region', { name: 'Rebase in progress' });
    await expect(status).toContainText('Rebasing feature/x onto main (step 1 of 1)');
    await expect(status).toContainText(/Stopped at [0-9a-f]{7} Feature edits/);
    const box = page.getByTestId('commit-box');
    await expect(box.getByRole('textbox', { name: 'Commit summary' })).toHaveValue('Feature edits');
    await expect(box.getByRole('button', { name: 'Continue rebase' })).toHaveAttribute('aria-disabled', 'true');
    await expect(box.getByRole('button', { name: 'Skip' })).toBeEnabled();
    await box.getByRole('button', { name: 'Abort rebase' }).click();
    await confirmArmed(armedOverlay(page, 'Click again to abort the rebase'));
    await expect(status).toBeHidden();
  });

  test('Continue rebase commits the stopped pick with the message as edited', async ({ page }) => {
    const repo = freshFixture('conflicts');
    git(repo, 'switch', '-q', 'feature/x');
    stop(repo, 'rebase', 'main');
    await page.goto(openUrl(repo));
    const box = page.getByTestId('commit-box');
    await expect(box.getByRole('textbox', { name: 'Commit summary' })).toHaveValue('Feature edits');
    git(repo, 'add', '-A');
    const status = page.getByRole('region', { name: 'Rebase in progress' });
    await expect(status).toContainText('No conflicted files left: it is paused. Continue to go on.');
    await box.getByRole('textbox', { name: 'Commit summary' }).fill('Feature edits, resolved');
    await box.getByRole('button', { name: 'Continue rebase' }).click();
    await expect(status).toBeHidden();
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Feature edits, resolved');
  });

  // --- 2D T20 ---
  test('the merge tool resolves a text conflict by ticks and a hand edit; non-text ones by buttons', async ({ page }) => {
    const repo = freshFixture('conflicts');
    stop(repo, 'merge', '--no-edit', 'feature/x');
    await page.goto(openUrl(repo));
    // A new stop selects the WIP and opens no file (H.1); open a.txt.
    const tool = page.getByRole('region', { name: 'Merge tool' });
    await expect(page.getByTestId('wip-header')).toBeVisible({ timeout: 15_000 });
    await expect(tool).toBeHidden();
    await fileRow(page, 'conflicted', 'a.txt').click();
    await expect(fileRow(page, 'conflicted', 'a.txt')).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
    // The first open loads Monaco's chunk, which a cold dev server can take over 5 s to serve.
    await expect(tool.getByText('Current: main')).toBeVisible({ timeout: 15_000 });
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
    // A hunk checkbox (a glyph-margin widget, real Monaco): conflict 1 from Incoming.
    await incoming.getByRole('checkbox', { name: 'Take conflict 1 from Incoming' }).click();
    await expect.poll(outputText).toContain('incoming three');
    // Conflict 2 has nothing picked: the save asks first.
    await page.keyboard.press('Control+S');
    const ask = page.getByRole('alertdialog');
    await expect(ask).toContainText('1 conflict is still unresolved (nothing picked or typed): it will be saved empty.');
    await expect(ask.getByRole('button', { name: 'Mark resolved anyway' })).toBeVisible();
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(ask).toBeHidden();
    // A line's green + in the gutter: conflict 1's Current line joins it, before Incoming's.
    await current.locator('.merge-line-btn.take').first().click();
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
    // UX round 2: a resolved file moves the tool to the next conflicted one (gone.txt, then
    // logo.bin), and closes it once none is left.
    await expect(tool.getByText('Deleted in main (current), modified in feature/x (incoming)')).toBeVisible();
    await tool.getByRole('button', { name: 'Delete file' }).click();
    await expect.poll(() => git(repo, 'diff', '--name-only', '--diff-filter=U')).not.toContain('gone.txt');
    await expect(tool.getByText('Changed in both main (current) and feature/x (incoming) (not text)')).toBeVisible();
    await tool.getByRole('button', { name: 'Take incoming' }).click();
    await expect.poll(() => git(repo, 'diff', '--name-only', '--diff-filter=U')).toBe('');
    await expect(tool).toBeHidden();
    await expect(page.getByTestId('commit-box').getByRole('button', { name: 'Commit and merge' })).not.toHaveAttribute('aria-disabled', 'true');
  });
  // --- end 2D T20 ---
});
