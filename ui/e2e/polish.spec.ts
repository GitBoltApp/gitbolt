import { expect, test, type Page } from './test';
import { fixtures, openUrl } from './fixtures';

// Global polish (user feedback F22, F31): one text-selection colour, Ctrl+C outside the editor,
// and slim scrollbars (no arrow buttons, no track, a grey thumb), the editor's included.
const COMMIT = 'Rename guide and update assets';
const SELECTION_BG = 'rgb(38, 79, 120)'; // --selection-bg, #264f78: Monaco's own selection blue
const THUMB = 'rgba(255, 255, 255, 0.15)'; // --scroll-thumb-bg

const diff = (page: Page) => page.getByRole('region', { name: 'Diff' });

// Playwright's headless Chromium hides every scrollbar (`--hide-scrollbars`), styled ones too.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

async function openAppPhp(page: Page) {
  await page.goto(openUrl(fixtures.details));
  await page.getByRole('row').filter({ hasText: COMMIT }).click();
  await page.getByRole('option').and(page.locator('[data-path="src/app.php"]')).click();
  await expect(diff(page).locator('.editor.modified .line-insert').first()).toBeVisible({ timeout: 15_000 });
}

/** Drags across `el`'s text, as a person selects it. */
async function dragSelect(page: Page, el: import('@playwright/test').Locator) {
  const box = (await el.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
}

test('the diff header filename selects in the one selection colour, and Ctrl+C copies it', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions are granted on Chromium only');
  await openAppPhp(page);
  const name = diff(page).getByTestId('diff-path').locator('strong');
  await dragSelect(page, name);
  await expect.poll(() => page.evaluate(() => String(getSelection()))).toBe('app.php');
  expect(await name.evaluate((el) => getComputedStyle(el, '::selection').backgroundColor)).toBe(SELECTION_BG);
  // The details panel's text (the commit message) uses the same colour.
  expect(await page.getByTestId('details-sha').evaluate((el) => getComputedStyle(el, '::selection').backgroundColor)).toBe(SELECTION_BG);
  await page.evaluate(() => {
    (window as unknown as { copyKeys: boolean[] }).copyKeys = [];
    window.addEventListener('keydown', (e) => { if (e.key === 'c') (window as unknown as { copyKeys: boolean[] }).copyKeys.push(e.defaultPrevented); });
    return navigator.clipboard.writeText('before');
  });
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('app.php');
  // Left to the browser's own copy (H19): the same path as right-click -> Copy, which works in the
  // real window. The app doesn't take the key and route it through the Tauri clipboard plugin.
  expect(await page.evaluate(() => (window as unknown as { copyKeys: boolean[] }).copyKeys)).toEqual([false]);
});

test('Ctrl+C in the editor copies its selection, Ctrl+A then Ctrl+C the whole side (H19)', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions are granted on Chromium only');
  await openAppPhp(page);
  await page.evaluate(() => navigator.clipboard.writeText('before'));
  const word = diff(page).locator('.editor.modified .view-line').filter({ hasText: 'function' }).first().getByText('function', { exact: true }).first();
  await word.dblclick();
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('function');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('<?php');
});

test('scrollbars are slim with a grey thumb only, in the app and in the editor (square and flush there)', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', "WebKit's GTK port draws overlay scrollbars of its own");
  await page.goto(openUrl(fixtures.longHistory));
  const grid = page.getByRole('grid', { name: 'Commit graph' });
  await expect(grid).toBeVisible();
  // The native scrollbar's width: 10 px (Chromium's classic one is 15), with no arrow buttons.
  await expect.poll(() => grid.evaluate((el) => (el as HTMLElement).offsetWidth - (el as HTMLElement).clientWidth)).toBe(10);

  await openAppPhp(page);
  const bar = diff(page).locator('.editor.modified .monaco-scrollable-element > .scrollbar.vertical').first();
  expect(await bar.evaluate((el) => el.getBoundingClientRect().width)).toBe(10);
  expect(await bar.locator('.slider').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(THUMB);
  // Square-ended and flush in its lane (H18, 20.png), so it lines up with the minimap beside it.
  const slider = bar.locator('.slider');
  expect(await slider.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('0px');
  const [b, s] = [await bar.boundingBox(), await slider.boundingBox()];
  expect(s!.x).toBe(b!.x);
  expect(s!.width).toBe(b!.width);
  expect(await slider.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe('0px');
});
