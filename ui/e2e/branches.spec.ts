import { freshFixture, git, openUrl } from './fixtures';
import { expect, test, type Page, confirmArmed } from './test';

const grid = (page: Page) => page.getByRole('grid', { name: 'Commit graph' });
const chip = (page: Page, name: string) => grid(page).locator('.ref-label', { hasText: name }).first();
const menu = (page: Page) => page.getByRole('menu');

test.describe('branches (spec #2 §9.1, §9.2)', () => {
  test('the toolbar Branch opens the inline name input on HEAD\'s row; Enter creates and checks out; undo removes it', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    await page.getByRole('button', { name: 'Branch', exact: true }).click();
    // UX round 1: no dialog, an input in the Branch/Tag cell of HEAD's (selected) row.
    const input = grid(page).getByRole('textbox', { name: 'Branch name' });
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute('placeholder', 'enter branch name');
    await expect(grid(page).locator('[role="row"][aria-selected="true"]')).toContainText('main');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await input.fill('topic/new');
    await input.press('Enter');
    await expect(input).toBeHidden();
    await expect(chip(page, 'topic/new')).toBeVisible();
    expect(git(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/topic/new');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(chip(page, 'topic/new')).toBeHidden();
    expect(git(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
  });

  test('Create branch here from a remote label tracks it; Ctrl+Enter creates without checking out', async ({ page }) => {
    const repo = freshFixture('basic');
    git(repo, 'branch', '-D', 'feature/login');
    await page.goto(openUrl(repo));
    await chip(page, 'feature/login').click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: 'Create branch here' }).click();
    const input = grid(page).getByRole('textbox', { name: 'Branch name' });
    await input.fill('login-copy');
    await input.press('Control+Enter');
    await expect.poll(() => { try { return git(repo, 'config', 'branch.login-copy.merge'); } catch { return ''; } }).toBe('refs/heads/feature/login');
    expect(git(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
  });

  test('Esc, or leaving it empty, cancels the inline input', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    await page.getByRole('button', { name: 'Branch', exact: true }).click();
    const input = grid(page).getByRole('textbox', { name: 'Branch name' });
    await input.fill('never');
    await input.press('Escape');
    await expect(input).toBeHidden();
    await page.getByRole('button', { name: 'Branch', exact: true }).click();
    await expect(input).toBeFocused();
    await grid(page).getByRole('row').nth(3).locator('[data-col="date"]').click();
    await expect(input).toBeHidden();
    expect(git(repo, 'branch', '--list', 'never')).toBe('');
  });

  test('an invalid name is refused inline, with its reason', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    await page.getByRole('button', { name: 'Branch', exact: true }).click();
    const input = grid(page).getByRole('textbox', { name: 'Branch name' });
    await input.fill('a..b');
    await expect(page.getByRole('alert')).toHaveText("A branch name can't contain ..");
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await input.press('Enter');
    await expect(input).toBeVisible(); // nothing created: still editing
    expect(git(repo, 'branch', '--list', 'a*')).toBe('');
  });

  test('rename keeps the reflog', async ({ page }) => {
    const repo = freshFixture('basic');
    const log = git(repo, 'reflog', 'show', '--format=%H', 'feature/login');
    await page.goto(openUrl(repo));
    await chip(page, 'feature/login').click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: 'Rename feature/login' }).click();
    await page.getByRole('textbox', { name: 'New name' }).fill('feature/signin');
    await page.getByRole('button', { name: 'Rename' }).click();
    await expect(chip(page, 'feature/signin')).toBeVisible();
    expect(git(repo, 'reflog', 'show', '--format=%H', 'feature/signin').endsWith(log)).toBe(true);
  });

  test('Delete Local of a merged branch needs no confirmation; a branch checked out elsewhere has no Local', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    await chip(page, 'feature/login').click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: 'Delete' }).locator('[data-variant-id="local"]').click();
    await expect(chip(page, 'feature/login')).toContainText('feature/login'); // the remote one stays
    await expect.poll(() => git(repo, 'branch', '--list', 'feature/login')).toBe('');
    // hotfix is checked out in wt-hotfix: it can't be deleted, so there's no Local (UX round 1).
    await chip(page, 'hotfix').click({ button: 'right' });
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).getByRole('menuitem', { name: 'Delete' }).locator('[data-variant-id="local"]')).toHaveCount(0);
  });

  test('Delete Local of an unmerged branch arms its menu row in place (no popover); a second click deletes it', async ({ page }) => {
    const repo = freshFixture('basic');
    const tip = git(repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'side work');
    git(repo, 'update-ref', 'refs/heads/side', tip);
    await page.goto(openUrl(repo));
    await chip(page, 'side').click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: 'Delete' }).locator('[data-variant-id="local"]').click();
    await confirmArmed(menu(page).getByRole('menuitem', { name: /^Click again to delete side: 1 commit not in main/ }));
    await expect(page.getByRole('alertdialog')).toBeHidden();
    await expect.poll(() => git(repo, 'branch', '--list', 'side')).toBe('');
  });

  test('Delete Both confirms once, deletes the remote first; undo restores the local branch only', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    await chip(page, 'feature/login').click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: 'Delete' }).locator('[data-variant-id="both"]').click();
    // The row arms in place, its menu open (spec §ui confirms, board A); a second click runs it.
    await confirmArmed(menu(page).getByRole('menuitem', { name: /^Click again to delete feature\/login and origin\/feature\/login/ }));
    // One confirmation only: no second (unmerged) dialog follows.
    await expect(page.getByRole('alertdialog')).toBeHidden();
    await expect(chip(page, 'feature/login')).toBeHidden();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByText('Undid delete branch feature/login and origin/feature/login (origin/feature/login stays deleted)')).toBeVisible();
    await expect(chip(page, 'feature/login')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
  });

  test('Set upstream picks a remote branch, and None unsets it', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    await chip(page, 'hotfix').click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: 'Set upstream' }).click();
    await page.getByRole('option', { name: 'origin/main' }).click();
    // Until the write lands, git has no upstream to name (and exits non-zero).
    const upstream = () => { try { return git(repo, 'rev-parse', '--abbrev-ref', 'hotfix@{upstream}'); } catch { return ''; } };
    await expect.poll(upstream).toBe('origin/main');
    await chip(page, 'hotfix').click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: 'Set upstream' }).click();
    await page.getByRole('option', { name: 'None' }).click();
    await expect.poll(() => { try { return git(repo, 'config', 'branch.hotfix.merge'); } catch { return ''; } }).toBe('');
  });
});
