import type { Page } from '@playwright/test';
import { THEME_IDS, THEMES } from '../src/theme/themes';
import { fixtures, openUrl } from './fixtures';
import { expect, test } from './test';

// Themes (spec §12.1, plan 1D Task 2): applying one, switching from the palette and Settings, lane
// overrides; the editor follows the app theme; the screenshot matrix of every theme (Chromium).
test.use({ timezoneId: 'UTC' });

const grid = (page: Page) => page.getByRole('grid', { name: 'Commit graph' });
const theme = (page: Page) => page.locator('html').getAttribute('data-theme');
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
const canvasHash = (page: Page) => page.getByTestId('graph-canvas').first().evaluate((c: HTMLCanvasElement) => {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  let h = 0;
  for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) | 0;
  return h;
});
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Settings' });

test('Default Dark by default', async ({ page }) => {
  await page.goto(openUrl(fixtures.basic));
  await expect(grid(page)).toBeVisible();
  expect(await theme(page)).toBe('default-dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(28, 30, 35)');
});

test("index.html paints the mirrored theme's background and scheme on its own, before the app's module runs (I1)", async ({ page }) => {
  await page.addInitScript((bg) => localStorage.setItem('gitbolt.theme.v1', JSON.stringify({ id: 'light', kind: 'light', bg })), THEMES.light.colors['app-bg0']);
  // No app module at all: only the inline <head> script can have set these.
  await page.route('**/src/main.tsx*', (r) => r.abort());
  await page.goto(openUrl(fixtures.basic));
  const root = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, scheme: document.documentElement.style.colorScheme, bg: document.documentElement.style.getPropertyValue('--app-bg0') }));
  expect(root).toEqual({ theme: 'light', scheme: 'light', bg: THEMES.light.colors['app-bg0'] });
});

test('?theme= applies a theme to the page and the canvas', async ({ page }) => {
  await page.goto(openUrl(fixtures.basic));
  await expect(grid(page)).toBeVisible();
  const dark = await canvasHash(page);
  await page.goto(`${openUrl(fixtures.basic)}&theme=light`);
  await expect(grid(page)).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('body')).toHaveCSS('background-color', rgb(THEMES.light.colors['app-bg0']));
  await expect.poll(() => canvasHash(page)).not.toBe(dark);
});

test('switching theme from the palette repaints the canvas, and the choice survives a reload', async ({ page }) => {
  await page.goto(openUrl(fixtures.basic));
  await expect(grid(page)).toBeVisible();
  const before = await canvasHash(page);
  await page.keyboard.press('Control+P');
  await page.keyboard.type('>Theme: Solarized Light');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'solarized-light');
  await expect(page.locator('body')).toHaveCSS('background-color', rgb(THEMES['solarized-light'].colors['app-bg0']));
  await expect.poll(() => canvasHash(page)).not.toBe(before);
  // Saved (the backend's settings), and mirrored for the first paint (R3).
  await expect.poll(() => page.evaluate(() => localStorage.getItem('gitbolt.theme.v1'))).toBe(JSON.stringify({ id: 'solarized-light', kind: 'light', bg: THEMES['solarized-light'].colors['app-bg0'] }));
  await page.reload();
  await expect(grid(page)).toBeVisible();
  expect(await theme(page)).toBe('solarized-light');
});

test('the hamburger shows one "Theme…" row; it opens Settings on the theme picker, which switches the theme', async ({ page }) => {
  await page.goto(openUrl(fixtures.basic));
  await expect(grid(page)).toBeVisible();
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('menuitem', { name: 'View' }).click();
  await expect(page.getByRole('menuitem', { name: /^Theme: / })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Theme…' }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole('region', { name: 'Appearance' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Theme' }).click();
  await page.getByRole('menuitem', { name: 'Nord' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'nord');
  await expect(dialog(page)).toHaveCSS('background-color', rgb(THEMES.nord.colors['panel-bg1']));
});

test("a lane override recolours that lane's chips and canvas in the current theme only", async ({ page }) => {
  await page.goto(openUrl(fixtures.basic));
  await expect(grid(page)).toBeVisible();
  const chip = page.locator('.ref-labels').first();
  const laneColor = () => chip.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--lane-color'));
  const original = await laneColor();
  const lane = THEMES['default-dark'].graph.indexOf(original);
  expect(lane).toBeGreaterThanOrEqual(0);
  const before = await canvasHash(page);
  await page.keyboard.press('Control+,');
  await dialog(page).getByRole('button', { name: 'Appearance' }).click();
  const box = dialog(page).getByLabel(`Lane ${lane + 1} color`);
  await box.fill('123456');
  await box.press('Enter');
  await expect.poll(laneColor).toBe('#123456');
  await expect.poll(() => canvasHash(page)).not.toBe(before);
  // Another theme keeps its own lanes.
  await dialog(page).getByRole('button', { name: 'Theme' }).click();
  await page.getByRole('menuitem', { name: 'Dracula' }).click();
  await expect.poll(laneColor).toBe(THEMES.dracula.graph[lane]);
  await expect(box).toHaveValue(THEMES.dracula.graph[lane]);
});

const COMMIT = 'Rename guide and update assets';
const diffRegion = (page: Page) => page.getByRole('region', { name: 'Diff' });
const editorBg = (page: Page) => diffRegion(page).locator('.monaco-editor .monaco-editor-background').first().evaluate((e) => getComputedStyle(e).backgroundColor);

async function selectCommit(page: Page) {
  await page.getByRole('row').filter({ hasText: COMMIT }).click();
  await expect(page.getByTestId('file-counts')).toBeVisible();
}
async function openDiff(page: Page) {
  await selectCommit(page);
  await page.getByRole('option').and(page.locator('[data-path="src/app.php"]')).click();
  await expect(diffRegion(page).locator('.editor.modified .line-insert').first()).toBeVisible({ timeout: 15_000 });
}

test("switching theme repaints the open editor in the new theme's background, without re-creating it (R6)", async ({ page }) => {
  await page.goto(openUrl(fixtures.details));
  await openDiff(page);
  const host = diffRegion(page).locator('.monaco-host').first();
  await host.evaluate((el) => { (el as HTMLElement).dataset.keep = '1'; });
  await expect.poll(() => editorBg(page)).toBe(rgb(THEMES['default-dark'].colors['app-bg0'])); // today's #1c1e23
  await page.keyboard.press('Control+P');
  await page.keyboard.type('>Theme: Darcula');
  await page.keyboard.press('Enter');
  await expect.poll(() => editorBg(page)).toBe(rgb(THEMES.darcula.colors['app-bg0']));
  await page.keyboard.press('Control+P');
  await page.keyboard.type('>Theme: Solarized Light');
  await page.keyboard.press('Enter');
  await expect.poll(() => editorBg(page)).toBe(rgb(THEMES['solarized-light'].colors['app-bg0']));
  await expect(host).toHaveAttribute('data-keep', '1');
});

test('the editor font size row (Settings > Editor) resizes the open diff live, clamped to 8-32', async ({ page }) => {
  await page.goto(openUrl(fixtures.details));
  await openDiff(page);
  const size = () => diffRegion(page).locator('.view-line').first().evaluate((e) => getComputedStyle(e).fontSize);
  await expect.poll(size).toBe('13px');
  await page.keyboard.press('Control+,');
  await dialog(page).getByRole('button', { name: 'Editor' }).click();
  const box = dialog(page).getByLabel('Editor font size');
  await box.fill('18');
  await box.press('Enter');
  await expect.poll(size).toBe('18px');
  await box.fill('99');
  await box.press('Enter');
  await expect(box).toHaveValue('32');
  await expect.poll(size).toBe('32px');
});

test.describe('theme screenshots', () => {
  // Pixel baselines: opt-in (`just e2e-shots`), recorded on one machine; fonts and antialiasing
  // elsewhere would fail the gate (W2-A review).
  test.skip(!process.env.GITBOLT_E2E_SHOTS, 'pixel baselines run with GITBOLT_E2E_SHOTS=1 (just e2e-shots)');
  test.skip(({ browserName }) => browserName !== 'chromium', 'screenshot baselines are Chromium-only');
  for (const id of THEME_IDS) {
    test(`${id}: graph, details, split diff`, async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.goto(`${openUrl(fixtures.details)}&theme=${id}`);
      await expect(grid(page)).toBeVisible();
      const shot = { mask: [page.locator('img')], maxDiffPixelRatio: 0.01 }; // avatars may load differently between runs
      await selectCommit(page);
      await expect(page.locator('.graph-panel')).toHaveScreenshot(`graph-${id}.png`, shot);
      await expect(page.locator('.right-panel')).toHaveScreenshot(`details-${id}.png`, shot);
      await page.getByRole('option').and(page.locator('[data-path="src/app.php"]')).click();
      await expect(diffRegion(page).locator('.editor.modified .line-insert').first()).toBeVisible({ timeout: 15_000 });
      await diffRegion(page).getByRole('button', { name: 'Split' }).click();
      await expect.poll(() => editorBg(page)).toBe(rgb(THEMES[id].colors['app-bg0']));
      await expect(diffRegion(page)).toHaveScreenshot(`diff-split-${id}.png`, shot);
    });
  }
});
