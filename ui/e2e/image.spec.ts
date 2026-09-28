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

/** Home, then `n` steps right on the Zoom slider (Fit, 10, 25, 33, 50, 67, 75, 90, 100, 110, 125,
 * 150, 175, 200, 250, 300, 400, …: H24's fine ladder). */
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

  test('side-by-side shows both images with their sizes, at 100%; zoom steps finely and is pixelated above 100%', async ({ page }) => {
    await open(page, 'logo.png');
    const d = diff(page);
    await expect(d.getByTestId('image-dims')).toHaveText('4×4 → 6×4');
    await expect(d.getByTestId('image-size')).toHaveText(/^\d+ B → \d+ B$/);
    await expect(d.getByTestId('binary-summary')).toHaveCount(0);
    await expect(d.locator('img.image-layer')).toHaveCount(2);
    // An image diff isn't a text diff: none of the text-diff controls (H26).
    for (const name of ['Next change', 'Previous change', 'Hunk', 'Inline', 'Split', 'Ignore whitespace', 'Word wrap']) await expect(d.getByRole('button', { name, exact: true })).toHaveCount(0);
    // Opens at 100% (H23), not Fit.
    await expect(d.getByTestId('zoom-label')).toHaveText('100%');
    await expect(d.locator('img.image-layer').first()).toHaveCSS('image-rendering', 'auto');
    await d.getByRole('slider', { name: 'Zoom' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(d.getByTestId('zoom-label')).toHaveText('110%');
    await expect(d.locator('img.image-layer').first()).toHaveCSS('image-rendering', 'pixelated');
    await zoomTo(page, 0);
    await expect(d.getByTestId('zoom-label')).toHaveText('Fit');
  });

  test('Ctrl+scroll zooms around the cursor', async ({ page }) => {
    await open(page, 'logo.png');
    const d = diff(page);
    // It opens at 100%, so one notch out is the next rung down, 90% (H24).
    await expect(d.getByTestId('zoom-label')).toHaveText('100%');
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
    await expect(d.getByTestId('zoom-label')).toHaveText('90%');
    const after = await pixelUnderCursor();
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
  });

  test('swipe, onion skin and difference modes', async ({ page }) => {
    await open(page, 'logo.png');
    const d = diff(page);
    // 1000%: the image is wide enough on screen for the handle to travel (it stays inside it, H28).
    await zoomTo(page, 20);
    await modeButton(page, 'Swipe').click();
    await expect(modeButton(page, 'Swipe')).toHaveAttribute('aria-pressed', 'true');
    const divider = d.getByRole('slider', { name: 'Swipe position' });
    await divider.focus();
    const at = async () => Number(await divider.getAttribute('aria-valuenow'));
    const start = await at();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(at).toBeLessThan(start);
    // ← on the divider moves it; it doesn't send the focus back to the file list.
    await expect(divider).toBeFocused();
    await modeButton(page, 'Onion skin').click();
    const opacity = d.getByRole('slider', { name: 'Opacity' });
    await expect(opacity).toBeVisible();
    await expect(opacity).toHaveValue('50');
    await opacity.fill('20');
    // Each mode starts over at 50% when entered again (H28, H29).
    await modeButton(page, 'Swipe').click();
    await expect(divider).toHaveAttribute('aria-valuenow', '50');
    await modeButton(page, 'Onion skin').click();
    await expect(opacity).toHaveValue('50');
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
    await zoomTo(page, 16);
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
    // The source is a text diff: its controls are back (H26).
    for (const name of ['Hunk', 'Inline', 'Split', 'Ignore whitespace', 'Word wrap']) await expect(d.getByRole('button', { name, exact: true })).toBeEnabled();
    await expect(d.getByRole('button', { name: 'Next change' })).toBeEnabled();
    await d.getByRole('button', { name: 'Source', exact: true }).click();
    await expect(d.getByRole('button', { name: 'Hunk', exact: true })).toHaveCount(0);
  });

  test('a drag pans only an image larger than the viewport; one that fits stays put (H27)', async ({ page }) => {
    await open(page, 'logo.png');
    const d = diff(page);
    const layer = d.locator('img.image-layer').first();
    const transform = () => layer.evaluate((el) => getComputedStyle(el).transform);
    const vp = (await d.locator('.image-viewport').first().boundingBox())!;
    const drag = async (dx: number, dy: number) => {
      await page.mouse.move(vp.x + 20, vp.y + 20);
      await page.mouse.down();
      await page.mouse.move(vp.x + 20 + dx, vp.y + 20 + dy, { steps: 5 });
      await page.mouse.up();
    };
    for (const n of [8, 20]) {
      // 100% and 1000%: the 4×4 image fits either way.
      await zoomTo(page, n);
      const before = await transform();
      await drag(120, 80);
      expect(await transform()).toBe(before);
    }
  });

  test('the swipe handle stays inside the visible image at the far right, and grabbing it never pans (H27, H28)', async ({ page }) => {
    await open(page, 'logo.png');
    const d = diff(page);
    await zoomTo(page, 20); // 1000%: the 6×4 image is 60×40 px on screen
    await modeButton(page, 'Swipe').click();
    const divider = d.getByRole('slider', { name: 'Swipe position' });
    const layerBox = async () => (await d.locator('.swipe-clip img.image-layer').boundingBox())!;
    const transform = () => d.locator('img.image-layer').first().evaluate((el) => getComputedStyle(el).transform);
    const before = await transform();
    const vp = (await d.locator('.image-viewport').boundingBox())!;
    const h = (await divider.boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(vp.x + vp.width + 50, h.y + h.height / 2, { steps: 8 });
    await page.mouse.up();
    const img = await layerBox();
    const end = (await divider.boundingBox())!;
    expect(end.x + end.width / 2).toBeLessThanOrEqual(img.x + img.width - 11);
    expect(end.x + end.width).toBeLessThanOrEqual(vp.x + vp.width);
    expect(await transform()).toBe(before);
    // Re-entering Swipe puts it back in the middle.
    await modeButton(page, 'Side-by-side').click();
    await modeButton(page, 'Swipe').click();
    await expect(divider).toHaveAttribute('aria-valuenow', '50');
  });

  test('background toggles: checkerboard by default, then black, white or grey, remembered after a reload (H30)', async ({ page }) => {
    await open(page, 'logo.png');
    const d = diff(page);
    const bg = () => d.locator('.image-viewport').first().evaluate((el) => getComputedStyle(el).backgroundColor);
    await expect(d.getByRole('button', { name: 'Checkerboard background' })).toHaveAttribute('aria-pressed', 'true');
    for (const [name, color] of [['Black background', 'rgb(0, 0, 0)'], ['White background', 'rgb(255, 255, 255)'], ['Grey background', 'rgb(128, 128, 128)']]) {
      await d.getByRole('button', { name }).click();
      await expect(d.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(bg).toBe(color);
    }
    await d.getByRole('button', { name: 'White background' }).hover();
    await expect(page.getByRole('tooltip')).toHaveText('White background');
    await d.getByRole('button', { name: 'White background' }).click();
    await page.reload();
    await page.getByRole('row').filter({ hasText: COMMIT }).click();
    await open(page, 'logo.png');
    await expect(diff(page).getByRole('button', { name: 'White background' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(bg).toBe('rgb(255, 255, 255)');
  });
});
