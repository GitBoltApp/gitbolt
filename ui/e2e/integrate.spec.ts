import { freshFixture, git, openUrl } from './fixtures';
import { expect, test, type Page, confirmArmed } from './test';

const isAncestor = (repo: string, a: string, b: string) => { try { git(repo, 'merge-base', '--is-ancestor', a, b); return true; } catch { return false; } };
const labelMenu = async (page: Page, name: string, item: string) => {
  await page.getByRole('grid', { name: 'Commit graph' }).getByText(name, { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: item }).click();
};

test.describe('integrate (spec #2 §13.1, §13.4)', () => {
  test('rebasing a stack moves the ticked stacked branches', async ({ page }) => {
    // HEAD is feature/c; feature/a and feature/b are the stack under it; main moved on.
    const repo = freshFixture('stack');
    await page.goto(openUrl(repo));
    await labelMenu(page, 'main', 'Rebase feature/c onto main');
    // The row arms in place, the stack's checkbox right under it (UX round 3).
    await expect(page.getByRole('menuitemcheckbox', { name: /Also move 2 stacked branches/ })).toHaveAttribute('aria-checked', 'true');
    await confirmArmed(page.getByRole('menuitem', { name: 'Click again to rebase feature/c onto main' }));
    await expect.poll(() => isAncestor(repo, 'main', 'feature/a')).toBe(true);
    expect(isAncestor(repo, 'main', 'feature/b')).toBe(true);
    expect(isAncestor(repo, 'main', 'feature/c')).toBe(true);
  });

  test('a 60-commit rebase shows the counter and moves the chip', async ({ page }) => {
    const repo = freshFixture('rebase60');
    await page.goto(openUrl(repo));
    await page.evaluate(() => {
      (window as unknown as { seen: string[] }).seen = [];
      new MutationObserver(() => {
        const t = document.querySelector('[data-testid="status-write"]')?.textContent;
        if (t) (window as unknown as { seen: string[] }).seen.push(t);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await labelMenu(page, 'main', 'Rebase topic onto main');
    await expect.poll(() => isAncestor(repo, 'main', 'topic')).toBe(true);
    expect(git(repo, 'rev-list', '--count', 'main..topic')).toBe('60');
    const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
    expect(seen.some((s) => /^Rebasing topic \(\d+\/60\)…/.test(s))).toBe(true);
  });

  test('a conflicting merge arms its row with the predicted count', async ({ page }) => {
    // HEAD is main; feature/x conflicts in a.txt (text), logo.bin (binary) and gone.txt (delete/modify).
    const repo = freshFixture('conflicts');
    await page.goto(openUrl(repo));
    await labelMenu(page, 'feature/x', 'Merge feature/x into main');
    await expect(page.getByRole('menuitem', { name: 'Click again to merge feature/x (conflicts in 3 files)' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitem', { name: 'Merge feature/x into main' })).toBeVisible();
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});
