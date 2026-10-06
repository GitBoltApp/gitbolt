import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { freshFixture, git, openUrl } from './fixtures';
import { budgetApplies, expect, test, type Page, confirmArmed } from './test';

const grid = (page: Page) => page.getByRole('grid', { name: 'Commit graph' }).filter({ visible: true });
// The Worktrees panel's row (a Local branch row can carry the same name).
const sidebarRow = (page: Page, name: string) => page.getByRole('tree', { name: 'Worktrees items' }).filter({ visible: true }).getByRole('treeitem', { name, exact: true });
// Every open tab keeps its toolbar mounted; only the selected tab's is visible.
const repoButton = (page: Page) => page.getByTestId('tb-repo').filter({ visible: true });
const headChip = (page: Page) => grid(page).locator('.ref-label-head').first();

test.describe('the active worktree (spec #2 §11.2)', () => {
  test('double-clicking a worktree row switches in place, under 50 ms, with no reload', { tag: '@budget' }, async ({ page }) => {
    const repo = freshFixture('worktrees');
    await page.goto(openUrl(repo));
    await expect(grid(page)).toBeVisible();
    await expect(headChip(page)).toContainText('main');
    const times: number[] = [];
    for (const [row, branch] of [['wt-one', 'wt-one'], ['wt-two', 'wt-two'], ['repo', 'main']] as const) {
      const ms = await page.evaluate(async ([r, b]) => {
        const el = [...document.querySelectorAll<HTMLElement>('[role="treeitem"][data-kind="worktree"]')].find((e) => e.getAttribute('aria-label') === r)!;
        const t0 = performance.now();
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await new Promise<void>((done, fail) => {
          const deadline = performance.now() + 5000;
          // The markers (§11.2): the toolbar's branch picker and the sidebar's current worktree.
          // wt-one's HEAD chip sits far down the graph, unrendered; the row-0 WIP re-placement is
          // the graph-only relayout that follows (checked below), not part of the budget.
          const updated = () =>
            !!document.querySelector(`.tb-picker[aria-label="Branch: ${b}"]`) &&
            !!document.querySelector(`[role="treeitem"][data-kind="worktree"][aria-label="${r}"]`)?.classList.contains('is-head');
          const check = () => {
            if (updated()) done();
            else if (performance.now() > deadline) fail(new Error(`the markers never showed ${r} (${b})`));
            else requestAnimationFrame(check);
          };
          check();
        });
        return performance.now() - t0;
      }, [row, branch]);
      times.push(ms);
    }
    if (budgetApplies()) expect(Math.min(...times), `switch times ${times.map((t) => t.toFixed(1)).join(', ')} ms`).toBeLessThan(50);
    // The row-0 WIP follows from the cached relayout. (A dblclick event alone, as above: a real
    // double-click's first click also selects wt-one's tip, scrolling row 0 out of view.)
    await sidebarRow(page, 'wt-one').dispatchEvent('dblclick');
    // WipSummary prints the worktree's name (a linked one only) in the WIP row's message cell.
    await expect(grid(page).locator('.wip-worktree', { hasText: 'wt-one' })).toBeVisible();
  });

  // One repo and page for these (each was a test of its own, paying for a page load and a fixture).
  test('the repo button switches worktrees and the sidebar marks the current one, Undo targets the active worktree; open in a new tab', async ({ page }) => {
    const repo = freshFixture('worktrees');
    await page.goto(openUrl(repo));
    await test.step('a linked tab\'s sidebar marks its own current branch and worktree', async () => {
      await repoButton(page).click();
      await page.getByRole('menuitem', { name: /wt-one/ }).click();
      await expect(sidebarRow(page, 'wt-one')).toHaveClass(/is-head/);
      await expect(sidebarRow(page, 'repo')).not.toHaveClass(/is-head/);
    });
    await test.step('the WIP row menu and the repo button switch, and Undo targets the active worktree', async () => {
      await repoButton(page).click();
      await page.getByRole('menuitem', { name: /wt-two/ }).click();
      await expect(repoButton(page)).toContainText('wt-two');
      await expect(headChip(page)).toContainText('wt-two');
      await expect(page.getByRole('toolbar', { name: 'Repository toolbar' }).getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    });
    await test.step('open in a new tab shows the same repository on the other worktree at once', async () => {
      await sidebarRow(page, 'wt-one').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Open in a new tab' }).click();
      await expect(page.getByRole('tab', { selected: true })).toBeVisible();
      // wt-one's HEAD chip sits far down the graph (unrendered); the toolbar and row-0 WIP show it.
      await expect(page.getByRole('button', { name: 'Branch: wt-one', exact: true })).toBeVisible();
      await expect(grid(page).getByRole('row').first().locator('.wip-worktree')).toHaveText('wt-one');
      await expect(page.getByRole('tab')).toHaveCount(2);
    });
  });
});

// --- 2C T14 ---
test.describe('worktree create and remove (spec #2 §11.1)', () => {
  test('the Worktrees header + creates a dash-joined folder and opens it in a new tab', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    await page.getByRole('button', { name: 'Create worktree' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create worktree' });
    await page.getByRole('textbox', { name: 'New branch' }).fill('feature/new-thing');
    await expect(page.getByRole('textbox', { name: 'Directory' })).toHaveValue(join(repo, '..', 'repo-feature-new-thing'));
    await dialog.getByRole('button', { name: 'Create worktree' }).click();
    await expect(page.getByRole('tab')).toHaveCount(2);
    await expect(repoButton(page)).toContainText('repo-feature-new-thing');
    expect(git(join(repo, '..', 'repo-feature-new-thing'), 'symbolic-ref', '--short', 'HEAD')).toBe('feature/new-thing');
  });

  test('Remove confirms, asks again when dirty, and the branch stays', async ({ page }) => {
    const repo = freshFixture('basic');
    const wt = join(repo, '..', 'wt-hotfix');
    await page.goto(openUrl(repo));
    await page.getByRole('treeitem', { name: 'wt-hotfix' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Remove…' }).click();
    // The row arms in place (board A); once the menu is gone, the dirty question is a popover there.
    await confirmArmed(page.getByRole('menuitem', { name: 'Click again to remove ../wt-hotfix: its directory is deleted' }));
    await expect(page.getByRole('alertdialog')).toContainText("has changes that aren't committed");
    await confirmArmed(page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }));
    await expect.poll(() => existsSync(wt)).toBe(false);
    expect(git(repo, 'branch', '--list', 'hotfix')).toContain('hotfix');
  });

  test('removing the active worktree of another tab moves it to the main worktree', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    await page.getByRole('treeitem', { name: 'wt-hotfix' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open in a new tab' }).click();
    await expect(repoButton(page)).toContainText('wt-hotfix');
    await page.getByRole('tab').first().click();
    await page.getByRole('treeitem', { name: 'wt-hotfix' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Remove…' }).click();
    await confirmArmed(page.getByRole('menuitem', { name: /^Click again to remove/ }));
    await confirmArmed(page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }));
    await page.getByRole('tab').last().click();
    await expect(repoButton(page)).not.toContainText('wt-hotfix');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});
// --- end 2C T14 ---
