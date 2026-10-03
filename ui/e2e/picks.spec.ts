import { freshFixture, git, openUrl } from './fixtures';
import { expect, test } from './test';
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
    // The stop opens the first conflicted file in the merge tool (2D ux round 3).
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
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Feature edits');
    expect(git(repo, 'rev-parse', 'HEAD~1')).toBe(before);
    // One Undo takes the whole cherry-pick back (spec #3 §5).
    await page.getByRole('toolbar', { name: 'Repository toolbar' }).getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => git(repo, 'rev-parse', 'main')).toBe(before);
  });
});
