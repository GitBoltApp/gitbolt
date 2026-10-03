import { expect, test, type Locator, type Page } from './test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtures, freshFixture, git, openUrl } from './fixtures';

// UX round 2, lane K: a binary's hex view. Per side, a hex pane (bytes only, offsets in its
// gutter) and a text pane, each a read-only Monaco editor, scrolled together. The `details`
// fixture's commit changes data.bin from "BIN\0\1\2old" to "BIN\0\1\2new!" (fixtures.rs).
const COMMIT = 'Rename guide and update assets';

const fileRow = (page: Page, path: string) => page.getByRole('option').and(page.locator(`[data-path="${path}"]`));
const diff = (page: Page) => page.getByRole('region', { name: 'Diff' });
const pane = (page: Page, side: 'old' | 'new' | 'file', kind: 'hex' | 'text') => diff(page).locator(`.hex-view .hex-side[data-side="${side}"] .hex-pane-${kind}`);
const lines = (l: Locator) => l.locator('.view-lines');
/** A pane's rows, top to bottom (Monaco keeps its line elements in no set order). */
const rows = (l: Locator) => l.locator('.view-line').evaluateAll((els) => els
  .sort((a, b) => parseFloat((a as HTMLElement).style.top) - parseFloat((b as HTMLElement).style.top))
  .map((e) => e.textContent!.replace(/\u00a0/g, ' ')));
/** The text a pane's `cls` decorations cover, top to bottom, joined. */
const marked = (l: Locator, cls: string) => l.locator('.view-line').evaluateAll((els, c) => els
  .sort((a, b) => parseFloat((a as HTMLElement).style.top) - parseFloat((b as HTMLElement).style.top))
  .flatMap((e) => [...e.querySelectorAll(`.${c}`)].map((x) => x.textContent!.replace(/\u00a0/g, ' ')))
  .join(''), cls);
/** Panes that scroll sideways: Monaco shows their horizontal scrollbar, its slider shorter than
 * its track. */
const sideways = (page: Page) => diff(page).locator('.hex-pane').evaluateAll((els) => els.filter((p) => {
  const bar = p.querySelector<HTMLElement>('.scrollbar.horizontal');
  const slider = bar?.querySelector<HTMLElement>('.slider');
  return !bar || !slider || !bar.classList.contains('invisible') || slider.offsetWidth < bar.offsetWidth;
}).length);
/** The room after the last side, in px. */
const leftover = (page: Page) => diff(page).locator('.hex-view').evaluate((v) => v.getBoundingClientRect().right - [...v.querySelectorAll('.hex-side')].at(-1)!.getBoundingClientRect().right);
/** Each pane's vertical scroll position (Monaco moves its lines by -scrollTop). */
const scrollTops = (page: Page) => diff(page).locator('.hex-pane .lines-content').evaluateAll((els) => els.map((e) => -parseFloat((e as HTMLElement).style.top || '0')));

async function open(page: Page, path: string) {
  await fileRow(page, path).click();
  await expect(diff(page).getByTestId('diff-path')).toContainText(path);
}

test.describe('the hex view', () => {
  test('File View: hex | text; a selection in the hex pane is its bytes only, shown in the text pane too', async ({ page }) => {
    await page.goto(openUrl(fixtures.details));
    await page.getByRole('row').filter({ hasText: COMMIT }).click();
    await open(page, 'data.bin');
    await diff(page).getByRole('button', { name: 'File View' }).click();
    const hex = pane(page, 'file', 'hex');
    const text = pane(page, 'file', 'text');
    await expect(lines(hex)).toHaveText('42 49 4e 00 01 02 6e 65  77 21', { timeout: 15_000 });
    await expect(lines(text)).toHaveText('BIN...new!');
    // The offset is the hex pane's gutter; the text pane has none.
    await expect(hex.locator('.line-numbers')).toHaveText('00000000');
    await expect(text.locator('.line-numbers')).toHaveCount(0);
    await expect(diff(page).getByTestId('binary-summary')).toHaveText('Binary · 10 bytes');
    // At 1280×720 a side fits at 16 bytes a row; each pane is as wide as its rows, the room left
    // over after the text pane, and nothing scrolls sideways.
    await expect(diff(page).locator('.hex-view')).toHaveAttribute('data-row-bytes', '16');
    expect(await sideways(page)).toBe(0);
    expect((await text.boundingBox())!.width).toBeLessThan(200);
    expect(await leftover(page)).toBeGreaterThan(100);
    // A drag from the offset gutter across into the text pane: the hex pane's bytes, nothing else.
    const gutter = (await hex.locator('.line-numbers').boundingBox())!;
    const textBox = (await text.boundingBox())!;
    await page.mouse.move(gutter.x + 2, gutter.y + gutter.height / 2);
    await page.mouse.down();
    await page.mouse.move(textBox.x + textBox.width - 20, gutter.y + gutter.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.press('Control+c');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/^42 49 4e 00 01 02 6e 65 {2}77 21\n?$/);
    // …and the same bytes show selected in the text pane.
    await expect.poll(() => marked(text, 'hex-mirror')).toBe('BIN...new!');
    await page.screenshot({ path: '/tmp/ux-k-file.png' });
    // One byte, double-clicked: its character. A click elsewhere clears it.
    const box = (await hex.locator('.view-line > span').first().boundingBox())!;
    const charW = box.width / '42 49 4e 00 01 02 6e 65  77 21'.length;
    await page.mouse.dblclick(box.x + charW * 7, box.y + box.height / 2);
    await expect.poll(() => marked(text, 'hex-mirror')).toBe('N');
    await text.locator('.view-line').first().click();
    await expect(text.locator('.hex-mirror')).toHaveCount(0);
    // And the other way: text selected, its bytes shown in the hex pane.
    await page.keyboard.press('Control+a');
    await expect.poll(() => marked(hex, 'hex-mirror')).toBe('42 49 4e 00 01 02 6e 65  77 21');
  });

  test('Diff View: old and new side by side, the changed bytes coloured in both panes of both sides', async ({ page }) => {
    await page.goto(openUrl(fixtures.details));
    await page.getByRole('row').filter({ hasText: COMMIT }).click();
    await open(page, 'data.bin');
    const d = diff(page);
    await expect(d.getByTestId('binary-summary')).toHaveText('Binary · 9 bytes → 10 bytes');
    // At 1280×720 two sides don't fit at 16 bytes a row: 8, the offsets following.
    await expect(d.locator('.hex-view')).toHaveAttribute('data-row-bytes', '8', { timeout: 15_000 });
    await expect.poll(() => rows(pane(page, 'old', 'hex'))).toEqual(['42 49 4e 00  01 02 6f 6c', '64']);
    await expect.poll(() => rows(pane(page, 'new', 'hex'))).toEqual(['42 49 4e 00  01 02 6e 65', '77 21']);
    await expect.poll(() => rows(pane(page, 'old', 'text'))).toEqual(['BIN...ol', 'd']);
    await expect.poll(() => rows(pane(page, 'new', 'text'))).toEqual(['BIN...ne', 'w!']);
    await expect(pane(page, 'new', 'hex').locator('.line-numbers')).toHaveText(['00000000', '00000008']);
    expect(await sideways(page)).toBe(0);
    expect(await leftover(page)).toBeGreaterThanOrEqual(0);
    // Byte i against byte i: "old" → "new", and "!" past the old side's end.
    await expect.poll(() => marked(pane(page, 'old', 'hex'), 'hex-removed')).toBe('6f 6c64');
    await expect.poll(() => marked(pane(page, 'new', 'hex'), 'hex-inserted')).toBe('6e 657721');
    await expect.poll(() => marked(pane(page, 'old', 'text'), 'hex-removed')).toBe('old');
    await expect.poll(() => marked(pane(page, 'new', 'text'), 'hex-inserted')).toBe('new!');
    for (const kind of ['hex', 'text'] as const) {
      await expect(pane(page, 'old', kind).locator('.hex-row-removed')).toHaveCount(2);
      await expect(pane(page, 'new', kind).locator('.hex-row-inserted')).toHaveCount(2);
    }
    // No diff editor, and no view mode: a binary is always side by side (the Inline button says so).
    await expect(d.getByTestId('text-diff')).toHaveCount(0);
    await expect(d.getByRole('button', { name: 'Inline', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await d.getByRole('button', { name: 'Inline', exact: true }).hover();
    await expect(page.getByText('A binary file always shows side by side')).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(d.getByRole('button', { name: 'Next change' })).toBeEnabled();
    await page.screenshot({ path: '/tmp/ux-k-diff.png' });
    // Wider, both sides fit at 16 bytes a row: laid out again, the colours following.
    await page.setViewportSize({ width: 2000, height: 720 });
    await expect(d.locator('.hex-view')).toHaveAttribute('data-row-bytes', '16');
    await expect.poll(() => rows(pane(page, 'old', 'hex'))).toEqual(['42 49 4e 00 01 02 6f 6c  64']);
    await expect.poll(() => marked(pane(page, 'new', 'hex'), 'hex-inserted')).toBe('6e 65  7721');
    expect(await sideways(page)).toBe(0);
  });

  test('the panes scroll together, row for row, and Next change steps through the changed rows', async ({ page }) => {
    const repo = freshFixture('details');
    // 8 KB (1024 rows of 8 at 1280×720), changed at offsets 0x93 and 0x18f5.
    const bytes = Buffer.from(Array.from({ length: 8192 }, (_, i) => (i * 7) & 0xff));
    writeFileSync(join(repo, 'blob.bin'), bytes);
    git(repo, 'add', 'blob.bin');
    git(repo, 'commit', '-m', 'Add blob');
    bytes[9 * 16 + 3] ^= 0xff;
    bytes[399 * 16 + 5] ^= 0xff;
    writeFileSync(join(repo, 'blob.bin'), bytes);
    git(repo, 'commit', '-am', 'Edit blob');
    await page.goto(openUrl(repo));
    await page.getByRole('row').filter({ hasText: 'Edit blob' }).click();
    await open(page, 'blob.bin');
    const newHex = pane(page, 'new', 'hex');
    await expect(newHex.locator('.line-numbers').first()).toHaveText('00000000', { timeout: 15_000 });
    await expect(pane(page, 'old', 'hex').locator('.hex-removed')).toHaveCount(1);
    const together = async () => {
      const tops = await scrollTops(page);
      return tops.length === 4 && tops.every((t) => t === tops[0]) ? tops[0] : -1;
    };
    // The first change is on the first screen; Next goes to it, then to row 400.
    const d = diff(page);
    await d.getByRole('button', { name: 'Next change' }).click();
    await d.getByRole('button', { name: 'Next change' }).click();
    await expect(newHex.locator('.line-numbers').filter({ hasText: '000018f0' })).toBeVisible();
    await expect(pane(page, 'old', 'text').locator('.hex-removed')).toBeVisible();
    await expect.poll(together).toBeGreaterThan(0);
    // The wheel over any pane moves all four.
    const at = await together();
    const oldText = (await pane(page, 'old', 'text').boundingBox())!;
    await page.mouse.move(oldText.x + oldText.width / 2, oldText.y + oldText.height / 2);
    await page.mouse.wheel(0, -1500);
    await expect.poll(together).toBeLessThan(at);
    await expect.poll(together).toBeGreaterThanOrEqual(0);
    const hexBox = (await newHex.boundingBox())!;
    await page.mouse.move(hexBox.x + hexBox.width / 2, hexBox.y + hexBox.height / 2);
    const before = await together();
    await page.mouse.wheel(0, 1500);
    await expect.poll(together).toBeGreaterThan(before);
    // Back at row 400: its colours are drawn again (only the rows around the viewport are).
    await expect(pane(page, 'old', 'text').locator('.hex-removed')).toBeVisible();
    await expect(pane(page, 'new', 'hex').locator('.hex-inserted')).toBeVisible();
    // Next wraps around to the first change (its row at 0x90).
    await d.getByRole('button', { name: 'Next change' }).click();
    await expect(newHex.locator('.line-numbers').filter({ hasText: '00000090' })).toBeVisible();
    await expect(newHex.locator('.line-numbers').filter({ hasText: '000018f0' })).toHaveCount(0);
    // One vertical scrollbar, the view's, at its far right (the panes have none of their own),
    // with the changes marked on it; scrolled, it moves all four panes.
    const bar = d.locator('.hex-bar');
    await expect(bar).toHaveCount(1);
    const view = (await d.locator('.hex-view').boundingBox())!;
    const barBox = (await bar.boundingBox())!;
    expect(Math.abs(barBox.x + barBox.width - (view.x + view.width))).toBeLessThan(1);
    expect(await d.locator('.hex-pane .scrollbar.vertical').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetWidth > 0).length)).toBe(0);
    await expect(bar.locator('.hex-mark')).toHaveCount(4);
    await bar.locator('.hex-scroller').evaluate((e) => { e.scrollTop = 3000; });
    await expect.poll(together).toBe(3000);
  });
});
