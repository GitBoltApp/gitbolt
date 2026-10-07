import { expect, test, type Locator, type Page } from './test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshFixture, git, openUrl } from './fixtures';

// Spec #3 §7 e2e flow 5: File History plus Blame, over the `file_history` fixture (plan 3A T2).
const graphRow = (page: Page, text: string) => page.getByRole('grid', { name: 'Commit graph' }).getByRole('row').filter({ hasText: text });
const fileRow = (page: Page, path: string) => page.getByRole('listbox', { name: 'Changed files' }).getByRole('option').and(page.locator(`[data-path="${path}"]`));
const action = (menu: Locator, label: string) => menu.locator('[data-depth="0"] > [role="menuitem"]').filter({ has: menu.page().locator('.ctx-label').getByText(label, { exact: true }) });

// One repo and page for these (each was a test of its own, paying for a page load and Monaco's
// start-up), in an order where each starts from what it needs (the history view closed).
test('File History and Blame: following the rename, Blame groups, Esc; the gutter beside the line numbers; a hash copies; the list resizes and persists', async ({ page, browserName }) => {
  const repo = freshFixture('file_history');
  // A Markdown guide edited once, for the last step's rendered diff.
  writeFileSync(join(repo, 'guide.md'), '# Setup guide\n\nRun the tool once.\n');
  git(repo, 'add', 'guide.md');
  git(repo, 'commit', '-qm', 'Add the guide');
  writeFileSync(join(repo, 'guide.md'), '# Setup guide\n\nRun the tool twice.\n');
  git(repo, 'commit', '-qam', 'Edit the guide');
  // Two plain files changed in one commit, for sticky File History (the last step).
  writeFileSync(join(repo, 'notes.txt'), 'Notes\n');
  writeFileSync(join(repo, 'todo.txt'), 'Todo\n');
  git(repo, 'add', 'notes.txt', 'todo.txt');
  git(repo, 'commit', '-qm', 'Start the notes');
  writeFileSync(join(repo, 'notes.txt'), 'Notes, kept\n');
  writeFileSync(join(repo, 'todo.txt'), 'Todo, done\n');
  git(repo, 'commit', '-qam', 'Edit the notes');
  await page.goto(openUrl(repo));
  await test.step('File History follows the rename, Blame groups the lines, a group selects its commit, Esc returns to the diff', async () => {
    const shaOf = (subject: string) => git(repo, 'log', '--format=%H', '-F', `--grep=${subject}`, '-1');
    await graphRow(page, 'Sharpen the opening').click();
    await fileRow(page, 'src/story.txt').click();
    const diff = page.getByRole('region', { name: 'Diff' });
    await expect(diff).toBeVisible();

    // The diff toolbar's History (spec #3 §4.2).
    await diff.getByRole('toolbar', { name: 'Diff options' }).getByRole('button', { name: 'History', exact: true }).click();
    const view = page.getByRole('region', { name: 'File history' });
    await expect(view.getByRole('heading')).toHaveText('File History: src/story.txt');
    // Opened from Diff View, it shows each version's Changes; the rest of this step reads the File.
    await expect(view.getByRole('button', { name: 'Changes', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await view.getByRole('button', { name: 'File', exact: true }).click();
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
  // UX round 1 B.1–B.3: Blame sits over the editor; the gutter is left of the line numbers, on the code's line box.
  await test.step('the blame gutter sits left of the line numbers, its text on the code\'s line box', async () => {
    await graphRow(page, 'Sharpen the opening').click();
    await fileRow(page, 'src/story.txt').click({ button: 'right' });
    await action(page.getByTestId('context-menu'), 'Blame').click();
    const view = page.getByRole('region', { name: 'File history' });
    const group = view.locator('[data-testid="blame-group"][data-line="3"]');
    await expect(group).toContainText('Add the middle');
    const editor = view.getByTestId('file-view');
    const box = async (l: Locator) => (await l.boundingBox())!;

    // B.1: the toggle sits over the editor's column, not over the commit list.
    expect((await box(view.getByRole('button', { name: 'Blame', exact: true }))).x).toBeGreaterThanOrEqual((await box(editor)).x);

    // B.3: line 3's blame text box is the code line's box (top and bottom within 1 px), at Monaco's line height.
    const summary = group.locator('.blame-summary');
    const text = await box(summary);
    const code = await box(editor.locator('.view-line').filter({ hasText: 'It grew a middle part' }));
    expect(Math.abs(text.y - code.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(text.y + text.height - (code.y + code.height))).toBeLessThanOrEqual(1);
    const lineHeight = await editor.locator('.view-line').first().evaluate((n) => getComputedStyle(n).lineHeight);
    expect(await summary.evaluate((n) => getComputedStyle(n).lineHeight)).toBe(lineHeight);
    const avatar = await box(group.getByTestId('avatar'));
    expect(Math.abs(avatar.y + avatar.height / 2 - (code.y + code.height / 2))).toBeLessThanOrEqual(1);

    // B.2: blame | line numbers | code. The number's own glyphs (a Range: Monaco right-aligns them in a wider cell).
    const number = await editor.locator('.line-numbers').filter({ hasText: /^3$/ }).evaluate((n) => {
      const r = document.createRange();
      r.selectNodeContents(n);
      const b = r.getBoundingClientRect();
      return { x: b.x, y: b.y, height: b.height };
    });
    const gutter = await box(view.getByTestId('blame-gutter'));
    expect(gutter.x + gutter.width).toBeLessThanOrEqual(number.x);
    // About 200 px, at most 35% of the editor (give or take a digit cell's rounding).
    expect(gutter.width).toBeLessThanOrEqual(Math.min(200, 0.35 * (await box(editor)).width) + 10);
    expect(number.x).toBeLessThan(code.x);
    expect(Math.abs(number.y + number.height / 2 - (code.y + code.height / 2))).toBeLessThanOrEqual(1);
    if (process.env.GITBOLT_BLAME_SHOT) await view.screenshot({ path: process.env.GITBOLT_BLAME_SHOT });
  });
  // UX J: a short hash copies the full one (the row stays unselected); the list column resizes, the bar following.
  await test.step('clicking a hash copies it without selecting the row; the list resizes with the header and persists', async () => {
    // The Blame view closed first: it covers the graph.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('region', { name: 'File history' })).toHaveCount(0);
    const openHistory = async () => {
      await graphRow(page, 'Sharpen the opening').click();
      await fileRow(page, 'src/story.txt').click();
      await page.getByRole('region', { name: 'Diff' }).getByRole('toolbar', { name: 'Diff options' }).getByRole('button', { name: 'History', exact: true }).click();
    };
    await openHistory();
    const view = page.getByRole('region', { name: 'File history' });
    const commits = view.getByRole('listbox', { name: 'Commits' }).getByRole('option');
    await expect(commits).toHaveCount(4);
    const full = git(repo, 'log', '--format=%H', '-F', '--grep=Start the story', '-1');
    await expect(commits.nth(0)).toHaveAttribute('aria-selected', 'true');
    await commits.nth(3).getByRole('button', { name: `Copy ${full}` }).click();
    await expect(page.getByText('Copied', { exact: true })).toBeVisible();
    await expect(commits.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(commits.nth(3)).toHaveAttribute('aria-selected', 'false');
    if (browserName === 'chromium') expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(full);

    const sep = view.getByRole('separator', { name: 'Resize commit list' });
    const list = view.locator('.file-history-list');
    const before = (await list.boundingBox())!.width;
    await sep.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await list.boundingBox())!.width).toBe(before + 16);
    const box = (await sep.boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 82, box.y + 40, { steps: 4 });
    await page.mouse.up();
    const widened = (await list.boundingBox())!.width;
    expect(widened).toBeGreaterThan(before + 60);
    // The bar's columns follow: the Blame toggle sits over the editor, right of the list.
    expect((await view.getByRole('button', { name: 'Blame', exact: true }).boundingBox())!.x).toBeGreaterThanOrEqual(widened);
    await page.reload();
    await openHistory();
    await expect.poll(async () => (await list.boundingBox())!.width).toBe(widened);
  });
  await test.step('Changes: the commit\'s diff of the file, row by row, in place of the file; a Markdown file\'s rendered', async () => {
    const view = page.getByRole('region', { name: 'File history' });
    const commits = view.getByRole('listbox', { name: 'Commits' }).getByRole('option');
    await expect(commits.nth(0)).toHaveAttribute('aria-selected', 'true');
    // Reopened from Diff View, it's on Changes: start from File to compare the two.
    await view.getByRole('group', { name: 'History view' }).getByRole('button', { name: 'File' }).click();
    await expect(view.getByTestId('file-view')).toContainText('Once upon a sharper time');
    const top = (await view.locator('.diff-body').boundingBox())!.y;
    await view.getByRole('group', { name: 'History view' }).getByRole('button', { name: 'Changes' }).click();
    const changes = view.getByTestId('history-changes');
    const inserted = changes.locator('.editor.modified .line-insert');
    await expect(inserted).toHaveCount(1);
    await expect(changes.locator('.editor.modified .view-line').filter({ hasText: 'Once upon a sharper time' })).toBeVisible();
    expect((await changes.boundingBox())!.y).toBe(top);
    await expect(view.getByRole('button', { name: 'Blame', exact: true })).toHaveAttribute('aria-disabled', 'true');
    // An older row (the rename under src): its own change, against the old path.
    await view.getByRole('listbox', { name: 'Commits' }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(changes.locator('.view-line').filter({ hasText: 'Once upon a sharper time' })).toHaveCount(0);
    await expect(changes.locator('.editor.modified .view-line').filter({ hasText: 'until the day it moved under src.' })).toBeVisible();
    await expect(inserted).toHaveCount(1);

    // Another file's history opens on Changes (remembered): a Markdown file's diff, rendered.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await graphRow(page, 'Edit the guide').click();
    await fileRow(page, 'guide.md').click();
    await page.getByRole('region', { name: 'Diff' }).getByRole('toolbar', { name: 'Diff options' }).getByRole('button', { name: 'History', exact: true }).click();
    await expect(view.getByRole('heading', { name: 'File History: guide.md' })).toBeVisible();
    const md = view.getByTestId('markdown-diff');
    await expect(md.locator('p del')).toContainText('once');
    await expect(md.locator('p ins')).toContainText('twice');
  });
  // UX: File History is sticky. While it's open, a file picked in the right panel opens in it too.
  await test.step('sticky: another file picked in Blame opens in Blame; once closed, a file opens its diff', async () => {
    const view = page.getByRole('region', { name: 'File history' });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await graphRow(page, 'Edit the notes').click();
    await fileRow(page, 'notes.txt').click();
    const diff = page.getByRole('region', { name: 'Diff' });
    await diff.getByRole('toolbar', { name: 'Diff options' }).getByRole('button', { name: 'Blame', exact: true }).click();
    await expect(view.getByRole('heading', { name: 'File History: notes.txt' })).toBeVisible();
    // The previous step left `File | Changes` on Changes, where Blame is off.
    await view.getByRole('group', { name: 'History view' }).getByRole('button', { name: 'File' }).click();
    await expect(view.getByTestId('blame-group')).toContainText('Edit the notes');

    await fileRow(page, 'todo.txt').click();
    await expect(view.getByRole('heading', { name: 'File History: todo.txt' })).toBeVisible();
    await expect(view.getByRole('button', { name: 'Blame', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(view.getByTestId('blame-group')).toContainText('Edit the notes');
    await expect(view.getByTestId('file-view')).toContainText('Todo, done');
    // The keyboard stays in the file list: ↑ steps to the other file, still in Blame.
    await page.keyboard.press('ArrowUp');
    await expect(view.getByRole('heading', { name: 'File History: notes.txt' })).toBeVisible();
    await expect(view.getByTestId('file-view')).toContainText('Notes, kept');

    // Closed, the mode ends: a file picked opens its Diff View.
    await view.getByRole('button', { name: 'Close file history' }).click();
    await expect(view).toHaveCount(0);
    await fileRow(page, 'todo.txt').click();
    await expect(diff.getByTestId('diff-path')).toContainText('todo.txt');
    await expect(view).toHaveCount(0);
  });
});

