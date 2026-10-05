import type { Locator } from '@playwright/test';
import { budgetApplies, expect, test, type Page } from './test';
import { git } from './fixtures';
import { fileRow, fileRowSelector, openWip, timedClick } from './wip';

/** Hunk mode's hunk header rows (Monaco view zones). */
const zones = (page: Page) => page.locator('.diff-panel .hunk-zone');
/** The gutter's + / − on the hovered changed line (an overlay widget; one per side, shown on hover). */
const gutterButton = (page: Page) => page.locator('.diff-panel .line-stage-glyph:visible');
const mode = (page: Page, name: 'Hunk' | 'Inline' | 'Split') => page.getByRole('group', { name: 'View mode' }).getByRole('button', { name });
/** A hunk zone's button. The zones are Monaco view zones, whose container Monaco marks aria-hidden. */
const hunkButton = (zone: Locator, name: string) => zone.getByRole('button', { name, includeHidden: true });
/** The file list header's staging Undo (§7.6). */
const undoStaging = (page: Page) => page.locator('.wip-view-bar').getByRole('button', { name: 'Undo staging' }).click();
const modified = (page: Page) => page.locator('.diff-panel .editor.modified');
/** Runs `act` (a write), then waits for the diff to show again with the write's result. */
async function reshown(page: Page, act: () => Promise<void>): Promise<void> {
  const host = page.locator('.diff-panel .monaco-host[data-diff-computed]').first();
  const before = await host.getAttribute('data-diff-computed');
  await act();
  await expect(host).not.toHaveAttribute('data-diff-computed', before ?? '');
}
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
  test("Hunk mode's header rows sit at the backend's hunks", async ({ page }) => {
    const repo = await openWip(page);
    await fileRow(page, 'unstaged', 'src/app.txt').click();
    await mode(page, 'Hunk').click();
    await expect(zones(page)).toHaveCount(3);
    await expect(zones(page).nth(1)).toContainText('@@ -17,7 +17,7 @@');
    await hunkButton(zones(page).nth(1), 'Stage hunk').click();
    await expect(fileRow(page, 'staged', 'src/app.txt')).toBeVisible();
    await expect(fileRow(page, 'unstaged', 'src/app.txt')).toHaveAttribute('aria-selected', 'true');
    await expect(zones(page)).toHaveCount(2);
    expect(git(repo, 'diff', '--cached', '--', 'src/app.txt')).toContain('+app 20 changed');
  });

  // Both modes in one page (each was a test of its own, paying for a page and Monaco).
  test("Inline and Split modes: no rows between lines; the gutter's + stages one line, the menu a hunk", async ({ page }) => {
    const repo = await openWip(page);
    const staged = () => git(repo, 'diff', '--cached', '--', 'src/app.txt');
    for (const m of ['Inline', 'Split'] as const) {
      await fileRow(page, 'unstaged', 'src/app.txt').click();
      await mode(page, m).click();
      await (await revealLine(page, 'app 20 changed')).hover();
      await expect(gutterButton(page)).toHaveAccessibleName('Stage this line');
      await expect(zones(page)).toHaveCount(0);
      await reshown(page, () => gutterButton(page).click());
      await expect(fileRow(page, 'staged', 'src/app.txt')).toBeVisible();
      expect(staged(), m).toContain('+app 20 changed');
      expect(staged(), m).not.toContain('app 05');
      // The right-click menu: the clicked line's hunk.
      await (await revealLine(page, 'app 35 changed')).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Stage hunk' }).click();
      await expect.poll(staged, { message: m }).toContain('+app 35 changed');
      // Nothing staged again (the two steps undone), and the file closed (a click on the open
      // file's row), so the next mode starts as this one did.
      await undoStaging(page);
      await expect.poll(staged).not.toContain('+app 35 changed');
      await undoStaging(page);
      await expect.poll(staged).toBe('');
      await fileRow(page, 'unstaged', 'src/app.txt').click();
      await expect(page.getByRole('region', { name: 'Diff' })).toHaveCount(0);
    }
  });

  test("staging a file's only hunk moves it out of Unstaged", async ({ page }) => {
    const repo = await openWip(page);
    await fileRow(page, 'unstaged', 'space name.txt').click();
    await mode(page, 'Hunk').click();
    await expect(zones(page)).toHaveCount(1);
    await hunkButton(zones(page).first(), 'Stage hunk').click();
    await expect(fileRow(page, 'staged', 'space name.txt')).toBeVisible();
    await expect(fileRow(page, 'unstaged', 'space name.txt')).toHaveCount(0);
    expect(git(repo, 'status', '--porcelain=v2', '--', 'space name.txt')).toMatch(/^1 M\. /);
  });

  test("a selection's right-click stages these lines; Inline's deleted line takes the gutter's +", async ({ page }) => {
    const repo = await openWip(page);
    await fileRow(page, 'unstaged', 'src/app.txt').click();
    await mode(page, 'Inline').click();
    const line = await revealLine(page, 'app 05 changed');
    await line.click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await line.click({ button: 'right' });
    await reshown(page, () => page.getByRole('menuitem', { name: 'Stage this line' }).click());
    await expect(fileRow(page, 'staged', 'src/app.txt')).toBeVisible();
    expect(git(repo, 'diff', '--cached', '--', 'src/app.txt')).toContain('+app 05 changed');
    // The old line, drawn in a deleted-lines zone.
    await modified(page).locator('.line-delete .view-line').filter({ hasText: 'app 20' }).hover();
    await gutterButton(page).click();
    await expect.poll(() => git(repo, 'diff', '--cached', '--', 'src/app.txt')).toContain('-app 20');
  });

  test('Unstage hunk on a staged diff; Discard hunk is undoable', async ({ page }) => {
    const repo = await openWip(page);
    await fileRow(page, 'staged', 'notes.txt').click();
    await mode(page, 'Hunk').click();
    await hunkButton(zones(page).first(), 'Unstage hunk').click();
    await expect(fileRow(page, 'staged', 'notes.txt')).toHaveCount(0);
    await fileRow(page, 'unstaged', 'src/app.txt').click();
    await hunkButton(zones(page).first(), 'Discard hunk').click();
    await expect(zones(page)).toHaveCount(2);
    expect(git(repo, 'diff', '--', 'src/app.txt')).not.toContain('app 05 changed');
    await page.getByRole('toolbar', { name: 'Repository toolbar' }).getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => git(repo, 'diff', '--', 'src/app.txt')).toContain('app 05 changed');
  });

  test('a line selection stages just that line (< 150 ms, best of 3); hunk buttons wait for a save', { tag: '@budget' }, async ({ page }) => {
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
    }
    console.log(`[budget] stage selected lines: ${runs.map((n) => n.toFixed(1)).join(', ')} ms`);
    if (budgetApplies()) expect(Math.min(...runs), `stage lines: ${runs.map((n) => n.toFixed(1)).join(', ')} ms`).toBeLessThan(150);
    // The modified side's own lines; Inline mode's deleted lines are view zones, also `.view-lines`.
    await modified(page).locator('.view-lines:not(.line-delete)').click();
    await page.keyboard.type('x');
    await mode(page, 'Hunk').click();
    await expect(hunkButton(zones(page).first(), 'Stage hunk')).toHaveAttribute('aria-disabled', 'true');
  });

  test('budget (§16): stage a hunk < 100 ms, best of 3', { tag: '@budget' }, async ({ page }) => {
    await openWip(page);
    await fileRow(page, 'unstaged', 'src/app.txt').click();
    await mode(page, 'Hunk').click();
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      await expect(zones(page)).toHaveCount(3);
      runs.push(await timedClick(page, hunkButton(zones(page).first(), 'Stage hunk'), fileRowSelector('staged', 'src/app.txt')));
      await undoStaging(page);
      await expect(fileRow(page, 'staged', 'src/app.txt')).toHaveCount(0);
    }
    console.log(`[budget] stage a hunk: ${runs.map((n) => n.toFixed(1)).join(', ')} ms`);
    if (budgetApplies()) expect(Math.min(...runs), `stage a hunk: ${runs.map((n) => n.toFixed(1)).join(', ')} ms`).toBeLessThan(100);
  });
});
