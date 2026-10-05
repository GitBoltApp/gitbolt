import type { Page } from '@playwright/test';
import { dirname, join } from 'node:path';
import { addForgeAccount, E2E_GITHUB_TOKEN, E2E_GITLAB_TOKEN, forgeRequests, forgeScript, forgeSeed, freshFixture, git, originGit, openUrl, setForgeSeed } from './fixtures';
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
    await settings(page).getByRole('button', { name: '+ Add account' }).click();
    await expect(settings(page).getByLabel('Host')).toHaveValue('gitlab.example.com');
    await settings(page).getByLabel('Token').fill(E2E_GITLAB_TOKEN);
    await settings(page).getByRole('button', { name: 'Add account', exact: true }).click();
    const account = settings(page).getByRole('listitem', { name: 'gitlab.example.com account' });
    await expect(account).toContainText('Ada Lovelace');
    await expect(account).toContainText('File — not secure');
    await expect(account).toContainText('Stored in a file, not the system keyring');
    await expect(settings(page).getByLabel('Token', { exact: true })).toHaveCount(0);
    expect(await page.content()).not.toContain(E2E_GITLAB_TOKEN);
    await page.keyboard.press('Escape');
    // Adding the account polls the open tab at once: its Merge requests section appears, with no fetch wait.
    await expect(page.getByRole('region', { name: 'Merge requests' })).toBeVisible();

    await remotePanel(page).getByRole('button', { name: 'Add remote' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add remote' });
    await expect(dialog.getByRole('heading', { name: 'Forks of group/project' })).toBeVisible();
    await dialog.getByRole('button', { name: "Add alice's fork" }).click();
    await expect(page.getByText("Added alice's fork as alice")).toBeVisible();
    const fetched = () => { try { return git(repo, 'rev-parse', '--verify', '-q', 'refs/remotes/alice/main'); } catch { return ''; } };
    await expect.poll(fetched).toBe(originGit(repo, 'rev-parse', 'main'));
    await expect(remotePanel(page).getByText('alice', { exact: true })).toBeVisible();
  });

  // --- 4C T10 ---
  test('a pull request prefilled from the first commit; a refused reviewer is a partial failure, and Retry adds them', async ({ page, request }) => {
    const repo = freshFixture('sync');
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/octo-org/widget.git');
    git(repo, 'switch', '-q', '-c', 'feature/widget', 'origin/main');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'Add the widget', '-m', 'It spins.');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'Polish the widget');
    git(repo, 'update-ref', 'refs/remotes/origin/feature/widget', 'HEAD');
    git(repo, 'branch', '-q', '--set-upstream-to=origin/feature/widget');
    await addForgeAccount(request, 'github.com', 'github', E2E_GITHUB_TOKEN);
    await forgeScript(request, { forge: 'github', method: 'POST', path: '/repos/octo-org/widget/pulls/1/requested_reviewers', status: 422, body: { message: 'Reviews may only be requested from collaborators.' }, times: 1 });

    await page.goto(openUrl(repo));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    // The palette action needs the target project: 4B's poller has found it once the sidebar shows the section (4B ruling 12).
    await expect(page.getByText('Pull requests', { exact: true })).toBeVisible();
    await page.keyboard.press('Control+p');
    await page.keyboard.type('>Create MR/PR');
    await page.keyboard.press('Enter');
    // 4B's FlyoutFrame is a dialog named by its title.
    const flyout = page.getByRole('dialog', { name: 'Create pull request' });
    await expect(flyout.getByLabel('Title', { exact: true })).toHaveValue('Add the widget');
    await expect(flyout.getByLabel('Description', { exact: true })).toHaveValue('It spins.');
    await flyout.getByRole('button', { name: 'Add reviewer' }).click();
    await flyout.getByLabel('Reviewers', { exact: true }).fill('hub');
    await flyout.getByRole('option', { name: /hubot/ }).click();
    await page.keyboard.press('Escape');
    await flyout.getByRole('button', { name: 'Add label' }).click();
    await flyout.getByLabel('Labels', { exact: true }).fill('bug');
    await flyout.getByRole('option', { name: /bug/ }).click();
    await page.keyboard.press('Escape');
    // Esc closed only the searches: the flyout is still open, with the picks as chips.
    await expect(flyout.getByRole('group', { name: 'People and labels' })).toContainText(/hubot/i);
    await flyout.getByRole('button', { name: 'Create pull request' }).click();

    await expect(page.getByText("PR #1 created; couldn't add reviewers: Reviews may only be requested from collaborators")).toBeVisible();
    await expect(flyout).toBeHidden();
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByText('Added reviewers to #1')).toBeVisible();
    // GraphQL's POSTs are the list's checks (a read), not the create's writes.
    const posts = (await forgeRequests(request)).filter((r) => r.forge === 'github' && r.method === 'POST' && r.path !== '/graphql').map((r) => r.path);
    expect(posts).toEqual([
      '/repos/octo-org/widget/pulls',
      '/repos/octo-org/widget/pulls/1/requested_reviewers',
      '/repos/octo-org/widget/issues/1/labels',
      '/repos/octo-org/widget/pulls/1/requested_reviewers',
    ]);
    expect(await page.content()).not.toContain(E2E_GITHUB_TOKEN);
  });
  // --- end 4C T10 ---
});
