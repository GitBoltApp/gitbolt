import type { Page } from '@playwright/test';
import { dirname, join } from 'node:path';
import { E2E_GITLAB_TOKEN, forgeSeed, freshFixture, git, originGit, openUrl, setForgeSeed } from './fixtures';
import { expect, test } from './test';

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
const remotePanel = (page: Page) => page.getByRole('complementary', { name: 'Sidebar', exact: true }).getByRole('region', { name: 'Remote', exact: true });

test.describe('forge accounts and remotes (spec #4 §7, 4A)', () => {
  test('a GitLab account kept in the file (with its warning), then a fork added from the forks list and fetched', async ({ page, request }) => {
    const repo = freshFixture('sync');
    // Origin "on" the fake GitLab; alice's fork is the fixture's own bare origin, so its fetch is local.
    git(repo, 'remote', 'set-url', 'origin', 'https://gitlab.example.com/group/project.git');
    const seed = await forgeSeed(request);
    for (const p of seed.gitlab.projects) if (p.path === 'alice/project') p.httpUrl = join(dirname(repo), 'origin.git');
    await setForgeSeed(request, seed);

    await page.goto(openUrl(repo));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    await page.keyboard.press('Control+,');
    await settings(page).getByRole('button', { name: 'Accounts', exact: true }).click();
    await expect(settings(page).getByLabel('Host')).toHaveValue('gitlab.example.com');
    await settings(page).getByLabel('Token').fill(E2E_GITLAB_TOKEN);
    await settings(page).getByRole('button', { name: 'Add account' }).click();
    const account = settings(page).getByRole('listitem', { name: 'gitlab.example.com account' });
    await expect(account).toContainText('Ada Lovelace');
    await expect(account).toContainText('File — not secure');
    await expect(account).toContainText('Stored in a file, not the system keyring');
    await expect(settings(page).getByLabel('Token')).toHaveValue('');
    expect(await page.content()).not.toContain(E2E_GITLAB_TOKEN);
    await page.keyboard.press('Escape');

    await remotePanel(page).getByRole('button', { name: 'Add remote' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add remote' });
    await expect(dialog.getByRole('heading', { name: 'Forks of group/project' })).toBeVisible();
    await dialog.getByRole('button', { name: "Add alice's fork" }).click();
    await expect(page.getByText("Added alice's fork as alice")).toBeVisible();
    const fetched = () => { try { return git(repo, 'rev-parse', '--verify', '-q', 'refs/remotes/alice/main'); } catch { return ''; } };
    await expect.poll(fetched).toBe(originGit(repo, 'rev-parse', 'main'));
    await expect(remotePanel(page).getByText('alice', { exact: true })).toBeVisible();
  });
});
