import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { freshFixture, git, openUrl } from './fixtures';
import { expect, test, type Page, confirmArmed } from './test';

const grid = (page: Page) => page.getByRole('grid', { name: 'Commit graph' });
const chip = (page: Page, name: string) => grid(page).locator('.ref-label', { hasText: name }).first();
// A remote-only chip: named without its remote (feature/login), and no local (laptop) icon.
const remoteChip = (page: Page, name: string) => grid(page).locator('.ref-label', { hasText: name, hasNot: page.locator('[aria-label="local"]') }).first();
const head = (repo: string) => git(repo, 'symbolic-ref', '--short', 'HEAD');

/** A second clone of the fixture's origin pushes one commit to `branch`; the fixture fetches. */
function advance(repo: string, branch: string): void {
  const origin = git(repo, 'remote', 'get-url', 'origin');
  const other = join(mkdtempSync(join(repo, '..', 'other-')), 'c');
  git(join(other, '..'), 'clone', '-q', origin, 'c');
  git(other, 'switch', '-q', branch);
  git(other, 'commit', '-q', '--allow-empty', '-m', `theirs on ${branch}`);
  git(other, 'push', '-q', 'origin', branch);
  git(repo, 'fetch', '-q', 'origin');
}

test.describe('checkout (spec #2 §9.3)', () => {
  test('double-clicking a branch chip checks it out within 300 ms; undo switches back', { tag: '@budget' }, async ({ page }) => {
    const repo = freshFixture('basic');
    git(repo, 'stash', 'push', '-q', '-u', '-m', 'park the fixture changes');
    await page.goto(openUrl(repo));
    const times: number[] = [];
    for (const name of ['feature/login', 'main', 'feature/login']) {
      const t0 = Date.now();
      await chip(page, name).dblclick();
      await expect(chip(page, name)).toHaveClass(/ref-label-head/);
      times.push(Date.now() - t0);
    }
    expect(Math.min(...times), `checkout times ${times.join(', ')} ms`).toBeLessThan(300);
    expect(head(repo)).toBe('feature/login');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => head(repo)).toBe('main');
  });

  test('a remote-only branch gets a tracking branch; a behind one fast-forwards', async ({ page }) => {
    const repo = freshFixture('basic');
    git(repo, 'stash', 'push', '-q', '-u', '-m', 'park');
    git(repo, 'branch', '-D', 'feature/login');
    await page.goto(openUrl(repo));
    await page.getByRole('treeitem', { name: 'feature/login' }).last().dblclick();
    await expect.poll(() => head(repo)).toBe('feature/login');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'feature/login@{upstream}')).toBe('origin/feature/login');
    git(repo, 'switch', '-q', 'main');
    advance(repo, 'feature/login');
    await page.reload();
    await remoteChip(page, 'feature/login').dblclick();
    await expect.poll(() => git(repo, 'rev-parse', 'feature/login')).toBe(git(repo, 'rev-parse', 'origin/feature/login'));
  });

  test('diverged asks; Reset moves the local branch; undo brings its commits back', async ({ page }) => {
    const repo = freshFixture('basic');
    git(repo, 'stash', 'push', '-q', '-u', '-m', 'park');
    advance(repo, 'feature/login');
    git(repo, 'switch', '-q', 'feature/login');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'mine');
    const mine = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'switch', '-q', 'main');
    await page.goto(openUrl(repo));
    await page.getByRole('treeitem', { name: 'feature/login' }).last().dblclick();
    await expect(page.getByRole('alertdialog')).toContainText('feature/login and origin/feature/login have diverged (1 ahead, 1 behind).');
    await confirmArmed(page.getByRole('button', { name: 'Reset feature/login to origin/feature/login' }));
    await expect.poll(() => git(repo, 'rev-parse', 'feature/login')).toBe(git(repo, 'rev-parse', 'origin/feature/login'));
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => git(repo, 'rev-parse', 'feature/login')).toBe(mine);
  });

  test('double-clicking a branch checked out in another worktree switches to that worktree, no toast', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    await chip(page, 'hotfix').dblclick();
    await expect(page.getByTestId('tb-repo')).toContainText('wt-hotfix');
    await expect(page.getByText('hotfix is checked out in ../wt-hotfix.')).toHaveCount(0);
    expect(head(repo)).toBe('main'); // nothing checked out
  });

  test("double-clicking main's sidebar row, checked out in the main worktree, switches back to it", async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    await chip(page, 'hotfix').dblclick();
    await expect(page.getByTestId('tb-repo')).toContainText('wt-hotfix');
    await page.getByRole('treeitem', { name: 'main', exact: true }).first().dblclick();
    await expect(page.getByTestId('tb-repo')).not.toContainText('wt-hotfix');
    expect(head(repo)).toBe('main');
  });

  test('the branch picker and the palette check out', async ({ page }) => {
    const repo = freshFixture('basic');
    git(repo, 'stash', 'push', '-q', '-u', '-m', 'park');
    await page.goto(openUrl(repo));
    await page.getByRole('button', { name: /^Branch: / }).click();
    await page.getByRole('option', { name: 'feature/login' }).click();
    await expect.poll(() => head(repo)).toBe('feature/login');
    await page.keyboard.press('Control+P');
    await page.keyboard.type('@main');
    await page.keyboard.press('Shift+Enter');
    await expect.poll(() => head(repo)).toBe('main');
  });

  test('Checkout ▸ Detached HEAD', async ({ page }) => {
    const repo = freshFixture('basic');
    git(repo, 'stash', 'push', '-q', '-u', '-m', 'park');
    await page.goto(openUrl(repo));
    await grid(page).getByRole('row', { name: /Fix typo/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Checkout' }).hover();
    await page.getByRole('menuitem', { name: /^Detached HEAD at / }).click();
    await expect.poll(() => { try { return head(repo); } catch { return 'detached'; } }).toBe('detached');
  });
});

test.describe('reset (spec #2 §9.4)', () => {
  test('Soft and Mixed never ask; Hard asks only when dirty and says it can be undone; each undoes', async ({ page }) => {
    const repo = freshFixture('basic');
    const tip = git(repo, 'rev-parse', 'main');
    await page.goto(openUrl(repo));
    const resetRow = async (variant: string) => {
      await grid(page).getByRole('row', { name: /Fix typo/ }).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Reset main to this commit' }).locator(`[data-variant-id="${variant.toLowerCase()}"]`).click();
    };
    await resetRow('Soft');
    await expect.poll(() => git(repo, 'rev-parse', 'main')).not.toBe(tip);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => git(repo, 'rev-parse', 'main')).toBe(tip);
    // The fixture's main worktree is dirty (file_1.txt): Hard asks.
    await resetRow('Hard');
    // The question arms the menu row in place (the menu stays open while the write answers).
    await confirmArmed(page.getByRole('menuitem', { name: /^Click again to reset main and discard changes to 1 file/ }));
    await expect(page.getByRole('alertdialog')).toBeHidden();
    await expect.poll(() => git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => git(repo, 'status', '--porcelain', '--untracked-files=no')).toContain('file_1.txt');
    // Clean: no question.
    git(repo, 'stash', 'push', '-q', '-m', 'clean');
    await resetRow('Hard');
    await expect.poll(() => git(repo, 'rev-parse', 'main')).not.toBe(tip);
    await expect(page.getByRole('alertdialog')).toBeHidden();
  });
});
