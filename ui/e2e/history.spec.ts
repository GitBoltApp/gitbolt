import { expect, test, type Locator, type Page } from './test';
import { freshFixture, git, openUrl } from './fixtures';

// Spec #3 §7 e2e flow 5: File History plus Blame, over the `file_history` fixture (plan 3A T2).
const graphRow = (page: Page, text: string) => page.getByRole('grid', { name: 'Commit graph' }).getByRole('row').filter({ hasText: text });
const fileRow = (page: Page, path: string) => page.getByRole('listbox', { name: 'Changed files' }).getByRole('option').and(page.locator(`[data-path="${path}"]`));
const action = (menu: Locator, label: string) => menu.locator('[data-depth="0"] > [role="menuitem"]').filter({ has: menu.page().locator('.ctx-label').getByText(label, { exact: true }) });

test('File History follows the rename, Blame groups the lines, a group selects its commit, Esc returns to the diff', async ({ page }) => {
  const repo = freshFixture('file_history');
  const shaOf = (subject: string) => git(repo, 'log', '--format=%H', '-F', `--grep=${subject}`, '-1');
  await page.goto(openUrl(repo));
  await graphRow(page, 'Sharpen the opening').click();
  await fileRow(page, 'src/story.txt').click();
  const diff = page.getByRole('region', { name: 'Diff' });
  await expect(diff).toBeVisible();

  // The diff toolbar's History (spec #3 §4.2).
  await diff.getByRole('toolbar', { name: 'Diff options' }).getByRole('button', { name: 'History', exact: true }).click();
  const view = page.getByRole('region', { name: 'File history' });
  await expect(view.getByRole('heading')).toHaveText('File History: src/story.txt');
  const commits = view.getByRole('listbox', { name: 'Commits' }).getByRole('option');
  await expect(commits).toHaveCount(4);
  await expect(commits.nth(0)).toContainText('Sharpen the opening');
  await expect(commits.nth(3)).toContainText('Start the story');
  await expect(view.getByText(`Added in ${shaOf('Start the story').slice(0, 6)}`)).toBeVisible();
  await expect(view.getByText('End of history')).toBeVisible();
  await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeHidden();
  // The keyboard moved into the list (not left in Changed files, where ↓ would open a file over it).
  await expect(view.getByRole('listbox', { name: 'Commits' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(commits.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(view.getByRole('heading')).toBeVisible();

  // Below the rename: the file at its old path and version.
  await commits.nth(2).click();
  await expect(commits.nth(2)).toHaveAttribute('aria-selected', 'true');
  await expect(view.getByTestId('file-view')).toContainText('It grew a middle part');
  // Its editor's menu is that row's file (the old path), not the diff hidden under the view.
  await view.locator('.view-line').filter({ hasText: 'It grew a middle part' }).click({ button: 'right' });
  const editorMenu = page.getByTestId('context-menu');
  await expect(action(editorMenu, 'Copy location').getByRole('button').first()).toHaveText('story.txt:3');
  await page.keyboard.press('Escape');
  await expect(editorMenu).toBeHidden();
  await expect(view).toBeVisible();

  // Blame at "Add the middle": [1-2 Start] [3-4 Middle] [5-8 Start]; a group selects its commit.
  await view.getByRole('button', { name: 'Blame', exact: true }).click();
  const groups = view.getByTestId('blame-group');
  await expect(groups).toHaveCount(3);
  await expect(groups.nth(1)).toContainText('Add the middle');
  await groups.nth(0).click();
  await expect(commits.nth(3)).toHaveAttribute('aria-selected', 'true');

  // Esc: back to the diff, still on the same file.
  await page.keyboard.press('Escape');
  await expect(view).toHaveCount(0);
  await expect(diff).toBeVisible();
  await expect(diff.getByTestId('diff-path')).toContainText('story.txt');

  // The file row's Blame: six groups at HEAD; Alt+click selects the group's commit in the graph.
  await page.keyboard.press('Escape');
  await fileRow(page, 'src/story.txt').click({ button: 'right' });
  const menu = page.getByTestId('context-menu');
  await action(menu, 'Blame').click();
  await expect(view.getByTestId('blame-group')).toHaveCount(6);
  await view.getByTestId('blame-group').nth(1).click({ modifiers: ['Alt'] });
  await expect(view).toHaveCount(0);
  await expect(graphRow(page, 'Start the story')).toHaveAttribute('aria-selected', 'true');
});
