import { fixtures, git, harnessWs, openUrl } from './fixtures';
import { expect, test, type Page } from './test';

/** Plan 1C Task 17: find (Ctrl+F, spec §8.7; the user's J5). */

const grid = (page: Page) => page.getByRole('grid', { name: 'Commit graph' });
const row = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text });
const count = (page: Page) => page.getByRole('search', { name: 'Find in graph' }).locator('.find-count');
/** Rows whose text cells carry the shared row-dim's 'filter' level (rowDim.ts). */
const filtered = (page: Page) => page.locator('.graph-row:has([data-col="message"].row-dim-filter)');
const input = (page: Page) => page.getByRole('textbox', { name: 'Find commits' });

/** Sets the commit window (the setting) through the harness's own API, before the app boots. */
async function setCommitLimit(page: Page, limit: number) {
  await page.goto('/?no-repo');
  await page.evaluate(({ url, limit }) => new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    const send = (id: number, req: object) => ws.send(JSON.stringify({ id, req }));
    ws.onopen = () => send(1, { method: 'loadState' });
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; ok?: { settings: object }; err?: unknown };
      if (m.err) return reject(new Error(JSON.stringify(m.err)));
      if (m.id === 1) send(2, { method: 'saveSettings', params: { settings: { ...m.ok!.settings, commitLimit: limit } } });
      else if (m.id === 2) {
        ws.close();
        resolve();
      }
    };
  }), { url: harnessWs, limit });
}

test.describe('find', () => {
  // Each `test.step` below was a test of its own, paying for a page load; they run in an order
  // where each starts from what it needs (the graph's box closed before a file opens).
  test('find in the graph: the Search tooltip, the box, stepping and wrapping, paths and SHAs; with a file open, the editor\'s own find', async ({ page }) => {
    await page.goto(openUrl(fixtures.basic));
    await expect(grid(page)).toBeVisible();
    await test.step('the toolbar Search tooltip keeps its natural width at the right edge: no mid-word wrap, fully on screen (K52)', async () => {
      await page.getByRole('button', { name: 'Search' }).hover();
      const tip = page.getByRole('tooltip');
      await expect(tip).toBeVisible();
      const m = await tip.evaluate((el) => {
        const r = el.getBoundingClientRect();
        // Natural width: the same content with no horizontal limit but the css max-width.
        const clone = el.cloneNode(true) as HTMLElement;
        clone.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;';
        document.body.append(clone);
        const natural = clone.getBoundingClientRect().width;
        clone.remove();
        // A word that wraps would make scrollWidth exceed the box, or a line hold part of a word.
        const words = (el.textContent ?? '').split(/\s+/).filter(Boolean);
        const range = document.createRange();
        const lines = new Map<number, string>();
        const text = el.firstChild as Text;
        let pos = 0;
        let broken = false;
        for (const w of words) {
          const at = (text.data as string).indexOf(w, pos);
          pos = at + w.length;
          range.setStart(text, at);
          range.setEnd(text, at + w.length);
          if (new Set([...range.getClientRects()].map((q) => Math.round(q.top))).size > 1) broken = true;
          lines.set(at, w);
        }
        return { width: r.width, natural, right: r.right, left: r.left, vw: window.innerWidth, broken };
      });
      expect(m.broken).toBe(false);
      expect(m.width).toBeGreaterThanOrEqual(m.natural - 1);
      expect(m.left).toBeGreaterThanOrEqual(0);
      expect(m.right).toBeLessThanOrEqual(m.vw);
    });
    await test.step('Ctrl+F opens the box at the graph panel\'s top right; typing dims the non-matches; Enter / Shift+Enter step; Esc closes and clears', async () => {
      await grid(page).click({ position: { x: 300, y: 60 } });
      await page.keyboard.press('Control+f');
      const box = page.getByRole('search', { name: 'Find in graph' });
      await expect(input(page)).toBeFocused();
      // Top-right of the graph panel (J5): its right edge near the panel's, its top near the grid's.
      const b = (await box.boundingBox())!;
      const panel = (await page.locator('.center-panel').boundingBox())!;
      expect(panel.x + panel.width - (b.x + b.width)).toBeLessThan(40);
      expect(b.y - panel.y).toBeLessThan(40);
      await input(page).fill('login');
      await expect(count(page)).toHaveText('1 / 3');
      // 10 rows (8 commits, the stash among them, and 2 WIP rows); 3 match "login".
      await expect(filtered(page)).toHaveCount(7);
      await expect(row(page, "Merge branch 'feature/login'")).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Enter');
      await expect(count(page)).toHaveText('2 / 3');
      await expect(row(page, 'Login validation')).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Shift+Enter');
      await expect(count(page)).toHaveText('1 / 3');
      await page.keyboard.press('Escape');
      await expect(box).toHaveCount(0);
      await expect(filtered(page)).toHaveCount(0);
      await expect(grid(page)).toBeFocused();
      // Reopened, it's empty.
      await page.keyboard.press('Control+f');
      await expect(input(page)).toHaveValue('');
    });
    await test.step('repeated Enter / Shift+Enter jumps move the selection and the counter every time (K40)', async () => {
      await grid(page).click({ position: { x: 300, y: 60 } });
      await page.keyboard.press('Control+f');
      await input(page).fill('e');
      await expect(count(page)).toHaveText(/^1 \/ [1-9]/);
      const total = Number((await count(page).textContent())!.split('/')[1]);
      expect(total).toBeGreaterThan(2);
      const selected = page.locator('.graph-row[aria-selected="true"]');
      const seen: string[] = [];
      for (let i = 0; i < total + 1; i++) {
        await expect(count(page)).toHaveText(`${(i % total) + 1} / ${total}`);
        await expect(selected).toHaveCount(1);
        seen.push((await selected.textContent()) ?? '');
        await page.keyboard.press('Enter');
      }
      // Every match was visited once, then it wrapped to the first.
      expect(new Set(seen.slice(0, total)).size).toBe(total);
      expect(seen[total]).toBe(seen[0]);
      // Now on the 2nd match: back twice wraps to the last.
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.press('Shift+Enter');
      await expect(count(page)).toHaveText(`${total} / ${total}`);
    });
    await test.step('path search finds the commits that touched a file', async () => {
      await page.keyboard.press('Control+f');
      await input(page).fill('file_3');
      // Login validation, and the merge (against its first parent).
      await expect(count(page)).toHaveText('1 / 2');
      await expect(page.getByLabel('Searching paths')).toHaveCount(0);
      await expect(row(page, "Merge branch 'feature/login'")).toHaveAttribute('aria-selected', 'true');
    });
    await test.step('a SHA prefix finds its commit', async () => {
      const sha = (await row(page, 'Fix typo').getByTestId('sha').textContent())!.trim();
      await page.keyboard.press('Control+f');
      await input(page).fill(sha.slice(0, 7));
      await expect(count(page)).toHaveText('1 / 1');
      await expect(row(page, 'Fix typo')).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('search', { name: 'Find in graph' })).toHaveCount(0);
    });
    await test.step('with a file open, Ctrl+F opens the editor\'s own find, not the graph\'s (R7)', async () => {
      await row(page, 'Fix typo').click();
      await page.getByRole('listbox', { name: 'Changed files' }).getByRole('option').first().click();
      const diff = page.getByRole('region', { name: 'Diff' });
      await expect(diff.locator('.editor.modified')).toBeVisible({ timeout: 15_000 });
      // Focus is in the file list, not the editor: Ctrl+F still goes to the editor's find.
      await page.keyboard.press('Control+f');
      await expect(diff.locator('.editor.modified .find-widget.visible')).toBeVisible();
      await expect(page.getByRole('search', { name: 'Find in graph' })).toHaveCount(0);
      // Closing the file, Ctrl+F is the graph's again.
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(grid(page)).toBeVisible();
      await page.keyboard.press('Control+f');
      await expect(input(page)).toBeFocused();
    });
  });

  test('outside the window: a full hash loads a deeper window; "Search older history" lists older commits and reveals one', async ({ page }) => {
    await setCommitLimit(page, 20);
    await page.goto(openUrl(fixtures.longHistory));
    await expect(grid(page)).toBeVisible();
    await expect(row(page, 'Commit 59')).toBeVisible();
    await expect(row(page, 'Commit 05')).toHaveCount(0);
    const old = git(fixtures.longHistory, 'log', '--format=%H', '--grep=^Commit 03$');
    await page.keyboard.press('Control+f');
    await input(page).fill(old);
    await expect(count(page)).toHaveText('1 / 1');
    await expect(row(page, 'Commit 03')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');

    // A fresh 20-commit window: "Commit 05" isn't in it.
    await page.reload();
    await expect(row(page, 'Commit 59')).toBeVisible();
    await expect(row(page, 'Commit 05')).toHaveCount(0);
    await page.keyboard.press('Control+f');
    await input(page).fill('Commit 05');
    await expect(count(page)).toHaveText('0 / 0');
    await page.getByRole('button', { name: 'Search older history' }).click();
    const older = page.getByRole('list', { name: 'Older commits' });
    await expect(older.getByRole('button')).toHaveCount(1);
    await older.getByRole('button', { name: /Commit 05/ }).click();
    await expect(row(page, 'Commit 05')).toHaveAttribute('aria-selected', 'true');
  });
});
