import { freshFixture, git, openUrl } from './fixtures';
import { armedOverlay, expect, test } from './test';
import { fileRow } from './wip';

test.describe('cherry-pick (spec #3 §3.7, §7 e2e flow 4)', () => {
  test('a conflicting cherry-pick stops into the merge tool; Continue commits it; one Undo takes it back', async ({ page }) => {
    // HEAD is main; feature/x's "Feature edits" conflicts with main in a.txt (text), gone.txt
    // (deleted on main) and logo.bin (binary).
    const repo = freshFixture('conflicts');
    const before = git(repo, 'rev-parse', 'main');
    await page.goto(openUrl(repo));
    const graph = page.getByRole('grid', { name: 'Commit graph' });
    await graph.getByText('Feature edits', { exact: true }).click({ button: 'right' });
    await page.locator('.ctx-row[data-row-id="commit.cherryPick"] .ctx-label').click();
    const status = page.getByRole('region', { name: 'Cherry-pick in progress' });
    await expect(status).toContainText('Resolve 3 conflicted files first');
    // The stop opens no file (H.1): the WIP is selected; open a.txt in the merge tool.
    await expect(page.getByTestId('wip-header')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('region', { name: 'Merge tool' })).toBeHidden();
    await fileRow(page, 'conflicted', 'a.txt').click();
    const tool = page.getByRole('region', { name: 'Merge tool' });
    await expect(fileRow(page, 'conflicted', 'a.txt')).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
    await expect(tool.getByText('Current: main')).toBeVisible({ timeout: 15_000 });
    await tool.getByRole('region', { name: 'Incoming' }).getByRole('checkbox', { name: 'Take all from this side' }).click();
    await page.keyboard.press('Control+S');
    await expect.poll(() => git(repo, 'diff', '--name-only', '--diff-filter=U')).not.toContain('a.txt');
    await tool.getByRole('button', { name: 'Delete file' }).click();
    await expect.poll(() => git(repo, 'diff', '--name-only', '--diff-filter=U')).not.toContain('gone.txt');
    await tool.getByRole('button', { name: 'Take incoming' }).click();
    await expect.poll(() => git(repo, 'diff', '--name-only', '--diff-filter=U')).toBe('');
    await page.getByTestId('commit-box').getByRole('button', { name: 'Continue cherry-pick' }).click();
    await expect(status).toBeHidden();
    // UX R1 C.3: the right-clicked row's context outline went with its menu (the merge tool hid
    // the graph meanwhile).
    if (!(await graph.isVisible())) await page.keyboard.press('Escape');
    await expect(graph).toBeVisible();
    await expect(graph.locator('.graph-row.is-context')).toHaveCount(0);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Feature edits');
    expect(git(repo, 'rev-parse', 'HEAD~1')).toBe(before);
    // One Undo takes the whole cherry-pick back (spec #3 §5).
    await page.getByRole('toolbar', { name: 'Repository toolbar' }).getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => git(repo, 'rev-parse', 'main')).toBe(before);
  });

  // UX R1 C.1, C.2: without committing, the staged changes are shown at once (the WIP row
  // selected, no file opened (H.1)); Discard all then takes the
  // added file at the first confirm, at a human pace, even with GNOME's focus bounce: every press
  // makes the window lose focus and get it back a few ms later, back on the focused element
  // (windowBlur.ts). That focusin, before the confirm's click, used to disarm it.
  test('a pick without committing shows its changes; Discard all clears them at the first confirm', async ({ page }) => {
    const repo = freshFixture('stack');
    await page.goto(openUrl(repo));
    const graph = page.getByRole('grid', { name: 'Commit graph' });
    await graph.getByText('Main moves', { exact: true }).click({ button: 'right' });
    await page.locator('.ctx-row[data-row-id="commit.cherryPick"] [data-variant-id="noCommit"]').click();
    await expect(fileRow(page, 'staged', 'main.txt')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('wip-header')).toBeVisible();
    await expect(page.getByTestId('diff-path')).toHaveCount(0);
    expect(git(repo, 'status', '--porcelain')).toBe('A  main.txt');
    await page.evaluate(() => {
      window.addEventListener('pointerdown', () => {
        const el = document.activeElement;
        window.dispatchEvent(new FocusEvent('blur'));
        el?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        setTimeout(() => {
          window.dispatchEvent(new FocusEvent('focus'));
          el?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        }, 5);
      }, true);
    });
    const box = (await page.getByTestId('wip-header').getByRole('button', { name: 'Discard all' }).boundingBox())!;
    const click = async () => { await page.mouse.down(); await page.waitForTimeout(80); await page.mouse.up(); };
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await click();
    await expect(armedOverlay(page, 'Click again to discard 1 file')).toBeVisible();
    await page.waitForTimeout(450);
    await click();
    await expect.poll(() => git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  });
});
