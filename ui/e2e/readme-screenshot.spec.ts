import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { addForgeAccount, E2E_GITHUB_TOKEN, fixtures, forgeSeed, git, setForgeSeed } from './fixtures';
import { expect, test, type Page } from './test';

// The README's screenshot (docs/images/screenshot.webp): opt-in, not part of the suite. Run it with
// `just readme-screenshot`, which sets GITBOLT_README_SHOT to the PNG to write and optimises it.
// The repos are scripts/showcase-repo.sh's, built into this run's fixture root.
const out = process.env.GITBOLT_README_SHOT;
test.skip(!out, 'the README screenshot runs with GITBOLT_README_SHOT=<png> (just readme-screenshot)');
test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium only');
test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, timezoneId: 'UTC', locale: 'en-US' });

test('README screenshot', async ({ page, request }) => {
  test.setTimeout(120_000);
  const root = mkdtempSync(join(fixtures.notRepo, 'showcase-'));
  execFileSync('bash', [join(import.meta.dirname, '..', '..', 'scripts', 'showcase-repo.sh'), root], { stdio: 'ignore' });
  await connectGitHub(request, join(root, 'driftwood'));
  // In the strip's order, then grouped: App (driftwood, shown), Web (collapsed), Ops.
  const repos = ['driftwood', 'mobile-app', 'browser-extension', 'docs-site', 'design-system', 'infra', 'status-page'].map((r) => join(root, r));
  await page.goto(`/?${repos.map((r) => `repo=${encodeURIComponent(r)}`).join('&')}`);
  await expect(page.getByRole('tab')).toHaveCount(repos.length);
  await group(page, 'App', ['driftwood', 'mobile-app', 'browser-extension']);
  await group(page, 'Web', ['docs-site', 'design-system']);
  await group(page, 'Ops', ['infra', 'status-page']);
  await page.getByRole('tab', { name: /driftwood/ }).click();
  // Web collapsed to its chip (none of its tabs is active).
  await page.getByRole('button', { name: 'Tab group: Web' }).click();
  await expect(page.getByRole('tab', { name: /docs-site/ })).toBeHidden();
  const grid = page.getByRole('grid', { name: 'Commit graph' }).filter({ visible: true });
  await expect(grid).toBeVisible();
  const sidebar = page.getByRole('complementary', { name: 'Sidebar', exact: true }).filter({ visible: true });
  // The PRs are polled in: each one's badge on its branch's chips, and the sidebar's section.
  for (const n of [38, 41, 44]) await expect(grid.getByRole('button', { name: `Pull request #${n}: open` }).first()).toBeVisible();
  await expect(sidebar.getByRole('region', { name: 'Pull requests', exact: true }).getByRole('treeitem')).toHaveCount(3);
  await expect(sidebar.getByRole('tree', { name: 'Worktrees items' }).getByRole('treeitem')).toHaveCount(2);
  // Stashes collapsed, as a user would: a click on its header.
  await sidebar.getByRole('region', { name: 'Stashes', exact: true }).getByRole('button', { name: 'Stashes', exact: true }).click();
  await grid.getByRole('row').filter({ hasText: 'Queue edits while offline' }).click();
  const panel = page.getByRole('complementary', { name: 'Commit details' });
  await expect(panel.getByTestId('details-summary')).toHaveText('Queue edits while offline and replay them on reconnect');
  // The file list as a tree: tests/offline, web/hooks and web/offline.
  await panel.getByRole('button', { name: 'Tree', exact: true }).click();
  await expect(panel.getByRole('treeitem').filter({ hasText: 'queue.ts' }).first()).toBeVisible();
  // Nothing hovered or focused that a user wouldn't see at rest.
  await page.mouse.move(1, 999);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(500);
  await page.screenshot({ path: out!, animations: 'disabled', caret: 'hide' });
});

/** Points driftwood's origin at a made-up project on the harness's fake GitHub (nothing fetches
 * it: the harness turns background fetch off), connects an account for that host, and seeds open
 * pull requests from three of the graph's branches, by the showcase's people. */
async function connectGitHub(request: APIRequestContext, repo: string): Promise<void> {
  const project = 'driftwood-app/driftwood';
  git(repo, 'remote', 'set-url', 'origin', `https://github.com/${project}.git`);
  const people = [['maya', 'Maya Okafor'], ['tomas', 'Tomás Lindqvist'], ['priya', 'Priya Raman'], ['jonah', 'Jonah Whitfield'], ['kenji', 'Kenji Morimoto'], ['sofia', 'Sofia Brandt'], ['luca', 'Luca Ferraro']];
  const users = people.map(([username, name], i) => ({ id: 9100 + i, username, name, email: null, avatarUrl: null }));
  const seed = await forgeSeed(request);
  const gh = seed.github as { tokens: Array<{ token: string; user: unknown }>; repos: unknown[]; users: unknown[]; assignees: unknown[]; pulls: unknown[] };
  // The fake's e2e token, signed in as Maya.
  gh.tokens.find((t) => t.token === E2E_GITHUB_TOKEN)!.user = users[0];
  gh.repos.push({ id: 9001, path: project, defaultBranch: 'develop', updatedAt: '2026-09-05T18:00:00Z' });
  gh.users.push(...users);
  gh.assignees = users;
  const tip = (branch: string) => git(repo, 'rev-parse', `origin/${branch}`).trim();
  const checks = (status: string, conclusion: string | null) => [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'test', status, conclusion }];
  const review = (id: number, user: string, state: string, submittedAt: string) => ({ id, user, state, body: '', submittedAt });
  const pull = (number: number, headRef: string, title: string, author: string, updatedAt: string, more: Record<string, unknown>) => ({
    number, repo: project, headRef, baseRef: 'develop', title, state: 'open', author, headSha: tip(headRef), baseSha: tip('develop'),
    mergeable: true, mergeableState: 'clean', updatedAt, ...more,
  });
  gh.pulls = [
    pull(38, 'feature/reader-mode', 'Reader mode for archives', 'kenji', '2026-09-04T22:10:00Z', {
      labels: ['enhancement'], checks: checks('completed', 'success'), reviews: [review(381, 'jonah', 'APPROVED', '2026-09-04T21:30:00Z')],
    }),
    pull(41, 'feature/offline-sync', 'Offline reading and sync', 'maya', '2026-09-05T18:00:00Z', {
      labels: ['enhancement'], checks: checks('in_progress', null), requestedReviewers: ['tomas', 'priya'], mergeableState: 'unstable',
    }),
    pull(44, 'fix/import-encoding', 'Detect imported charsets', 'sofia', '2026-09-03T04:30:00Z', {
      labels: ['bug'], checks: checks('completed', 'success'), reviews: [review(441, 'luca', 'CHANGES_REQUESTED', '2026-09-03T09:00:00Z')],
    }),
  ];
  await setForgeSeed(request, seed);
  await addForgeAccount(request, 'github.com', 'github', E2E_GITHUB_TOKEN);
}

/** Groups `tabs` (repo names, already side by side) as `name`: the first tab's Add to new group,
 * the name from the chip's menu, then each other tab's Add to group. */
async function group(page: Page, name: string, tabs: string[]): Promise<void> {
  await page.getByRole('tab', { name: new RegExp(tabs[0]) }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add to new group' }).click();
  await page.locator('.tab-group-chip').last().click({ button: 'right' });
  const menu = page.getByRole('dialog', { name: 'Tab group' });
  await menu.getByLabel('Group name').fill(name);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  for (const t of tabs.slice(1)) {
    await page.getByRole('tab', { name: new RegExp(t) }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Add to group' }).hover();
    await page.getByRole('menuitem', { name }).click();
  }
  await expect(page.getByRole('button', { name: `Tab group: ${name}` })).toBeVisible();
}
