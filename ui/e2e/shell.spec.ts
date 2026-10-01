import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshFixture, git, harnessHttp, harnessWs, openUrl } from './fixtures';
import { expect, test, type Page } from './test';

const openAll = (...paths: string[]) => `/?${paths.map((p) => `repo=${encodeURIComponent(p)}`).join('&')}`;
const graph = (page: Page) => page.getByRole('grid', { name: 'Commit graph' });
const row = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text });
/** The visible tab page (hidden tabs stay in the DOM, `display: none`, under <Activity>). */
const shownTab = (page: Page) => page.locator('.tab-page:visible');

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

async function emit(page: Page, event: object) {
  const res = await page.request.post(`${harnessHttp}/test/emit`, { data: event });
  expect(res.ok()).toBe(true);
}

test.describe('shell', () => {
  test('restores open tabs after a reload', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    await expect(graph(page)).toBeVisible();
    await page.evaluate(() => window.__gb!.flush());
    await page.goto('/');
    await expect(graph(page)).toBeVisible();
    await expect(page.getByText("Merge branch 'feature/login'")).toBeVisible();
    await expect(page.locator('.tab-page')).toHaveCount(1);
  });

  test('two repos open as two tabs: only the active one shows; Ctrl+Tab switches', async ({ page }) => {
    const a = freshFixture('basic');
    const b = freshFixture('long_labels');
    await page.goto(openAll(a, b));
    // The last one opened is active.
    await expect(page.locator('.tab-page')).toHaveCount(2);
    await expect(graph(page)).toBeVisible();
    await expect(shownTab(page)).toHaveCount(1);
    await expect(row(page, "Merge branch 'feature/login'")).toHaveCount(0);
    await page.keyboard.press('Control+Tab');
    await expect(row(page, "Merge branch 'feature/login'")).toBeVisible();
    await expect(shownTab(page)).toHaveCount(1);
    await page.keyboard.press('Control+PageUp');
    await expect(row(page, "Merge branch 'feature/login'")).toHaveCount(0);
  });

  test('a refs-updated event refreshes in place, keeping the selected commit selected', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    const fix = row(page, 'Fix typo');
    await fix.click();
    await expect(fix).toHaveAttribute('aria-selected', 'true');
    git(repo, 'switch', '-q', '-c', 'e2e-branch', 'main');
    writeFileSync(join(repo, 'e2e.txt'), 'x\n');
    git(repo, 'add', 'e2e.txt');
    git(repo, 'commit', '-q', '-m', 'Commit from outside');
    await emit(page, { type: 'refsUpdated', repo: await repoIdOf(page, repo) });
    await expect(row(page, 'Commit from outside')).toBeVisible({ timeout: 5000 });
    await expect(row(page, 'Fix typo')).toHaveAttribute('aria-selected', 'true');
    // The details panel still shows it.
    await expect(page.getByRole('complementary', { name: 'Commit details' })).toContainText('Fix typo');
  });

  test('a repo-changed event updates the WIP row', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    const mainWip = page.getByRole('row').filter({ hasText: '// WIP' }).filter({ hasNotText: 'wt-hotfix' });
    await expect(mainWip).toContainText('✎1');
    writeFileSync(join(repo, 'e2e-new-file.txt'), 'hello\n');
    await emit(page, { type: 'repoChanged', repo: await repoIdOf(page, repo), kinds: ['worktree'], worktrees: [repo] });
    await expect(mainWip).toContainText('+1', { timeout: 5000 });
  });

  // Needs the watcher (plan 1C Task 6, lane W2-B): passes once it has merged.
  test('a file change in the worktree updates the WIP row live', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    const mainWip = page.getByRole('row').filter({ hasText: '// WIP' }).filter({ hasNotText: 'wt-hotfix' });
    await expect(mainWip).toContainText('✎1');
    writeFileSync(join(repo, 'e2e-new-file.txt'), 'hello\n');
    await expect(mainWip).toContainText('+1', { timeout: 5000 });
  });

  test('files open in two tabs share the one diff editor across switches; Ctrl+W closes the file, then the tab', async ({ page }) => {
    const a = freshFixture('basic');
    const b = freshFixture('basic');
    await page.goto(openAll(a, b));
    await expect(page.locator('.tab-page')).toHaveCount(2);
    const diff = page.getByRole('region', { name: 'Diff' });
    const path = diff.getByTestId('diff-path');
    // The modified side's text lines (not a deleted-lines view zone).
    const lines = diff.locator('.editor.modified .lines-content > .view-lines');
    const openFirstFile = async (summary: string) => {
      await row(page, summary).click();
      await expect(page.getByRole('listbox', { name: 'Changed files' })).toBeVisible();
      await graph(page).press('Enter');
      // The first open also loads (and, on a fresh dev server, compiles) the editor's chunk.
      await expect(lines).toBeVisible({ timeout: 30_000 });
    };
    // Tab b (active): a file of "Fix typo".
    await openFirstFile('Fix typo');
    const inB = { path: await path.innerText(), text: await lines.innerText() };
    // Tab a: a file of "Add readme".
    await page.keyboard.press('Control+Tab');
    await expect(diff).toHaveCount(0);
    await openFirstFile('Add readme');
    const inA = { path: await path.innerText(), text: await lines.innerText() };
    expect(inA.text).not.toBe(inB.text);
    // Back to b: its own file, in the one editor (moved over).
    await page.keyboard.press('Control+Shift+Tab');
    await expect(path).toHaveText(inB.path);
    await expect(lines).toHaveText(inB.text);
    // And a again.
    await page.keyboard.press('Control+Tab');
    await expect(path).toHaveText(inA.path);
    await expect(lines).toHaveText(inA.text);
    // Ctrl+W: the open file first (back to the graph, selection kept), then the tab.
    await page.keyboard.press('Control+w');
    await expect(diff).toHaveCount(0);
    await expect(row(page, 'Add readme')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.tab-page')).toHaveCount(2);
    await page.keyboard.press('Control+w');
    await expect(page.locator('.tab-page')).toHaveCount(1);
    // b is left, its file still open.
    await expect(path).toHaveText(inB.path);
    await expect(lines).toHaveText(inB.text);
  });
});
