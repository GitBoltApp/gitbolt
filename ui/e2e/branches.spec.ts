import { freshFixture, git, openUrl } from './fixtures';
import { expect, test, type Page } from './test';

const grid = (page: Page) => page.getByRole('grid', { name: 'Commit graph' });
const chip = (page: Page, name: string) => grid(page).locator('.ref-label', { hasText: name }).first();
const menu = (page: Page) => page.getByRole('menu');

test.describe('branches (spec #2 §9.1, §9.2)', () => {
  test('the toolbar Branch creates and checks out at HEAD; undo removes it', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    await page.getByRole('button', { name: 'Branch', exact: true }).click();
    await page.getByRole('textbox', { name: 'Branch name' }).fill('topic/new');
    await expect(page.getByRole('checkbox', { name: 'Check out' })).toBeChecked();
    await page.getByRole('button', { name: 'Create branch' }).click();
    await expect(chip(page, 'topic/new')).toBeVisible();
    expect(git(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/topic/new');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(chip(page, 'topic/new')).toBeHidden();
    expect(git(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
  });

  test('Create branch here from a remote label tracks it, unchecked by default', async ({ page }) => {
    const repo = freshFixture('basic');
    git(repo, 'branch', '-D', 'feature/login');
    await page.goto(openUrl(repo));
    await chip(page, 'feature/login').click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: 'Create branch here' }).click();
    await expect(page.getByRole('checkbox', { name: 'Check out' })).not.toBeChecked();
    await page.getByRole('textbox', { name: 'Branch name' }).fill('login-copy');
    await page.getByRole('button', { name: 'Create branch' }).click();
    await expect.poll(() => { try { return git(repo, 'config', 'branch.login-copy.merge'); } catch { return ''; } }).toBe('refs/heads/feature/login');
  });

  test('an invalid name is refused in the dialog', async ({ page }) => {
    await page.goto(openUrl(freshFixture('basic')));
    await page.getByRole('button', { name: 'Branch', exact: true }).click();
    await page.getByRole('textbox', { name: 'Branch name' }).fill('a..b');
    await expect(page.getByRole('alert')).toHaveText("A branch name can't contain ..");
    await expect(page.getByRole('button', { name: 'Create branch' })).toBeDisabled();
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

  test('Delete Local of a merged branch needs no confirmation; a branch checked out elsewhere is greyed', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    await chip(page, 'feature/login').click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: 'Delete' }).locator('[data-variant-id="local"]').click();
    await expect(chip(page, 'feature/login')).toContainText('feature/login'); // the remote one stays
    await expect.poll(() => git(repo, 'branch', '--list', 'feature/login')).toBe('');
    // hotfix is checked out in wt-hotfix: greyed with where.
    await chip(page, 'hotfix').click({ button: 'right' });
    await expect(menu(page).getByRole('menuitem', { name: 'Delete' }).locator('[data-variant-id="local"]')).toBeDisabled();
  });

  test('Delete Both confirms once, deletes the remote first; undo restores the local branch only', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    await chip(page, 'feature/login').click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: 'Delete' }).locator('[data-variant-id="both"]').click();
    await expect(page.getByRole('alertdialog')).toContainText("Deleting origin/feature/login can't be undone");
    await page.getByRole('button', { name: 'Delete' }).click();
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
    await expect.poll(() => git(repo, 'rev-parse', '--abbrev-ref', 'hotfix@{upstream}')).toBe('origin/main');
    await chip(page, 'hotfix').click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: 'Set upstream' }).click();
    await page.getByRole('option', { name: 'None' }).click();
    await expect.poll(() => { try { return git(repo, 'config', 'branch.hotfix.merge'); } catch { return ''; } }).toBe('');
  });
});
