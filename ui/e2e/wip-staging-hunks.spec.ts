import type { Locator } from '@playwright/test';
import { expect, test, type Page } from './test';
import { git } from './fixtures';
import { fileRow, fileRowSelector, openWip, timedClick } from './wip';

const zones = (page: Page) => page.locator('.diff-panel .hunk-zone');
const mode = (page: Page, name: 'Hunk' | 'Inline' | 'Split') => page.getByRole('group', { name: 'View mode' }).getByRole('button', { name });
/** A hunk zone's button. The zones are Monaco view zones, whose container Monaco marks aria-hidden. */
const hunkButton = (zone: Locator, name: string) => zone.getByRole('button', { name, includeHidden: true });
/** The file list header's staging Undo (§7.6). */
const undoStaging = (page: Page) => page.locator('.wip-view-bar').getByRole('button', { name: 'Undo staging' }).click();
const modified = (page: Page) => page.locator('.diff-panel .editor.modified');
/** Monaco renders only the lines in view: wheel the modified side down until `text`'s line is in the DOM. */
async function revealLine(page: Page, text: string): Promise<Locator> {
  const line = modified(page).locator('.view-line').filter({ hasText: text });
  await expect(modified(page).locator('.view-line').first()).toBeVisible({ timeout: 15_000 });
  await modified(page).hover();
  await expect(async () => {
    if ((await line.count()) === 0) await page.mouse.wheel(0, 120);
    await expect(line).toBeVisible({ timeout: 200 });
  }).toPass();
  return line;
}

test.describe('hunks and lines (spec #2 §7.3)', () => {
  for (const m of ['Hunk', 'Inline', 'Split'] as const) {
    test(`hunk buttons sit at the backend's hunks in ${m} mode`, async ({ page }) => {
      const repo = await openWip(page);
      await fileRow(page, 'unstaged', 'src/app.txt').click();
      await mode(page, m).click();
      await expect(zones(page)).toHaveCount(3);
      await hunkButton(zones(page).nth(1), 'Stage hunk').click();
      await expect(fileRow(page, 'staged', 'src/app.txt')).toBeVisible();
      await expect(fileRow(page, 'unstaged', 'src/app.txt')).toHaveAttribute('aria-selected', 'true');
      await expect(zones(page)).toHaveCount(2);
      expect(git(repo, 'diff', '--cached', '--', 'src/app.txt')).toContain('+app 20 changed');
    });
  }

  test('Unstage hunk on a staged diff; Discard hunk is undoable', async ({ page }) => {
    const repo = await openWip(page);
    await fileRow(page, 'staged', 'notes.txt').click();
    await hunkButton(zones(page).first(), 'Unstage hunk').click();
    await expect(fileRow(page, 'staged', 'notes.txt')).toHaveCount(0);
    await fileRow(page, 'unstaged', 'src/app.txt').click();
    await hunkButton(zones(page).first(), 'Discard hunk').click();
    await expect(zones(page)).toHaveCount(2);
    expect(git(repo, 'diff', '--', 'src/app.txt')).not.toContain('app 05 changed');
    await page.getByRole('toolbar', { name: 'Repository toolbar' }).getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => git(repo, 'diff', '--', 'src/app.txt')).toContain('app 05 changed');
  });

  test('a line selection stages just that line (< 150 ms, best of 3); hunk buttons wait for a save', async ({ page }) => {
    const repo = await openWip(page);
    await fileRow(page, 'unstaged', 'src/app.txt').click();
    await mode(page, 'Inline').click();
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      await (await revealLine(page, 'app 35 changed')).click();
      await page.keyboard.press('Home');
      await page.keyboard.press('Shift+End');
      runs.push(await timedClick(page, page.getByRole('toolbar', { name: 'Selected lines' }).getByRole('button', { name: 'Stage 1 line' }), fileRowSelector('staged', 'src/app.txt')));
      expect(git(repo, 'diff', '--cached', '--', 'src/app.txt')).toContain('+app 35 changed');
      expect(git(repo, 'diff', '--cached', '--', 'src/app.txt')).not.toContain('+app 20 changed');
      if (i === 2) break;
      await undoStaging(page);
      await expect(fileRow(page, 'staged', 'src/app.txt')).toHaveCount(0);
      await expect(zones(page)).toHaveCount(3);
    }
    console.log(`[budget] stage selected lines: ${runs.map((n) => n.toFixed(1)).join(', ')} ms`);
    expect(Math.min(...runs), `stage lines: ${runs.map((n) => n.toFixed(1)).join(', ')} ms`).toBeLessThan(150);
    // The modified side's own lines; Inline mode's deleted lines are view zones, also `.view-lines`.
    await modified(page).locator('.view-lines:not(.line-delete)').click();
    await page.keyboard.type('x');
    await expect(hunkButton(zones(page).first(), 'Stage hunk')).toHaveAttribute('aria-disabled', 'true');
  });

  test('budget (§16): stage a hunk < 100 ms, best of 3', async ({ page }) => {
    await openWip(page);
    await fileRow(page, 'unstaged', 'src/app.txt').click();
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      await expect(zones(page)).toHaveCount(3);
      runs.push(await timedClick(page, hunkButton(zones(page).first(), 'Stage hunk'), fileRowSelector('staged', 'src/app.txt')));
      await undoStaging(page);
      await expect(fileRow(page, 'staged', 'src/app.txt')).toHaveCount(0);
    }
    console.log(`[budget] stage a hunk: ${runs.map((n) => n.toFixed(1)).join(', ')} ms`);
    expect(Math.min(...runs), `stage a hunk: ${runs.map((n) => n.toFixed(1)).join(', ')} ms`).toBeLessThan(100);
  });
});
