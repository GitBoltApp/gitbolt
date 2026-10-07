import { freshFixture, git, openUrl } from './fixtures';
import { expect, test, type Page, confirmArmed } from './test';

const grid = (page: Page) => page.getByRole('grid', { name: 'Commit graph' });
const chip = (page: Page, name: string) => grid(page).locator('.ref-label', { hasText: name }).first();
const menu = (page: Page) => page.getByRole('menu');

test.describe('branches (spec #2 §9.1, §9.2)', () => {
  // One repo and page for these (each was a test of its own, paying for a page load), in an order
  // where each starts from what it needs: nothing is left half-done, and the rename comes last.
  test('the inline name input: Esc or leaving cancels, an invalid name is refused, Enter creates and undo removes it; Set upstream; rename keeps the reflog', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    await test.step('Esc, or leaving it empty, cancels the inline input', async () => {
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
    await test.step('a click in the input keeps it, focused', async () => {
      await page.getByRole('button', { name: 'Branch', exact: true }).click();
      const input = grid(page).getByRole('textbox', { name: 'Branch name' });
      await expect(input).toBeFocused();
      await input.click();
      await expect(input).toBeFocused();
      await input.press('Escape');
      await expect(input).toBeHidden();
    });
    await test.step('an invalid name is refused inline, with its reason', async () => {
      await page.getByRole('button', { name: 'Branch', exact: true }).click();
      const input = grid(page).getByRole('textbox', { name: 'Branch name' });
      await input.fill('a..b');
      await expect(page.getByRole('alert')).toHaveText("A branch name can't contain ..");
      await expect(input).toHaveAttribute('aria-invalid', 'true');
      await input.press('Enter');
      await expect(input).toBeVisible(); // nothing created: still editing
      expect(git(repo, 'branch', '--list', 'a*')).toBe('');
      await input.press('Escape');
      await expect(input).toBeHidden();
    });
    await test.step('the toolbar Branch opens the inline name input on HEAD\'s row; Enter creates and checks out; undo removes it', async () => {
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
      await page.getByRole('toolbar', { name: 'Repository toolbar' }).getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(chip(page, 'topic/new')).toBeHidden();
      expect(git(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    });
    await test.step('Set upstream picks a remote branch, and None unsets it', async () => {
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
    await test.step('rename keeps the reflog', async () => {
      const log = git(repo, 'reflog', 'show', '--format=%H', 'feature/login');
      await chip(page, 'feature/login').click({ button: 'right' });
      await menu(page).getByRole('menuitem', { name: 'Rename feature/login' }).click();
      await page.getByRole('textbox', { name: 'New name' }).fill('feature/signin');
      await page.getByRole('button', { name: 'Rename' }).click();
      await expect(chip(page, 'feature/signin')).toBeVisible();
      expect(git(repo, 'reflog', 'show', '--format=%H', 'feature/signin').endsWith(log)).toBe(true);
    });
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

  test('Delete Local of a merged branch needs no confirmation; a branch checked out elsewhere has a disabled Local', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    await chip(page, 'feature/login').click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: 'Delete' }).locator('[data-variant-id="local"]').click();
    await expect(chip(page, 'feature/login')).toContainText('feature/login'); // the remote one stays
    await expect.poll(() => git(repo, 'branch', '--list', 'feature/login')).toBe('');
    // hotfix is checked out in wt-hotfix: it can't be deleted, so its Local is disabled.
    await chip(page, 'hotfix').click({ button: 'right' });
    await expect(menu(page)).toBeVisible();
    await test.step('hotfix has no remote: its Local stays, disabled with its reason', async () => {
      const local = menu(page).getByRole('menuitem', { name: 'Delete' }).locator('[data-variant-id="local"]');
      await expect(local).toHaveAttribute('aria-disabled', 'true');
      await local.hover();
      await expect(page.getByRole('tooltip')).toContainText("Can't delete hotfix: it's checked out in");
    });
    await test.step('the checked-out branch with a remote: Local disabled, hovering the row lights Remote', async () => {
      await page.keyboard.press('Escape');
      await chip(page, 'main').click({ button: 'right' });
      const del = menu(page).getByRole('menuitem', { name: 'Delete' });
      await expect(del.locator('[data-variant-id="local"]')).toHaveAttribute('aria-disabled', 'true');
      await del.locator('[data-variant-id="local"]').hover();
      await expect(page.getByRole('tooltip')).toContainText("Can't delete main: it's checked out");
      await del.locator('.ctx-label').hover();
      await expect(del.locator('[data-variant-id="remote"]')).toHaveAttribute('data-default', 'true');
    });
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
    await page.getByRole('toolbar', { name: 'Repository toolbar' }).getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByText('Undid delete branch feature/login and origin/feature/login (origin/feature/login stays deleted)')).toBeVisible();
    await expect(chip(page, 'feature/login')).toBeVisible();
    await expect(page.getByRole('toolbar', { name: 'Repository toolbar' }).getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  });

});
