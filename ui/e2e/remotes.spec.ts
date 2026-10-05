import { freshFixture, git, openUrl } from './fixtures';
import { confirmArmed, expect, test, type Page } from './test';

const remotePanel = (page: Page) => page.getByRole('complementary', { name: 'Sidebar', exact: true }).getByRole('region', { name: 'Remote', exact: true });
const bar = (page: Page) => page.getByRole('toolbar', { name: 'Repository toolbar' });

test.describe('remotes', () => {
  test('Remove remote… arms in place, removes origin with its branches; Undo puts it all back', async ({ page }) => {
    const repo = freshFixture('sync');
    const before = git(repo, 'for-each-ref', '--format=%(refname) %(objectname) %(symref)', 'refs/remotes');
    await page.goto(openUrl(repo));
    const origin = remotePanel(page).getByRole('treeitem', { name: 'remote origin origin', exact: true });
    await origin.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Remove remote…' }).click();
    await confirmArmed(page.getByRole('menuitem', { name: /^Click again to remove origin/ }));
    await expect(origin).toHaveCount(0);
    expect(git(repo, 'remote')).toBe('');
    expect(git(repo, 'config', '--list')).not.toMatch(/^branch\..*=origin$/m);

    await bar(page).getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(origin).toBeVisible();
    await expect(remotePanel(page).getByRole('treeitem', { name: 'dev', exact: true })).toBeVisible();
    expect(git(repo, 'for-each-ref', '--format=%(refname) %(objectname) %(symref)', 'refs/remotes')).toBe(before);
    expect(git(repo, 'config', 'branch.dev.remote')).toBe('origin');
  });
});
