import { freshFixture, git, openUrl } from './fixtures';
import { expect, test, type Page, confirmArmed } from './test';

const grid = (page: Page) => page.getByRole('grid', { name: 'Commit graph' });
const stashes = (repo: string) => git(repo, 'stash', 'list', '--format=%gs');
const bar = (page: Page) => page.getByRole('toolbar', { name: 'Repository toolbar' });
const wipBox = (page: Page) => grid(page).getByRole('row').first().getByRole('textbox');

test.describe('stashes (spec #2 §10)', () => {
  // One repo and page for these (each was a test of its own, paying for a page load and a
  // fixture): the fixture's WIP stashed and back, then its own stash ("Experiment") applied,
  // deleted and back, popped last.
  test('Stash takes the WIP draft as its message and Undo brings the changes back; Apply and Delete from the sidebar and the graph\'s stash node; Pop applies the newest and deletes it', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    await test.step('Stash takes the WIP draft as its message and clears it; Undo brings the changes back', async () => {
      await wipBox(page).fill('Half-done login tweak');
      await wipBox(page).press('Escape');
      await bar(page).getByRole('button', { name: 'Stash', exact: true }).click();
      await expect.poll(() => stashes(repo)).toBe('On main: Half-done login tweak\nOn main: Experiment');
      await expect(bar(page).getByRole('button', { name: 'Stash', exact: true })).toBeDisabled();
      await bar(page).getByRole('button', { name: 'Undo', exact: true }).click();
      // Read git once the app says it's done: a `stash list` while the undo drops the stash can find
      // refs/stash moving between its two reads.
      await expect(page.getByText(/^Undid /)).toBeVisible();
      await expect.poll(() => stashes(repo)).toBe('On main: Experiment');
      expect(git(repo, 'status', '--porcelain')).toContain('file_1.txt');
    });
    await test.step('Apply, then Delete from the graph\'s stash node, and Undo', async () => {
      git(repo, 'checkout', '-q', '--', '.');
      await expect(bar(page).getByRole('button', { name: 'Stash', exact: true })).toBeDisabled();
      await page.getByRole('treeitem', { name: /^stash@\{0\}/ }).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Apply' }).click();
      await expect.poll(() => git(repo, 'status', '--porcelain')).toContain('file_0.txt');
      expect(stashes(repo)).toBe('On main: Experiment');
      // What came back (UX round 2): the WIP row is selected and the restored file's diff is open.
      await expect(page.getByTestId('diff-path')).toContainText('file_0.txt');
      await page.keyboard.press('Escape');
      await expect(grid(page).getByRole('row').first()).toHaveAttribute('aria-selected', 'true');
      git(repo, 'checkout', '-q', '--', '.');
      await grid(page).getByRole('row', { name: /Experiment/ }).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      await confirmArmed(page.getByRole('menuitem', { name: 'Click again to delete the stash "On main: Experiment"' }));
      await expect.poll(() => stashes(repo)).toBe('');
      await bar(page).getByRole('button', { name: 'Undo', exact: true }).click();
      await expect.poll(() => stashes(repo)).toBe('On main: Experiment');
    });
    await test.step('Pop applies the newest and deletes it; Pop is disabled with no stashes', async () => {
      await bar(page).getByRole('button', { name: 'Pop', exact: true }).click();
      await expect.poll(() => stashes(repo)).toBe('');
      await expect(bar(page).getByRole('button', { name: 'Pop', exact: true })).toBeDisabled();
    });
  });
});
