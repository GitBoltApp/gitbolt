import { expect, test } from './test';
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

// Acceptance at 100/150/200% (spec 12.2 / 17.2). Browser zoom Z shrinks the CSS viewport by Z and
// raises devicePixelRatio to Z, which is the state the CEF app has at that step.
test.describe('zoom acceptance screenshots', () => {
  test.skip(!process.env.GITBOLT_E2E_SHOTS, 'pixel baselines run with GITBOLT_E2E_SHOTS=1 (just e2e-shots)');
  test.skip(({ browserName }) => browserName !== 'chromium', 'device-scale emulation baselines are Chromium-only');
  for (const z of [1, 1.5, 2]) {
    test.describe(`zoom ${z * 100}%`, () => {
      test.use({ viewport: { width: Math.round(1600 / z), height: Math.round(900 / z) }, deviceScaleFactor: z, timezoneId: 'UTC' });

      test('no clipping, no overlap, crisp canvas', async ({ page }) => {
        await page.goto(`${openUrl(fixtures.basic)}&theme=default-dark`);
        await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
        expect(await page.evaluate(() => devicePixelRatio)).toBe(z);

        const canvas = await page.getByTestId('graph-canvas').first().evaluate((c: HTMLCanvasElement) => ({ w: c.width, h: c.height, cssW: c.getBoundingClientRect().width, cssH: c.getBoundingClientRect().height }));
        expect(canvas.w).toBe(Math.round(canvas.cssW * z));
        expect(canvas.h).toBe(Math.round(canvas.cssH * z));

        const clipped = await page.getByRole('gridcell').evaluateAll((cells) => cells.filter((c) => c.scrollHeight > c.clientHeight + 1).length);
        expect(clipped).toBe(0);

        const overlaps = await page.locator('.graph-header-inner > span').evaluateAll((spans) => {
          const r = spans.map((s) => s.getBoundingClientRect()).filter((b) => b.width > 0);
          return r.slice(1).filter((b, i) => b.left < r[i].right - 0.5).length;
        });
        expect(overlaps).toBe(0);

        await expect(page.locator('.graph-panel')).toHaveScreenshot(`graph-zoom-${z * 100}.png`, { mask: [page.locator('img')], maxDiffPixelRatio: 0.01 });
      });
    });
  }
});
