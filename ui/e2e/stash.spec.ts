import { freshFixture, git, openUrl } from './fixtures';
import { expect, test, type Page } from './test';

const grid = (page: Page) => page.getByRole('grid', { name: 'Commit graph' });
const stashes = (repo: string) => git(repo, 'stash', 'list', '--format=%gs');
const bar = (page: Page) => page.getByRole('toolbar', { name: 'Repository toolbar' });
const wipBox = (page: Page) => grid(page).getByRole('row').first().getByRole('textbox');

test.describe('stashes (spec #2 §10)', () => {
  test('Stash takes the WIP draft as its message and clears it; Undo brings the changes back', async ({ page }) => {
    const repo = freshFixture('basic');
    git(repo, 'stash', 'drop', '-q');
    await page.goto(openUrl(repo));
    await wipBox(page).fill('Half-done login tweak');
    await wipBox(page).press('Escape');
    await bar(page).getByRole('button', { name: 'Stash', exact: true }).click();
    await expect.poll(() => stashes(repo)).toBe('On main: Half-done login tweak');
    await expect(bar(page).getByRole('button', { name: 'Stash', exact: true })).toBeDisabled();
    await bar(page).getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => stashes(repo)).toBe('');
    expect(git(repo, 'status', '--porcelain')).toContain('file_1.txt');
  });

  test('Pop applies the newest and deletes it; Pop is disabled with no stashes', async ({ page }) => {
    const repo = freshFixture('basic');
    git(repo, 'checkout', '-q', '--', '.');
    await page.goto(openUrl(repo));
    await bar(page).getByRole('button', { name: 'Pop', exact: true }).click();
    await expect.poll(() => stashes(repo)).toBe('');
    await expect(bar(page).getByRole('button', { name: 'Pop', exact: true })).toBeDisabled();
  });

  test('Apply, Pop and Delete from the sidebar and the graph\'s stash node', async ({ page }) => {
    const repo = freshFixture('basic');
    git(repo, 'checkout', '-q', '--', '.');
    await page.goto(openUrl(repo));
    await page.getByRole('treeitem', { name: /^stash@\{0\}/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Apply' }).click();
    await expect.poll(() => git(repo, 'status', '--porcelain')).toContain('file_0.txt');
    expect(stashes(repo)).toBe('On main: Experiment');
    git(repo, 'checkout', '-q', '--', '.');
    await grid(page).getByRole('row', { name: /Experiment/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect.poll(() => stashes(repo)).toBe('');
    await bar(page).getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => stashes(repo)).toBe('On main: Experiment');
  });
});
