import { expect, test } from '@playwright/test';
import { fixtures, openUrl } from './fixtures';

// App zoom (spec §12.2). The browser harness has no Tauri webview to zoom, so `setZoom` is a no-op
// here; `html[data-zoom]` is the step the app would apply. Each test starts at the default: the
// saved step is cleared on the test's first page load only, so a reload keeps it.
const ZOOM_KEY = 'gitbolt.zoom.v1';
const zoom = (page: import('@playwright/test').Page) => page.evaluate(() => document.documentElement.dataset.zoom);

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    if (sessionStorage.getItem('zoom-cleared')) return;
    localStorage.removeItem(key);
    sessionStorage.setItem('zoom-cleared', '1');
  }, ZOOM_KEY);
  await page.goto(openUrl(fixtures.basic));
  await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
});

test('Ctrl+= / Ctrl++ zoom in, Ctrl+- zooms out, Ctrl+0 resets; the step survives a reload', async ({ page }) => {
  expect(await zoom(page)).toBe('100');
  await page.keyboard.press('Control+Equal');
  expect(await zoom(page)).toBe('110');
  await page.keyboard.press('Control+Shift+Equal');
  expect(await zoom(page)).toBe('120');
  await page.keyboard.press('Control+Minus');
  expect(await zoom(page)).toBe('110');
  await page.reload();
  await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
  expect(await zoom(page)).toBe('110');
  await page.keyboard.press('Control+Digit0');
  expect(await zoom(page)).toBe('100');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Control+Minus');
  expect(await zoom(page)).toBe('80');
});

test('Ctrl+wheel is cancelled, so the webview never zooms itself', async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as { wheels: boolean[] }).wheels = [];
    window.addEventListener('wheel', (e) => (window as unknown as { wheels: boolean[] }).wheels.push(e.defaultPrevented));
  });
  await page.mouse.move(200, 200);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await expect.poll(() => page.evaluate(() => (window as unknown as { wheels: boolean[] }).wheels)).toEqual([true]);
});
