import { freshFixture, git, openUrl } from './fixtures';
import { expect, test, type Page } from './test';
import { fileRow, selectWip } from './wip';

/** HEAD is feature/c; feature/a → b → c are stacked on main, which moved on (plan 3C T1). */
async function openEditor(page: Page): Promise<string> {
  const repo = freshFixture('irebase');
  await page.goto(openUrl(repo));
  await page.getByRole('grid', { name: 'Commit graph' }).getByText('main', { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Interactive rebase feature/c onto main' }).click();
  await expect(page.getByTestId('irebase')).toBeVisible();
  return repo;
}
const row = (page: Page, subject: string) => page.getByTestId('irebase').locator('[data-irebase-row]', { hasText: subject });
const start = (page: Page) => page.getByTestId('irebase').getByRole('button', { name: 'Start Rebase' }).click();

test.describe('interactive rebase (spec #3 §7)', () => {
  test('flow 1: reorder, squash and Start', async ({ page }) => {
    const repo = await openEditor(page);
    await expect(page.getByTestId('irebase').getByRole('note')).toHaveText(/1 merge commit will be flattened into a straight line/);
    await row(page, 'C2 Polish').click();
    await page.keyboard.press('Control+ArrowDown');
    await row(page, 'A3 Add tests').click();
    await page.keyboard.press('s');
    await expect(row(page, 'A3 Add tests')).toHaveClass(/is-folded/);
    await start(page);
    await expect(page.getByTestId('irebase')).toBeHidden();
    await expect.poll(() => git(repo, 'log', '-1', '--format=%s', 'feature/c')).toBe('C1 Edit notes again');
    expect(git(repo, 'log', '-1', '--format=%B', 'feature/a')).toBe('A2 Edit notes\n\nA3 Add tests');
    expect(git(repo, 'rev-list', '--merges', 'main..feature/c')).toBe('');
  });

  test('flow 2: an Edit stop, Split, two commits, Continue', async ({ page }) => {
    const repo = await openEditor(page);
    await row(page, 'B2 Refine lexer').click();
    await page.keyboard.press('e');
    await start(page);
    await selectWip(page);
    const box = page.getByTestId('commit-box');
    await expect(box.getByRole('region', { name: 'Rebase in progress' })).toContainText('Stopped to edit');
    await box.getByRole('button', { name: 'Split this commit' }).click();
    await expect(fileRow(page, 'unstaged', 'lexer.txt')).toBeVisible();
    await fileRow(page, 'unstaged', 'lexer.txt').hover();
    await page.getByRole('button', { name: 'Stage lexer.txt' }).click();
    await box.getByRole('textbox', { name: 'Commit summary' }).fill('Lexer');
    await box.locator('.commit-button').click();
    await expect.poll(() => git(repo, 'log', '-1', '--format=%s')).toBe('Lexer');
    await box.getByRole('textbox', { name: 'Commit summary' }).fill('Lexer tests');
    await box.locator('.commit-button').click(); // Stage all & commit
    await expect.poll(() => git(repo, 'log', '-1', '--format=%s')).toBe('Lexer tests');
    await box.getByRole('button', { name: 'Continue rebase' }).click();
    await expect.poll(() => git(repo, 'log', '-1', '--format=%s', 'feature/b')).toBe('Lexer tests');
    expect(git(repo, 'log', '--format=%s', 'main..feature/c')).not.toContain('B2 Refine lexer');
    // One Undo restores the original history (spec #3 §3.4).
    const tip = git(repo, 'rev-parse', 'feature/c');
    await page.keyboard.press('Control+z');
    await expect.poll(() => git(repo, 'log', '--format=%s', '-3', 'feature/c')).toContain('B2 Refine lexer');
    expect(git(repo, 'rev-parse', 'feature/c')).not.toBe(tip);
  });

  test('flow 3: a stack chip dragged down a row moves its branch', async ({ page }) => {
    const repo = await openEditor(page);
    const b = git(repo, 'log', '-1', '--format=%s', 'feature/b');
    const chip = row(page, 'A3 Add tests').locator('.irebase-chip', { hasText: 'feature/a' });
    await chip.dragTo(row(page, 'A2 Edit notes'));
    await expect(row(page, 'A2 Edit notes').locator('.irebase-chip', { hasText: 'feature/a' })).toBeVisible();
    await start(page);
    await expect.poll(() => git(repo, 'log', '-1', '--format=%s', 'feature/a')).toBe('A2 Edit notes');
    expect(git(repo, 'merge-base', '--is-ancestor', 'main', 'feature/a') === '').toBe(true);
    expect(git(repo, 'log', '-1', '--format=%s', 'feature/b')).toBe(b);
  });
});
