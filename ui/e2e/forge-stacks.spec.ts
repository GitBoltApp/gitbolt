import type { APIRequestContext, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { addForgeAccount, E2E_GITLAB_TOKEN, forgeSeed, freshFixture, git, openUrl, setForgeSeed } from './fixtures';
import { confirmArmed, expect, test } from './test';

/** 4B's GitLab seed items (A8): 4C's create arms add the MRs they create to the same list. */
type Mr = Record<string, unknown> & { iid: number; sourceBranch: string; targetBranch: string; state: string; description: string };
const mrs = async (request: APIRequestContext) => (await forgeSeed(request)).gitlab.mergeRequests as Mr[];
const chipMenu = async (page: Page, name: string, item: string) => {
  // The forge target has resolved once the Merge requests section is there: the row is in the menu from then on.
  await expect(page.getByRole('region', { name: 'Merge requests' })).toBeVisible();
  await page.getByRole('grid', { name: 'Commit graph' }).getByText(name, { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: item, exact: true }).click();
};

test.describe('stacked MRs (spec #4 §4 4D, §7)', () => {
  // The page's clock is installed (to skip the poller's focus gap): it belongs to the context.
  test.use({ isolatedContext: true });

  test('create the stack MRs, then after the bottom merges retarget the next one and rebase the stack', async ({ page, request }) => {
    // HEAD is feature/c; feature/a → b → c are stacked on main, which moved on.
    const repo = freshFixture('stack');
    // Origin is the fake GitLab project for the forge, but pushes go to a local bare repository.
    // With no origin/main, the stack sits on the local main, so nothing is ever fetched (no network).
    const bare = `${repo}-origin.git`;
    execFileSync('git', ['init', '-q', '--bare', bare]);
    git(repo, 'remote', 'add', 'origin', 'https://gitlab.example.com/group/project.git');
    git(repo, 'config', 'remote.origin.pushurl', bare);
    git(repo, 'push', '-q', '-u', 'origin', 'feature/a', 'feature/b', 'feature/c');

    // Start without 4B's default MRs, so the created ones are !1, !2 and !3.
    const empty = await forgeSeed(request);
    empty.gitlab.mergeRequests = [];
    await setForgeSeed(request, empty);

    // The account goes in through the harness before the page loads, so the poller resolves the project at once.
    await addForgeAccount(request, 'gitlab.example.com', 'gitlab', E2E_GITLAB_TOKEN);
    // Real time keeps flowing; the clock only lets the test jump past the focus gap below.
    await page.clock.install();
    await page.goto(openUrl(repo));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();

    await chipMenu(page, 'feature/c', 'Create stack MRs…');
    const dialog = page.getByRole('dialog', { name: 'Create stack MRs' });
    await expect(dialog.getByRole('textbox', { name: 'Title for feature/b' })).toHaveValue('Work on feature/b');
    await dialog.getByRole('button', { name: 'Create 3 MRs' }).click();
    await expect(page.getByText('Created !1, !2 and !3')).toBeVisible();
    let list = await mrs(request);
    expect(list.map((m) => [m.sourceBranch, m.targetBranch])).toEqual([['feature/a', 'main'], ['feature/b', 'feature/a'], ['feature/c', 'feature/b']]);
    expect(list[1].description).toContain('| **2** | **!2** | **Work on feature/b** | **Open** |');

    // The bottom merges on GitLab as a squash: its commit isn't in main's history.
    const seed = await forgeSeed(request);
    (seed.gitlab.mergeRequests as Mr[])[0].state = 'merged';
    await setForgeSeed(request, seed);
    // A11: 4B's poller polls on focus, but not within 10 s of a full poll (the create just did
    // one): the clock jumps past that gap (FOCUS_GAP_MS) instead of the test waiting it out.
    await page.clock.fastForward(10_000);
    await expect(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.getByText('!1 was merged.')).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Retarget the next MR and rebase the stack' }).click();
    // #3's Rebase stack confirm: the toast's button has gone, so it's the popover.
    const rebase = page.getByRole('alertdialog', { name: 'Rebase the stack onto main?' }).getByRole('button', { name: 'Rebase', exact: true });
    await confirmArmed(rebase);
    await expect(rebase).toBeHidden();
    await expect(page.getByText('Retargeted !2 to main, then rebased and pushed the stack')).toBeVisible({ timeout: 15_000 });

    // feature/a's commit was dropped, not replayed: feature/b sits right on main.
    expect(git(repo, 'rev-parse', 'feature/b~1')).toBe(git(repo, 'rev-parse', 'main'));
    for (const b of ['feature/b', 'feature/c']) expect(execFileSync('git', ['--git-dir', bare, 'rev-parse', b], { encoding: 'utf8' }).trim()).toBe(git(repo, 'rev-parse', b));
    list = await mrs(request);
    expect(list[1].targetBranch).toBe('main');
    expect(list[1].description).toContain('| 1 | !1 | Work on feature/a | Merged |');
    expect(await page.content()).not.toContain(E2E_GITLAB_TOKEN);
  });
});
