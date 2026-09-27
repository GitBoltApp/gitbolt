import { expect, test, type Page } from '@playwright/test';
import { fixtures, openUrl } from './fixtures';

// The `details` fixture's "Rename guide and update assets" commit changes logo.png from a 4×4 red
// PNG to a 6×4 blue one, and icon.svg from a rect to a circle (fixtures.rs).
const COMMIT = 'Rename guide and update assets';

const fileRow = (page: Page, path: string) => page.getByRole('option').and(page.locator(`[data-path="${path}"]`));
const diff = (page: Page) => page.getByRole('region', { name: 'Diff' });
const modeButton = (page: Page, name: string) => diff(page).getByRole('toolbar', { name: 'Image diff options' }).getByRole('button', { name, exact: true });

async function open(page: Page, path: string) {
  await fileRow(page, path).click();
  await expect(diff(page).getByTestId('diff-path')).toContainText(path);
  // Both sides decoded: the dimensions are known, and the view is fitted to them.
  await expect(diff(page).getByTestId('image-dims')).not.toContainText('…');
}

/** Home, then `n` steps right on the Zoom slider (Fit, 25, 50, 100, 200, 400, …). */
async function zoomTo(page: Page, n: number) {
  await diff(page).getByRole('slider', { name: 'Zoom' }).focus();
  await page.keyboard.press('Home');
  for (let i = 0; i < n; i++) await page.keyboard.press('ArrowRight');
}

test.describe('image diff', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(openUrl(fixtures.details));
    await page.getByRole('row').filter({ hasText: COMMIT }).click();
    await expect(page.getByTestId('file-counts')).toBeVisible();
  });

  test('side-by-side shows both images with their sizes; zoom is stepped and pixelated above 100%', async ({ page }) => {
    await open(page, 'logo.png');
    const d = diff(page);
    await expect(d.getByTestId('image-dims')).toHaveText('4×4 → 6×4');
    await expect(d.getByTestId('image-size')).toHaveText(/^\d+ B → \d+ B$/);
    await expect(d.getByTestId('binary-summary')).toHaveCount(0);
    await expect(d.locator('img.image-layer')).toHaveCount(2);
    // An image diff isn't a text diff: nothing to step through.
    await expect(d.getByRole('button', { name: 'Next change' })).toBeDisabled();
    await zoomTo(page, 3);
    await expect(d.getByTestId('zoom-label')).toHaveText('100%');
    await expect(d.locator('img.image-layer').first()).toHaveCSS('image-rendering', 'auto');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(d.getByTestId('zoom-label')).toHaveText('400%');
    await expect(d.locator('img.image-layer').first()).toHaveCSS('image-rendering', 'pixelated');
  });

  test('Ctrl+scroll zooms around the cursor', async ({ page }) => {
    await open(page, 'logo.png');
    const d = diff(page);
    // Fit is 1000% for these tiny images (fitScale is capped at 10), so one notch out is 800%.
    await expect(d.getByTestId('zoom-label')).toHaveText('Fit');
    const vp = d.locator('.image-viewport').first();
    const box = (await vp.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    /** The image pixel under the viewport's centre, from the layer's on-screen box. */
    const pixelUnderCursor = async () => {
      const r = (await d.locator('img.image-layer').first().boundingBox())!;
      return { x: ((cx - r.x) / r.width) * 4, y: ((cy - r.y) / r.height) * 4 };
    };
    const before = await pixelUnderCursor();
    await page.mouse.move(cx, cy);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 100);
    await page.keyboard.up('Control');
    await expect(d.getByTestId('zoom-label')).toHaveText('800%');
    const after = await pixelUnderCursor();
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
  });

  test('swipe, onion skin and difference modes', async ({ page }) => {
    await open(page, 'logo.png');
    const d = diff(page);
    await modeButton(page, 'Swipe').click();
    await expect(modeButton(page, 'Swipe')).toHaveAttribute('aria-pressed', 'true');
    const divider = d.getByRole('slider', { name: 'Swipe position' });
    await divider.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(divider).toHaveAttribute('aria-valuenow', '45');
    // ← on the divider moves it; it doesn't send the focus back to the file list.
    await expect(divider).toBeFocused();
    await modeButton(page, 'Onion skin').click();
    await expect(d.getByRole('slider', { name: 'Opacity' })).toBeVisible();
    await expect(d.locator('img.image-layer')).toHaveCount(2);
    await modeButton(page, 'Difference').click();
    const canvas = d.getByTestId('image-difference');
    await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => {
      const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 0) lit++;
      return lit;
    })).toBeGreaterThan(0);
  });

  test('zoom and pan stay linked across modes', async ({ page }) => {
    await open(page, 'logo.png');
    const d = diff(page);
    await zoomTo(page, 5);
    await expect(d.getByTestId('zoom-label')).toHaveText('400%');
    const scale = () => d.locator('.image-layer').first().evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
    await expect.poll(scale).toBe(4);
    for (const mode of ['Swipe', 'Onion skin', 'Difference', 'Side-by-side']) {
      await modeButton(page, mode).click();
      await expect(modeButton(page, mode)).toHaveAttribute('aria-pressed', 'true');
      await expect(d.getByTestId('zoom-label')).toHaveText('400%');
      await expect(d.getByRole('slider', { name: 'Zoom' })).toHaveAttribute('aria-valuetext', '400%');
      await expect.poll(scale).toBe(4);
    }
  });

  test("the image stage's context menu is suppressed", async ({ page }) => {
    await open(page, 'logo.png');
    await page.evaluate(() => {
      window.addEventListener('contextmenu', (e) => { (window as unknown as { menuPrevented: boolean }).menuPrevented = e.defaultPrevented; });
    });
    await diff(page).locator('.image-viewport').first().click({ button: 'right' });
    await expect.poll(() => page.evaluate(() => (window as unknown as { menuPrevented?: boolean }).menuPrevented)).toBe(true);
  });

  test('an SVG shows as images, with a Source toggle for the text diff', async ({ page }) => {
    await open(page, 'icon.svg');
    const d = diff(page);
    await expect(d.getByTestId('image-dims')).toHaveText('16×16 → 16×16');
    await expect(d.locator('img.image-layer')).toHaveCount(2);
    await expect(d.locator('.monaco-diff-editor')).toHaveCount(0);
    await d.getByRole('button', { name: 'Source', exact: true }).click();
    await expect(d.locator('.monaco-diff-editor')).toBeVisible();
    await expect(d.getByTestId('text-diff')).toContainText('circle');
    // Still an image diff: Previous/Next change stay off.
    await expect(d.getByRole('button', { name: 'Next change' })).toBeDisabled();
  });
});
