import { chmodSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from './test';
import { openWip, selectWip } from './wip';
import { freshFixture, git, openUrl } from './fixtures';

const row = (page: import('@playwright/test').Page) => page.getByRole('textbox', { name: 'Commit summary draft' }).first();

test.describe('the WIP draft (spec #2 §8.2)', () => {
  test('persists across a reload, unlimited, with the counter past 60 and its warning past 72', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    await row(page).fill('A'.repeat(75));
    await expect(page.getByTestId('wip-counter')).toHaveText('75');
    await expect(page.getByTestId('wip-counter')).toHaveClass(/warn/);
    await row(page).press('Enter');
    await page.reload();
    await expect(row(page)).toHaveValue('A'.repeat(75));
  });

  test('a v1 draft migrates into v2', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    await page.evaluate(([r]) => {
      localStorage.removeItem('gitbolt.wipDraft.v2');
      localStorage.setItem(`gitbolt.wipDraft.v1:${r}\u0000${r}`, 'Old v1 summary');
    }, [repo]);
    await page.reload();
    await expect(row(page)).toHaveValue('Old v1 summary');
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('gitbolt.wipDraft.v1')))).toEqual([]);
  });
});

const box = (page: Page) => page.getByTestId('commit-box');
const summary = (page: Page) => box(page).getByRole('textbox', { name: 'Commit summary' });
const description = (page: Page) => box(page).getByRole('textbox', { name: 'Commit description' });
const button = (page: Page) => box(page).locator('.commit-button');
/** Amend ticks once HEAD's message has loaded (§8.1), so `check()`'s immediate re-read can miss it. */
const amend = (page: Page) => box(page).getByRole('checkbox', { name: 'Amend' });

test.describe('the commit box (spec #2 §8.1, §8.2)', () => {
  test('commits what is staged, clears the draft, selects the new commit (< 300 ms, best of 3)', async ({ page }) => {
    const repo = await openWip(page);
    await expect(button(page)).toHaveText('Commit changes to 1 file');
    await summary(page).fill('Stage notes');
    await description(page).fill('Why: the fixture');
    const t0 = Date.now();
    await summary(page).press('Control+Enter');
    await expect(page.getByRole('grid', { name: 'Commit graph' }).getByText('Stage notes')).toBeVisible();
    const ms = Date.now() - t0;
    expect(git(repo, 'log', '-1', '--format=%B')).toBe('Stage notes\n\nWhy: the fixture');
    await selectWip(page);
    await expect(summary(page)).toHaveValue('');
    expect(ms, 'commit → graph').toBeLessThan(300); // §16; the wave pass reports the best of 3 runs
  });

  test('the row box and the commit box are one draft', async ({ page }) => {
    await openWip(page);
    await summary(page).fill('Typed below');
    await expect(page.getByRole('textbox', { name: 'Commit summary draft' }).first()).toHaveValue('Typed below');
  });

  test('Stage all & commit when nothing is staged; disabled reasons', async ({ page }) => {
    const repo = await openWip(page);
    await page.locator('.wip-section[data-section="staged"]').getByRole('button', { name: 'Unstage all' }).click();
    await expect(button(page)).toHaveText('Stage all & commit');
    await button(page).hover();
    await expect(page.getByRole('tooltip')).toHaveText('Write a commit summary');
    await summary(page).fill('Everything');
    await button(page).click();
    await expect(page.getByRole('grid', { name: 'Commit graph' }).getByText('Everything')).toBeVisible();
    expect(git(repo, 'status', '--porcelain')).toBe('');
    // §8.1: the graph selects the new commit; a clean worktree has no WIP row, so no commit box.
    await expect(page.getByRole('grid', { name: 'Commit graph' }).getByRole('row').filter({ hasText: 'Everything' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('grid', { name: 'Commit graph' }).getByRole('row').filter({ hasText: '// WIP' })).toHaveCount(0);
    await expect(box(page)).toHaveCount(0);
  });

  test('Enter moves to the description; ↑ comes back', async ({ page }) => {
    await openWip(page);
    await summary(page).fill('Sum');
    await summary(page).press('Enter');
    await expect(description(page)).toBeFocused();
    await page.keyboard.type('line 1');
    await page.keyboard.press('ArrowUp');
    await expect(summary(page)).toBeFocused();
  });

  test('a failed commit keeps the draft', async ({ page }) => {
    const repo = await openWip(page);
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho "lint failed" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    await summary(page).fill('Will fail');
    await button(page).click();
    await expect(page.getByRole('alert').or(page.getByRole('status')).filter({ hasText: 'pre-commit hook failed' })).toBeVisible();
    await expect(summary(page)).toHaveValue('Will fail');
  });

  test('Amend: HEAD’s message, the draft put aside; clicking a commit keeps it; untick restores the draft', async ({ page }) => {
    await openWip(page);
    await summary(page).fill('My draft');
    await amend(page).click();
    await expect(amend(page)).toBeChecked();
    await expect(summary(page)).toHaveValue('Base');
    await expect(button(page)).toHaveText('Amend previous commit');
    await expect(page.getByRole('textbox', { name: 'Commit summary draft' }).first()).toHaveValue('My draft');
    await summary(page).fill('Base, amended');
    await page.getByRole('grid', { name: 'Commit graph' }).getByText('Base').click();
    await selectWip(page);
    await expect(summary(page)).toHaveValue('Base, amended');
    await amend(page).click();
    await expect(amend(page)).not.toBeChecked();
    await expect(summary(page)).toHaveValue('My draft');
  });

  test('a CRLF HEAD message loads without blank lines on top of the description', async ({ page }) => {
    const repo = await openWip(page);
    writeFileSync(join(repo, 'crlf-msg'), 'Windows\r\n\r\n\r\nbody line\r\n');
    git(repo, 'commit', '--allow-empty', '--cleanup=verbatim', '-F', 'crlf-msg');
    await page.reload();
    await selectWip(page);
    await amend(page).click();
    await expect(amend(page)).toBeChecked();
    await expect(description(page)).toHaveValue('body line');
  });
});

test.describe('edit the HEAD message (spec #2 §8.3)', () => {
  test('the pencil amends only the message; staged changes stay staged; Undo restores it', async ({ page }) => {
    const repo = await openWip(page);
    await page.getByRole('grid', { name: 'Commit graph' }).getByText('Base').click();
    await page.getByRole('button', { name: 'Edit message' }).click();
    const editor = page.getByTestId('head-message-editor');
    await editor.getByRole('textbox', { name: 'Commit summary' }).fill('Base, reworded');
    await editor.getByRole('textbox', { name: 'Commit summary' }).press('Control+Enter');
    await expect(page.getByRole('grid', { name: 'Commit graph' }).getByText('Base, reworded')).toBeVisible();
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('notes.txt');
    await page.getByRole('toolbar', { name: 'Repository toolbar' }).getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByRole('grid', { name: 'Commit graph' }).getByText('Base', { exact: true })).toBeVisible();
  });

  test('a HEAD already on its upstream says a force push will be needed', async ({ page }) => {
    const repo = await openWip(page);
    const origin = join(dirname(repo), 'origin.git');
    git(dirname(repo), 'init', '-q', '--bare', origin);
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    await page.reload();
    await page.getByRole('grid', { name: 'Commit graph' }).getByText('Base').click();
    await page.getByRole('button', { name: 'Edit message' }).click();
    await expect(page.getByRole('note')).toHaveText("This commit is on origin/main; you'll need to force push.");
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('head-message-editor')).toHaveCount(0);
  });
});
