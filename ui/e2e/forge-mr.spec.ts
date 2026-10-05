import type { Locator, Page } from '@playwright/test';
import { addForgeAccount, E2E_GITLAB_TOKEN, forgeRequests, freshFixture, git, openUrl } from './fixtures';
import { armedOverlay, confirmArmed, expect, test } from './test';

/** The pointer at an element's centre: a hovered chip floats its copy over the resting one, so a
 * locator click would hit the copy (Playwright calls that interception). */
async function pointAt(page: Page, el: Locator, click = false) {
  const box = (await el.boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  if (click) await page.mouse.click(x, y);
  else await page.mouse.move(x, y);
}

test.describe('merge requests (spec #4 §7, 4B)', () => {
  test('a badge, its hover card, and the MR view with a comment and an approval', async ({ page, request }) => {
    // The sync fixture's local `dev` tracks origin/dev: the fake GitLab's !12 is from `dev`.
    const repo = freshFixture('sync');
    git(repo, 'remote', 'set-url', 'origin', 'https://gitlab.example.com/group/project.git');
    await addForgeAccount(request, 'gitlab.example.com', 'gitlab', E2E_GITLAB_TOKEN);
    await page.goto(openUrl(repo));
    const graph = page.getByRole('grid', { name: 'Commit graph' });
    await expect(graph).toBeVisible();

    const badges = graph.getByRole('button', { name: 'Merge request !12: open' });
    await expect(badges).toHaveCount(1);
    const badge = badges.first();
    await expect(badge).toBeVisible();
    // `diverged` and origin/diverged sit on different commits: each chip has the draft's badge.
    await expect(graph.getByRole('button', { name: 'Merge request !5: draft' }).first()).toBeVisible();
    const logBefore = (await forgeRequests(request)).length;
    await pointAt(page, badge);
    const card = page.getByRole('tooltip').filter({ hasText: 'Dev work' });
    await expect(card).toContainText('!12');
    await expect(card).toContainText('Grace Hopper · dev → main');
    await expect(card).toContainText('Pipeline passed');
    await expect(card).toContainText('0 of 1 approval');

    await pointAt(page, badge, true);
    const view = page.getByRole('dialog', { name: 'Merge request !12' });
    await expect(view).toBeVisible();
    await expect(view).toContainText('Adds the dev work.');
    await expect(view.getByRole('button', { name: 'README.md:2' })).toBeVisible();
    await expect(view).toContainText('+Second line');
    await expect(view.getByRole('button', { name: 'Merge', exact: true })).toBeDisabled();
    await expect(view).toContainText('It needs approval first');

    await view.getByRole('textbox', { name: 'Write a comment' }).fill('Thanks, merging soon.');
    await view.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(view.getByRole('region', { name: 'Activity' })).toContainText('Thanks, merging soon.');
    // Approve is the APPROVALS box's check: it arms in place first.
    await view.locator('.mr-fact[data-fact="reviews"]').getByRole('button', { name: 'Approve', exact: true }).click();
    await confirmArmed(armedOverlay(page, 'Click again to approve'));
    await expect(view.getByRole('button', { name: 'Approved', exact: true })).toBeVisible();
    await expect(view.getByRole('button', { name: 'Merge', exact: true })).toBeEnabled();

    const log = (await forgeRequests(request)).slice(logBefore);
    const mrCalls = log.filter((r) => r.path.includes('/merge_requests/12/'));
    expect(mrCalls.length).toBeGreaterThan(0);
    expect(mrCalls.every((r) => r.authorized === true)).toBe(true);
    expect(log.some((r) => r.method === 'POST' && r.path === '/api/v4/projects/42/merge_requests/12/notes')).toBe(true);
    expect(log.some((r) => r.method === 'POST' && r.path === '/api/v4/projects/42/merge_requests/12/approve')).toBe(true);
    expect(await page.content()).not.toContain(E2E_GITLAB_TOKEN);
    await page.keyboard.press('Escape');
    await expect(view).toBeHidden();
  });

  test('the MR view docks beside the graph: both stay usable', async ({ page, request }) => {
    const repo = freshFixture('sync');
    git(repo, 'remote', 'set-url', 'origin', 'https://gitlab.example.com/group/project.git');
    await addForgeAccount(request, 'gitlab.example.com', 'gitlab', E2E_GITLAB_TOKEN);
    await page.goto(openUrl(repo));
    const graph = page.getByRole('grid', { name: 'Commit graph' });
    await expect(graph).toBeVisible();
    const sidebar = page.getByRole('complementary', { name: 'Sidebar', exact: true });
    await sidebar.getByRole('region', { name: 'Merge requests', exact: true }).getByRole('treeitem', { name: '!12 Dev work' }).click();
    const view = page.getByRole('dialog', { name: 'Merge request !12' });
    await expect(view).toContainText('Adds the dev work.');
    // The actions are on the status line.
    await expect(view.getByRole('region', { name: 'Summary' }).locator('.mr-line').getByRole('group', { name: 'Actions' })).toBeVisible();

    await view.getByRole('button', { name: 'Dock beside the graph' }).click();
    const undock = view.getByRole('button', { name: 'Undock (float over the graph)' });
    await expect(undock).toBeVisible();
    // Beside the graph, not over it.
    const [v, g] = [(await view.boundingBox())!, (await graph.boundingBox())!];
    expect(g.x).toBeGreaterThanOrEqual(v.x + v.width - 1);

    // A graph row while docked: the details follow, the view stays.
    const details = page.getByRole('complementary', { name: 'Commit details' });
    await graph.getByRole('row').filter({ hasText: 'Add readme' }).click();
    await expect(details).toContainText('Add readme');
    await expect(view).toBeVisible();
    await graph.getByRole('row').filter({ hasText: 'Initial commit' }).click();
    await expect(details).toContainText('Initial commit');
    await expect(view).toBeVisible();

    await undock.click();
    await expect(view.getByRole('button', { name: 'Dock beside the graph' })).toBeVisible();
    const [v2, g2] = [(await view.boundingBox())!, (await graph.boundingBox())!];
    expect(g2.x).toBeLessThan(v2.x + v2.width);
  });

  test("a sidebar row's menu: Copy link, then Check out a same-repository MR", async ({ page, request }) => {
    const repo = freshFixture('sync');
    git(repo, 'remote', 'set-url', 'origin', 'https://gitlab.example.com/group/project.git');
    await addForgeAccount(request, 'gitlab.example.com', 'gitlab', E2E_GITLAB_TOKEN);
    await page.goto(openUrl(repo));
    const sidebar = page.getByRole('complementary', { name: 'Sidebar', exact: true });
    const row = sidebar.getByRole('region', { name: 'Merge requests', exact: true }).getByRole('treeitem', { name: '!12 Dev work' });
    const menu = page.getByTestId('context-menu');
    const action = (label: string) => menu.locator('[data-depth="0"] > [role="menuitem"]').filter({ has: page.locator('.ctx-label').getByText(label, { exact: true }) });

    await row.click({ button: 'right' });
    await action('Copy link').click();
    await expect(page.getByRole('status')).toHaveText('Copied');
    if (test.info().project.name === 'chromium') {
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/group\/project\/-\/merge_requests\/12$/);
    }

    // `dev` already tracks origin/dev: Check out switches to it, and the row then says so.
    await row.click({ button: 'right' });
    await action('Check out').click();
    await expect(sidebar.getByRole('region', { name: 'Local', exact: true }).locator('.sb-item.is-head')).toHaveAttribute('aria-label', 'dev');
    await row.click({ button: 'right' });
    await expect(action('Checked out')).toHaveAttribute('aria-disabled', 'true');
  });
});
