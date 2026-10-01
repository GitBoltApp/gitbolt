import { expect, test, type Page } from './test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtures, freshFixture, git, harnessHttp, harnessWs, openUrl } from './fixtures';

const rows = (page: Page) => page.getByRole('grid', { name: 'Commit graph' }).getByRole('row');

test('the WIP row shows read-only unstaged and staged files with their diffs', async ({ page }) => {
  // The staged tweak is the last line of a long file: Hunk mode shows it (with its context)
  // where the default Inline mode (amendment 3) would leave it below Monaco's rendered lines.
  await page.addInitScript(() => localStorage.setItem('gitbolt.diffPrefs.v1', JSON.stringify({ mode: 'hunk', ignoreWhitespace: false, wordWrap: false })));
  await page.goto(openUrl(fixtures.details));
  await rows(page).filter({ hasText: '// WIP' }).locator('[data-col="author"]').click();
  await expect(page.getByTestId('wip-header')).toContainText('3 file changes on');
  await expect(page.getByRole('heading', { name: 'Unstaged (2)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Staged (1)' })).toBeVisible();
  const unstaged = page.getByRole('listbox', { name: 'Unstaged' });
  await expect(unstaged.getByRole('option')).toHaveText([/manual\.txt/, /notes\.txt/]);
  await unstaged.getByRole('option').filter({ hasText: 'notes.txt' }).click();
  const diff = page.getByRole('region', { name: 'Diff' });
  // The page's first diff loads the editor's chunk (Monaco + Shiki, 3-5 s cold on the dev server
  // at idle, more on a loaded machine): allow for a cold start.
  await expect(diff.locator('.editor.modified')).toContainText('untracked notes', { timeout: 15_000 });
  await page.getByRole('listbox', { name: 'Staged', exact: true }).getByRole('option').click();
  await expect(diff.locator('.editor.modified')).toContainText('// staged tweak');
  await expect(page.getByRole('button', { name: /^(stage|unstage|discard|commit)\b/i })).toHaveCount(0);
});

test('K44: the watched tab holds the WIP lists: they update live, and re-selecting the row reads nothing', async ({ page }) => {
  const repo = freshFixture('details');
  const wipReads: boolean[] = [];
  page.on('websocket', (ws) => ws.on('framesent', ({ payload }) => {
    const { req } = JSON.parse(String(payload)) as { req?: { method?: string; params?: { spec?: { kind?: string; staged?: boolean } } } };
    if (req?.method === 'fileList' && req.params?.spec?.kind === 'wip') wipReads.push(req.params.spec.staged!);
  }));
  await page.goto(openUrl(repo));
  const wip = rows(page).filter({ hasText: '// WIP' });
  await wip.locator('[data-col="author"]').click();
  await expect(page.getByRole('heading', { name: 'Unstaged (2)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Staged (1)' })).toBeVisible();

  // An edit shows up on its own, with the WIP row still selected.
  writeFileSync(join(repo, 'live.txt'), 'live\n');
  await expect(page.getByRole('heading', { name: 'Unstaged (3)' })).toBeVisible();
  await expect(page.getByRole('listbox', { name: 'Unstaged' }).getByRole('option')).toHaveText([/manual\.txt/, /live\.txt/, /notes\.txt/]);

  // Away and back: the lists come from memory, with no fileList request.
  await rows(page).filter({ hasText: 'Initial commit' }).click();
  await expect(page.getByTestId('details-summary')).toHaveText('Initial commit');
  const before = wipReads.length;
  await wip.locator('[data-col="author"]').click();
  await expect(page.getByRole('heading', { name: 'Unstaged (3)' })).toBeVisible({ timeout: 1000 });
  await expect(page.getByRole('heading', { name: 'Staged (1)' })).toBeVisible({ timeout: 1000 });
  // A request would be sent at once: give one a moment to show up before checking there's none.
  await page.waitForTimeout(300);
  expect(wipReads.length).toBe(before);
});

test('K36: up/down run from the last unstaged file into the staged list, and wrap at the ends', async ({ page }) => {
  await page.goto(openUrl(fixtures.details));
  await page.getByRole('row').filter({ hasText: '// WIP' }).locator('[data-col="author"]').click();
  const unstaged = page.getByRole('listbox', { name: 'Unstaged' });
  const staged = page.getByRole('listbox', { name: 'Staged', exact: true });
  await unstaged.getByRole('option').first().click();
  await unstaged.focus();
  await page.keyboard.press('ArrowDown'); // the second (last) unstaged file
  await page.keyboard.press('ArrowDown'); // across, to the staged file
  await expect(staged).toBeFocused();
  await expect(staged.getByRole('option', { selected: true })).toBeVisible();
  await page.keyboard.press('ArrowDown'); // the overall end wraps to the first unstaged file
  await expect(unstaged).toBeFocused();
});

test('the WIP panel (K36): one shared Path/Tree, collapsible sections, a drag handle', async ({ page }) => {
  await page.goto(openUrl(fixtures.details));
  await page.getByRole('row').filter({ hasText: '// WIP' }).locator('[data-col="author"]').click();
  const unstaged = page.getByRole('listbox', { name: 'Unstaged' });
  const staged = page.getByRole('listbox', { name: 'Staged', exact: true });
  await expect(unstaged).toBeVisible();
  // One Path/Tree toggle, for both lists.
  await expect(page.getByRole('button', { name: 'Tree', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Tree', exact: true }).click();
  await expect(unstaged.locator('[data-kind="folder"]').first()).toBeVisible();
  await expect(staged.locator('[data-kind="folder"]').first()).toBeVisible();
  await page.getByRole('button', { name: 'Path', exact: true }).click();
  // The handle resizes: the Unstaged section grows with the keyboard.
  const sep = page.getByRole('separator', { name: 'Resize unstaged and staged files' });
  const before = await unstaged.boundingBox();
  await sep.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await unstaged.boundingBox())!.height).toBeGreaterThan(before!.height);
  // Collapse Unstaged: Staged takes the space, and the handle goes.
  await page.getByRole('button', { name: /Unstaged/ }).click();
  await expect(unstaged).toHaveCount(0);
  await expect(sep).toHaveCount(0);
  await expect(staged).toBeVisible();
  await page.reload();
  await page.getByRole('row').filter({ hasText: '// WIP' }).locator('[data-col="author"]').click();
  await expect(page.getByRole('button', { name: /Unstaged/ })).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: /Unstaged/ }).click();
  await expect(page.getByRole('listbox', { name: 'Unstaged' })).toBeVisible();
});

/** The backend's id for the repo at `path` (the one the app opened: repos are shared by path). */
function repoIdOf(page: Page, path: string): Promise<number> {
  return page.evaluate(({ url, path }) => new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, req: { method: 'openRepo', params: { path } } }));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; ok?: { id: number }; err?: unknown };
      if (m.id !== 1) return;
      ws.close();
      if (m.ok) resolve(m.ok.id);
      else reject(new Error(JSON.stringify(m.err)));
    };
  }), { url: harnessWs, path });
}

test("the checked-out worktree's WIP is row 0 (\"now\") above newer commits; a linked worktree's docks above its HEAD (K37)", async ({ page }) => {
  const repo = freshFixture('basic');
  await page.goto(openUrl(repo));
  const r = rows(page);
  // The stash and the hotfix are newer than main's HEAD (the merge): main's WIP is above them
  // anyway, and wt-hotfix's sits right on its HEAD.
  await expect(r.nth(0)).toContainText('// WIP');
  await expect(r.nth(0)).not.toContainText('wt-hotfix');
  await expect(r.nth(1)).toContainText('On main: Experiment');
  await expect(r.nth(2)).toContainText('wt-hotfix');
  await expect(r.nth(3)).toContainText('Hotfix: null check');
  await expect(r.nth(4)).toContainText("Merge branch 'feature/login'");

  // Selected, it stays selected (and row 0) across a refresh that brings an even newer commit
  // on another branch.
  await r.nth(0).locator('[data-col="author"]').click();
  await expect(page.getByTestId('wip-header')).toBeVisible();
  const newer = git(repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'Newer elsewhere');
  git(repo, 'branch', 'elsewhere', newer);
  const res = await page.request.post(`${harnessHttp}/test/emit`, { data: { type: 'refsUpdated', repo: await repoIdOf(page, repo) } });
  expect(res.ok()).toBe(true);
  await expect(r.nth(1)).toContainText('Newer elsewhere', { timeout: 5000 });
  await expect(r.nth(0)).toContainText('// WIP');
  await expect(r.nth(0)).not.toContainText('wt-hotfix');
  await expect(r.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(r.nth(3)).toContainText('wt-hotfix');

  // Ctrl+click a commit: the WIP and that commit compare (K27).
  await r.filter({ hasText: 'Fix typo' }).click({ modifiers: ['Control'] });
  await expect(page.getByTestId('compare-header')).toBeVisible();
});

test("Compare with working tree targets the open worktree, even clean, never another worktree's WIP row (K37)", async ({ page }) => {
  const repo = freshFixture('basic');
  await page.goto(openUrl(repo));
  const r = rows(page);
  // Clean the open worktree: only wt-hotfix's WIP row is left.
  git(repo, 'checkout', '--', '.');
  const res = await page.request.post(`${harnessHttp}/test/emit`, { data: { type: 'repoChanged', repo: await repoIdOf(page, repo), kinds: ['worktree'], worktrees: [repo] } });
  expect(res.ok()).toBe(true);
  await expect(r.filter({ hasText: '// WIP' })).toHaveCount(1, { timeout: 5000 });
  await expect(r.filter({ hasText: '// WIP' })).toContainText('wt-hotfix');

  await r.filter({ hasText: 'Fix typo' }).locator('[data-col="message"]').click({ button: 'right' });
  const menu = page.getByTestId('context-menu');
  await menu.locator('[role="menuitem"]').filter({ hasText: 'Compare with working tree' }).click();
  await expect(page.getByTestId('compare-header')).toContainText('working tree');
  const sides = page.locator('.compare-commits');
  await expect(sides).toContainText('Working tree');
  await expect(sides).not.toContainText('wt-hotfix');
  // wt-hotfix's WIP row isn't picked into the compare.
  await expect(r.filter({ hasText: 'wt-hotfix' })).not.toHaveAttribute('aria-selected', 'true');
});

test('K47: the WIP row shows its per-type counts with the status icons', async ({ page }) => {
  await page.goto(openUrl(fixtures.details));
  const row = rows(page).filter({ hasText: '// WIP' });
  const counts = row.getByTestId('wip-counts');
  await expect(counts).toBeVisible();
  await expect(counts.locator('svg[data-status="modified"]')).toBeVisible();
  await expect(counts.locator('svg[data-status="added"]')).toBeVisible();
  await expect(counts.locator('svg[data-status="deleted"]')).toHaveCount(0);
});

test('K48: the WIP row takes a draft summary that survives a reload, clicking it selects WIP and shows the WIP panel, and keys do not leak', async ({ page }) => {
  await page.goto(openUrl(fixtures.details));
  const row = rows(page).filter({ hasText: '// WIP' });
  const box = row.getByPlaceholder('// WIP');
  // Compact at rest (~116px), and the counts stay visible.
  const w = (await box.boundingBox())!.width;
  expect(w).toBeGreaterThanOrEqual(110);
  expect(w).toBeLessThanOrEqual(140);
  await expect(row.getByTestId('wip-counts')).toBeInViewport();
  await expect(row).toHaveAttribute('aria-selected', 'false');
  await box.click();
  await expect(box).toBeFocused();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('wip-header')).toBeVisible();
  await box.click();
  await expect(box).toBeFocused();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  // Navigation keys and letters are the box's, not the graph's.
  await page.keyboard.type('fix the end key ');
  await page.keyboard.press('End');
  await page.keyboard.press('Home');
  await expect(box).toHaveValue('fix the end key ');
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(box).not.toBeFocused();
  await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeFocused();
  await expect(box).toHaveValue('fix the end key ');
  // Elsewhere on the row selects it.
  await row.locator('[data-col="date"]').click();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await page.waitForTimeout(500);
  await page.reload();
  await expect(rows(page).filter({ hasText: '// WIP' }).getByPlaceholder('// WIP')).toHaveValue('fix the end key ');
});
