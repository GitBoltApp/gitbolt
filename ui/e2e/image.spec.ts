import { expect, test, type Page } from './test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtures, freshFixture, git, harnessHttp, openUrl } from './fixtures';
import { rgbPng } from './perfRepo';

/** A generated stand-in for a screenshot (never a real one): a title band, a sidebar, a gradient,
 * grid lines and a disc, drawn in 0–1 coordinates so every size is the same picture. */
function resizablePng(w: number, h: number): Buffer {
  return rgbPng(w, h, (x, y) => {
    const u = (x + 0.5) / w;
    const v = (y + 0.5) / h;
    if (v < 0.1) return [40, 44, 52];
    if (u < 0.2) return [58, 64, 76];
    if (Math.hypot((u - 0.62) * w, (v - 0.55) * h) < 0.25 * h) return [242, 93, 46];
    if ((u * 16) % 1 < 0.05 || (v * 10) % 1 < 0.05) return [230, 230, 230];
    return [30 + 120 * u, 80 + 100 * v, 160];
  });
}

// The `details` fixture's "Rename guide and update assets" commit changes logo.png from a 4×4 red
// PNG to a 6×4 blue one, and icon.svg from a rect to a circle (fixtures.rs).
const COMMIT = 'Rename guide and update assets';

const fileRow = (page: Page, path: string) => page.getByRole('option').and(page.locator(`[data-path="${path}"]`));
const diff = (page: Page) => page.getByRole('region', { name: 'Diff' });
const modeButton = (page: Page, name: string) => diff(page).getByRole('toolbar', { name: 'Image diff options' }).getByRole('button', { name, exact: true });
const fitButton = (page: Page) => diff(page).getByRole('button', { name: 'Fit', exact: true });

async function open(page: Page, path: string) {
  await fileRow(page, path).click();
  await expect(diff(page).getByTestId('diff-path')).toContainText(path);
  // Both sides decoded: the dimensions are known, and the view is fitted to them.
  await expect(diff(page).getByTestId('image-dims')).not.toContainText('…');
}

/** Home, then `n` steps right on the Zoom slider (10, 25, 33, 50, 67, 75, 90, 100, 110, 125, 150,
 * 175, 200, 250, 300, 400, …: H24's fine ladder). K12: the slider's minimum is this ladder's own
 * first rung — Fit is the separate `fitButton` below. */
async function zoomTo(page: Page, n: number) {
  await diff(page).getByRole('slider', { name: 'Zoom' }).focus();
  await page.keyboard.press('Home');
  for (let i = 0; i < n; i++) await page.keyboard.press('ArrowRight');
}

/** One painted image layer or frame: its source (the frame's is its image's) and on-screen box. */
interface Placed { key: string; x: number; y: number; w: number; h: number; vx: number; vy: number; vw: number; vh: number }

/** Samples every visible image layer and frame in each animation frame, and in a task right
 * after it (the round-1 no-flicker tests' pattern, diff.spec.ts): what each paint can show. */
async function sampleImages(page: Page): Promise<() => Promise<Placed[][]>> {
  await page.evaluate(() => {
    const w = window as unknown as { imgSamples: unknown[][]; stopImgSampling: boolean };
    w.imgSamples = [];
    w.stopImgSampling = false;
    const sample = () => {
      const els = [...document.querySelectorAll<HTMLElement>('.diff-panel img.image-layer, .diff-panel .image-frame')];
      w.imgSamples.push(els.filter((el) => getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0).map((el) => {
        const img = el.matches('img') ? el : el.parentElement!.querySelector('img.image-layer');
        const r = el.getBoundingClientRect();
        const v = el.closest('.image-viewport')!.getBoundingClientRect();
        return { key: `${el.matches('img') ? 'img' : 'frame'}:${(img as HTMLImageElement | null)?.src ?? ''}`, x: r.x, y: r.y, w: r.width, h: r.height, vx: v.x, vy: v.y, vw: v.width, vh: v.height };
      }));
    };
    const channel = new MessageChannel();
    channel.port1.onmessage = sample;
    const loop = () => {
      sample();
      channel.port2.postMessage(null);
      if (!w.stopImgSampling) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  return async () => {
    await page.evaluate(() => new Promise((r) => { let n = 5; const f = () => (--n ? requestAnimationFrame(f) : r(null)); requestAnimationFrame(f); }));
    return page.evaluate(() => {
      const w = window as unknown as { imgSamples: Placed[][]; stopImgSampling: boolean };
      w.stopImgSampling = true;
      return w.imgSamples;
    });
  };
}

test.describe('image diff', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(openUrl(fixtures.details));
    await page.getByRole('row').filter({ hasText: COMMIT }).click();
    await expect(page.getByTestId('file-counts')).toBeVisible();
  });

  /** A new presentation of logo.png (its own zoom, mode and pan): another image in between. */
  const fresh = async (page: Page) => {
    await open(page, 'icon.svg');
    await open(page, 'logo.png');
  };

  // Each `test.step` below was a test of its own, paying for a page load and the images' decoding;
  // they run in an order where each starts from what it needs (`fresh` where that's a new
  // presentation: 100%, side by side).
  test('logo.png: sizes and the zoom ladder, Fit, the % input, Ctrl+scroll; Open in…; the image menu copies the new image and replaces the native one', async ({ page, request, browserName }) => {
    await test.step('side-by-side shows both images with their sizes, at 100%; zoom steps finely and is pixelated above 100%', async () => {
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
      // K12: Home lands on the ladder's own minimum (10%), not Fit.
      await zoomTo(page, 0);
      await expect(d.getByTestId('zoom-label')).toHaveText('10%');
    });
    await test.step("K11: the · separator has breathing room, and the meta block sits well clear of the zoom slider", async () => {
      const d = diff(page);
      const [zoomBox, dimsBox, sepBox, sizeBox] = await Promise.all([
        d.locator('.image-zoom').boundingBox(),
        d.getByTestId('image-dims').boundingBox(),
        d.locator('.meta-sep').boundingBox(),
        d.getByTestId('image-size').boundingBox(),
      ]);
      // A visible gap between the zoom slider group and the meta block, well past the toolbar's own
      // 10px item gap.
      expect(dimsBox!.x - (zoomBox!.x + zoomBox!.width)).toBeGreaterThan(10);
      // Real breathing room either side of the "·" itself.
      expect(sepBox!.x - (dimsBox!.x + dimsBox!.width)).toBeGreaterThan(2);
      expect(sizeBox!.x - (sepBox!.x + sepBox!.width)).toBeGreaterThan(2);
    });
    await test.step('K12: Fit sets the exact % that fits the image, and tracks a resize; K14: double-click the slider resets to 100%', async () => {
      const d = diff(page);
      const slider = d.getByRole('slider', { name: 'Zoom' });
      const vp = (await d.locator('.image-viewport').first().boundingBox())!;
      // The zoom ladder caps scale at 10×, same as `fitScale` (zoom.ts): the 4×4 logo's own fit is
      // well past that in this viewport, so Fit lands on the 10× cap, not a viewport-filling size.
      const expectedScale = Math.min(10, vp.width / 4, vp.height / 4);
      await zoomTo(page, 15); // 400%, away from both Fit's and 100%'s value
      await expect(d.getByTestId('zoom-label')).toHaveText('400%');
      await fitButton(page).click();
      await expect(fitButton(page)).toHaveAttribute('aria-pressed', 'true');
      await expect(d.getByTestId('zoom-label')).toHaveText(`${Math.round(expectedScale * 100)}%`);
      const layer = (await d.locator('img.image-layer').first().boundingBox())!;
      expect(Math.abs(layer.width - 4 * expectedScale)).toBeLessThanOrEqual(1);
      // Any other zoom action drops Fit mode (K12).
      await slider.focus();
      await page.keyboard.press('ArrowLeft');
      await expect(fitButton(page)).toHaveAttribute('aria-pressed', 'false');
      // K14: double-click the slider resets to exactly 100%, also leaving Fit.
      await fitButton(page).click();
      await expect(fitButton(page)).toHaveAttribute('aria-pressed', 'true');
      await slider.dblclick();
      await expect(d.getByTestId('zoom-label')).toHaveText('100%');
      await expect(fitButton(page)).toHaveAttribute('aria-pressed', 'false');
    });
    await test.step('K13: clicking the zoom % edits it as a number — Enter applies, Esc cancels without closing the file, blur applies', async () => {
      const d = diff(page);
      await zoomTo(page, 15); // 400%
      await expect(d.getByTestId('zoom-label')).toHaveText('400%');
      await d.getByTestId('zoom-label').click();
      const input = d.getByTestId('zoom-input');
      await expect(input).toBeFocused();
      await expect(input).toHaveValue('400');
      await input.fill('250');
      await page.keyboard.press('Enter');
      await expect(d.getByTestId('zoom-input')).toHaveCount(0);
      await expect(d.getByTestId('zoom-label')).toHaveText('250%');
      // Clamped to the zoom range.
      await d.getByTestId('zoom-label').click();
      await d.getByTestId('zoom-input').fill('99999');
      await page.keyboard.press('Enter');
      await expect(d.getByTestId('zoom-label')).toHaveText('1000%');
      // Esc cancels the edit and does NOT close the file (the input owns Esc while editing).
      await d.getByTestId('zoom-label').click();
      await d.getByTestId('zoom-input').fill('12');
      await page.keyboard.press('Escape');
      await expect(d.getByTestId('zoom-input')).toHaveCount(0);
      await expect(d.getByTestId('zoom-label')).toHaveText('1000%');
      await expect(d.getByTestId('diff-path')).toBeVisible(); // still open
      // Blur applies.
      await d.getByTestId('zoom-label').click();
      await d.getByTestId('zoom-input').fill('50');
      await d.getByTestId('zoom-input').blur();
      await expect(d.getByTestId('zoom-label')).toHaveText('50%');
    });
    await test.step("Open in… sits at the far left of an image's toolbar, and opens the image (J1)", async () => {
      const launches = async () => (await (await request.get(`${harnessHttp}/launches`)).json()) as { program: string; args: string[] }[];
      const before = (await launches()).length;
      const bar = diff(page).getByRole('toolbar', { name: 'Diff options', exact: true });
      const group = bar.getByRole('group', { name: 'Open in' });
      await expect(group).toBeVisible();
      const [b, g, views] = await Promise.all([bar.boundingBox(), group.boundingBox(), bar.getByRole('button', { name: 'File View' }).boundingBox()]);
      expect(g!.x - b!.x).toBeLessThanOrEqual(9);
      expect(g!.x + g!.width).toBeLessThan(views!.x);
      await group.getByRole('button', { name: /^Open in / }).click();
      await expect.poll(async () => (await launches()).length).toBe(before + 1);
      expect((await launches()).at(-1)!.args.join(' ')).toContain('logo.png');
    });
    // Clipboard reads are granted on Chromium only.
    if (browserName === 'chromium') {
      await test.step('K98: right-clicking the new pane and choosing Copy New Image puts its PNG on the clipboard', async () => {
        await diff(page).locator('.image-viewport').nth(1).click({ button: 'right' });
        const items = page.getByRole('menuitem');
        await expect(items).toHaveText([/Copy New Image/, /Copy Old Image/]);
        await items.first().click();
        await expect(page.getByRole('status').filter({ hasText: 'Image copied' })).toBeVisible();
        // The new logo.png is 6×4.
        const size = await page.evaluate(async () => {
          const item = (await navigator.clipboard.read())[0];
          if (!item.types.includes('image/png')) return item.types.join();
          const bmp = await createImageBitmap(await item.getType('image/png'));
          return `${bmp.width}×${bmp.height}`;
        });
        expect(size).toBe('6×4');
      });
    }
    await test.step("the image stage's context menu is suppressed", async () => {
      // K98: the stage prevents the native menu and stops the event (so a bubbling window listener
      // never sees it); what shows is the app's own menu.
      await page.evaluate(() => {
        const w = window as unknown as { seen: boolean };
        document.addEventListener('contextmenu', (e) => { setTimeout(() => { w.seen = e.defaultPrevented; }); }, true);
      });
      await diff(page).locator('.image-viewport').first().click({ button: 'right' });
      await expect.poll(() => page.evaluate(() => (window as unknown as { seen?: boolean }).seen)).toBe(true);
    });
    await page.keyboard.press('Escape');
    await test.step('Ctrl+scroll zooms around the cursor', async () => {
      await fresh(page);
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
  });

  test('the compare modes: swipe, onion skin and difference; zoom, pan and the swipe handle across them; every mode framed', async ({ page }) => {
    await test.step('swipe, onion skin and difference modes', async () => {
      await open(page, 'logo.png');
      const d = diff(page);
      // K9: Side-by-side's Old/New chips, one per viewport, never in the way of a drag.
      const labelsText = () => d.locator('.image-label').allTextContents();
      await expect.poll(labelsText).toEqual(['Old', 'New']);
      expect(await d.locator('.image-label').first().evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
      // 1000%: the image is wide enough on screen for the handle to travel (it stays inside it, H28).
      await zoomTo(page, 19);
      await modeButton(page, 'Swipe').click();
      await expect(modeButton(page, 'Swipe')).toHaveAttribute('aria-pressed', 'true');
      // K9: one Old chip, one New chip, in Swipe too.
      await expect.poll(labelsText).toEqual(['Old', 'New']);
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
      // K9: Old/New flank the opacity slider.
      await expect.poll(labelsText).toEqual(['Old', 'New']);
      await opacity.fill('20');
      // Each mode starts over at 50% when entered again (H28, H29).
      await modeButton(page, 'Swipe').click();
      await expect(divider).toHaveAttribute('aria-valuenow', '50');
      await modeButton(page, 'Onion skin').click();
      await expect(opacity).toHaveValue('50');
      await expect(d.locator('img.image-layer')).toHaveCount(2);
      await modeButton(page, 'Difference').click();
      // K9 doesn't ask for Old/New in Difference; only K10's Amplify label remains.
      await expect.poll(labelsText).toEqual(['Amplify']);
      const canvas = d.getByTestId('image-difference');
      const litPixels = () => canvas.evaluate((c: HTMLCanvasElement) => {
        const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        let lit = 0;
        for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 0) lit++;
        return lit;
      });
      await expect.poll(litPixels).toBeGreaterThan(0);
      // K10 (fix round 1): the Amplify slider is 1×–16×, the TRUE multiplier, defaulting to 4× (the
      // old fixed ×4 brighten's look), and stays interactive (zoom/pan untouched).
      const amplify = d.getByRole('slider', { name: 'Amplify' });
      await expect(amplify).toHaveAttribute('min', '1');
      await expect(amplify).toHaveAttribute('max', '16');
      await expect(amplify).toHaveValue('4');
      await expect(d.getByTestId('amplify-value')).toHaveText('4×');
      const scaleOf = () => canvas.evaluate((c) => new DOMMatrix(getComputedStyle(c).transform).a);
      const scaleBefore = await scaleOf();
      await amplify.fill('16');
      await expect(d.getByTestId('amplify-value')).toHaveText('16×');
      expect(await scaleOf()).toBe(scaleBefore); // zoom/pan untouched by amplifying
      await expect.poll(litPixels).toBeGreaterThan(0);
    });
    await test.step('K8: a mouse-down anywhere on the image in Swipe mode jumps the handle to the pointer and keeps dragging it', async () => {
      const d = diff(page);
      await zoomTo(page, 19); // 1000%: the 6×4 image is 60×40 px on screen, easy to click within
      await modeButton(page, 'Swipe').click();
      const divider = d.getByRole('slider', { name: 'Swipe position' });
      const handleX = async () => { const h = (await divider.boundingBox())!; return h.x + h.width / 2; };
      await expect(divider).toHaveAttribute('aria-valuenow', '50');
      // The handle is clamped to the image's own on-screen bounds (H27/J10) — click within the
      // image, clear of the handle's own (50%) position and its wider grab area.
      const img = (await d.locator('.swipe-clip img.image-layer').boundingBox())!;
      const y = img.y + img.height / 2;
      const quarter = img.x + img.width * 0.25;
      // A plain click (mouse down + up in place, no movement) jumps it there.
      await page.mouse.move(quarter, y);
      await page.mouse.down();
      await page.mouse.up();
      await expect.poll(async () => Math.abs((await handleX()) - quarter)).toBeLessThanOrEqual(2);
      // A mouse-down followed by a drag (no release in between) keeps following the pointer.
      const most = img.x + img.width * 0.85;
      await page.mouse.move(img.x + img.width * 0.4, y);
      await page.mouse.down();
      await page.mouse.move(most, y, { steps: 8 });
      await expect.poll(async () => Math.abs((await handleX()) - most)).toBeLessThanOrEqual(2);
      await page.mouse.up();
    });
    await test.step('zoom and pan stay linked across modes', async () => {
      const d = diff(page);
      await zoomTo(page, 15);
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
    await test.step('the swipe handle drags to both ends of the image, never past them, and grabbing it never pans (H27, J10)', async () => {
      const d = diff(page);
      await zoomTo(page, 19); // 1000%: the 6×4 image is 60×40 px on screen
      await modeButton(page, 'Swipe').click();
      const divider = d.getByRole('slider', { name: 'Swipe position' });
      const layerBox = async () => (await d.locator('.swipe-clip img.image-layer').boundingBox())!;
      const transform = () => d.locator('img.image-layer').first().evaluate((el) => getComputedStyle(el).transform);
      const before = await transform();
      const vp = (await d.locator('.image-viewport').boundingBox())!;
      const img = await layerBox();
      /** Drags the handle to `x` (page px) and returns the line's centre. */
      const dragTo = async (x: number) => {
        const h = (await divider.boundingBox())!;
        await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
        await page.mouse.down();
        await page.mouse.move(x, h.y + h.height / 2, { steps: 8 });
        await page.mouse.up();
        const end = (await divider.boundingBox())!;
        return end.x + end.width / 2;
      };
      // Past the far right: it stops at the image's right edge (100%), no margin inside it.
      expect(Math.abs((await dragTo(vp.x + vp.width + 50)) - (img.x + img.width))).toBeLessThanOrEqual(1);
      // Past the far left, to the viewport's edge: the image's left edge (0%). (Not off the window's
      // edge: WebKit loses a release out there.)
      expect(Math.abs((await dragTo(vp.x + 2)) - img.x)).toBeLessThanOrEqual(1);
      // And back across the whole image.
      expect(Math.abs((await dragTo(img.x + img.width + 30)) - (img.x + img.width))).toBeLessThanOrEqual(1);
      const end = (await divider.boundingBox())!;
      expect(end.x + end.width).toBeLessThanOrEqual(vp.x + vp.width);
      expect(await transform()).toBe(before);
      // Re-entering Swipe puts it back in the middle.
      await modeButton(page, 'Side-by-side').click();
      await modeButton(page, 'Swipe').click();
      await expect(divider).toHaveAttribute('aria-valuenow', '50');
    });
    await test.step('a drag pans only an image larger than the viewport; one that fits stays put (H27)', async () => {
      await modeButton(page, 'Side-by-side').click();
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
      for (const n of [7, 19]) {
        // 100% and 1000%: the 4×4 image fits either way.
        await zoomTo(page, n);
        const before = await transform();
        await drag(120, 80);
        expect(await transform()).toBe(before);
      }
    });
    await test.step("every mode frames the image's bounds: the pick behind it, a 1 px border, neutral grey around it (J11)", async () => {
      const d = diff(page);
      await zoomTo(page, 19); // 1000%: 40×40 and 60×40 on screen
      await d.getByRole('button', { name: 'White background' }).click();
      const box = async (sel: string, i = 0) => (await d.locator(sel).nth(i).boundingBox())!;
      const same = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
        expect([a.x, a.y, a.width, a.height].map((v, i) => Math.abs(v - [b.x, b.y, b.width, b.height][i]) <= 0.5)).toEqual([true, true, true, true]);
      const style = (sel: string, prop: 'backgroundColor' | 'boxShadow') => d.locator(sel).first().evaluate((el, p) => getComputedStyle(el)[p], prop);
      // Around the image, the viewport's neutral grey (--app-bg0), not the pick.
      expect(await style('.image-viewport', 'backgroundColor')).toBe('rgb(28, 30, 35)');
      expect(await style('.image-frame', 'boxShadow')).toMatch(/0px 0px 0px 1px$/);
      // Side by side: each frame is its own image's box.
      same(await box('.image-frame', 0), await box('img.image-layer', 0));
      same(await box('.image-frame', 1), await box('img.image-layer', 1));
      expect(await style('.image-frame', 'backgroundColor')).toBe('rgb(255, 255, 255)');
      // Swipe and onion skin: one frame, the new (wider) image's box.
      for (const mode of ['Swipe', 'Onion skin']) {
        await modeButton(page, mode).click();
        await expect(d.locator('.image-frame')).toHaveCount(1);
        same(await box('.image-frame'), await box('img.image-layer', 1));
        expect(await style('.image-frame', 'backgroundColor')).toBe('rgb(255, 255, 255)');
      }
      // Difference: its own black rendering, framed.
      await modeButton(page, 'Difference').click();
      await expect(d.locator('.image-frame')).toHaveCount(1);
      // The difference is drawn once both images are read back: the frame follows its box.
      await expect(async () => same(await box('.image-frame'), await box('[data-testid="image-difference"]'))).toPass();
      expect(await style('.image-frame', 'boxShadow')).toMatch(/0px 0px 0px 1px$/);
      expect(await style('.image-viewport', 'backgroundColor')).toBe('rgb(28, 30, 35)');
    });
  });

  test('an SVG and its Source toggle, a raster image and its Hex toggle, and the background toggles', async ({ page }) => {
    await test.step('an SVG shows as images, with a Source toggle for the text diff', async () => {
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
    await test.step('a raster image has a Hex toggle for the hex diff of its bytes', async () => {
      await open(page, 'logo.png');
      const d = diff(page);
      await d.getByRole('button', { name: 'Hex', exact: true }).click();
      // Its hex view (hex.spec.ts): the text panes start with the PNG signature.
      await expect(d.getByTestId('hex-view').locator('.hex-pane-text').first()).toContainText('.PNG', { timeout: 15_000 });
      await expect(d.getByRole('button', { name: 'Next change' })).toBeEnabled();
      await d.getByRole('button', { name: 'Hex', exact: true }).click();
      await expect(d.locator('img.image-layer')).toHaveCount(2);
    });
    await test.step('background toggles: checkerboard by default, then black, white or grey, remembered after a reload (H30)', async () => {
      const d = diff(page);
      // Behind the image only (J11).
      const bg = () => d.locator('.image-frame').first().evaluate((el) => getComputedStyle(el).backgroundColor);
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

  // J13: a switch to another image painted it at the top left for a frame, then centred it.
  // One page for both views (each was a test of its own, paying for a page load).
  test('switching between images paints each only where it ends up, centred (J13), in Diff View and File View', async ({ page }) => {
    for (const view of ['Diff View', 'File View'] as const) {
      await test.step(`${view}: switching between images paints each only where it ends up, centred (J13)`, async () => {
        // The Diff View step's last image closed first: its diff hides the graph.
        if (view === 'File View') await diff(page).getByRole('button', { name: 'Close diff' }).click();
        const d = diff(page);
        // File View between two images: "View all files" on the merge after COMMIT, where both are
        // unchanged, opens each in File View.
        if (view === 'File View') {
          await page.getByRole('row').filter({ hasText: "Merge branch 'feature/x'" }).click();
          await page.getByRole('button', { name: 'View all files' }).click();
        }
        await open(page, 'logo.png');
        const dims = view === 'File View' ? { 'logo.png': '6×4', 'icon.svg': '16×16' } : { 'logo.png': '4×4 → 6×4', 'icon.svg': '16×16 → 16×16' };
        await expect(d.getByTestId('image-dims')).toHaveText(dims['logo.png']);
        for (const path of ['icon.svg', 'logo.png', 'icon.svg'] as const) {
          const stop = await sampleImages(page);
          await fileRow(page, path).click();
          await expect(d.getByTestId('diff-path')).toContainText(path);
          await expect(d.getByTestId('image-dims')).toHaveText(dims[path]);
          const frames = await stop();
          expect(frames.length).toBeGreaterThan(6);
          const final = frames.at(-1)!;
          expect(final.length).toBeGreaterThan(0);
          // Where they end up: centred in their viewport (the widest side exactly; at 100% a
          // narrower one is at most a pixel or two off).
          for (const p of final) {
            expect(Math.abs(p.x + p.w / 2 - (p.vx + p.vw / 2)), p.key).toBeLessThanOrEqual(2);
            expect(Math.abs(p.y + p.h / 2 - (p.vy + p.vh / 2)), p.key).toBeLessThanOrEqual(2);
          }
          // Every paint that shows the new image shows it there, and nowhere else.
          const at = new Map(final.map((p) => [p.key, p]));
          const off = frames.flatMap((f, i) => f.filter((p) => at.has(p.key)).filter((p) => {
            const q = at.get(p.key)!;
            return Math.abs(p.x - q.x) > 0.5 || Math.abs(p.y - q.y) > 0.5 || Math.abs(p.w - q.w) > 0.5 || Math.abs(p.h - q.h) > 0.5;
          }).map((p) => ({ frame: i, ...p })));
          expect(off).toEqual([]);
        }
      });
    }
  });

  test('K81: an SVG with only a viewBox is drawn inside its box, at Fit and at 100% (intrinsic size = the viewBox); Match sizes for a resized PNG', async ({ page }) => {
    const repo = freshFixture('details');
    // A resized image: generated, the same picture at 640×400, then at 320×200.
    writeFileSync(join(repo, 'shot.png'), resizablePng(640, 400));
    git(repo, 'add', 'shot.png');
    git(repo, 'commit', '-m', 'Add shot');
    writeFileSync(join(repo, 'shot.png'), resizablePng(320, 200));
    // A PNG converted to WebP (the format-change step at the end), both drawn by the browser
    // before the page loads: 40×30 red, then 48×30 blue.
    const [png, webp] = await page.evaluate(() => {
      const draw = (w: number, h: number, color: string, type: string) => {
        const c = document.createElement('canvas');
        Object.assign(c, { width: w, height: h });
        const g = c.getContext('2d')!;
        g.fillStyle = color;
        g.fillRect(0, 0, w, h);
        return c.toDataURL(type);
      };
      return [draw(40, 30, '#d33', 'image/png'), draw(48, 30, '#36c', 'image/webp')];
    });
    expect(webp).toMatch(/^data:image\/webp;base64,/);
    const bytes = (url: string) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
    mkdirSync(join(repo, 'docs/images'), { recursive: true });
    writeFileSync(join(repo, 'docs/images/screenshot.png'), bytes(png));
    git(repo, 'add', 'docs/images/screenshot.png');
    git(repo, 'commit', '-m', 'Add screenshot');
    writeFileSync(join(repo, 'docs/images/screenshot.webp'), bytes(webp));
    git(repo, 'rm', '-q', 'docs/images/screenshot.png');
    git(repo, 'add', 'docs/images/screenshot.webp');
    git(repo, 'commit', '-m', 'Screenshot as WebP');
    writeFileSync(join(repo, 'viewbox.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#15a0bf"/><circle cx="256" cy="256" r="200" fill="#f25d2e"/></svg>\n');
    git(repo, 'add', 'viewbox.svg', 'shot.png');
    git(repo, 'commit', '-m', 'Add viewbox svg, resize shot');
    await page.setViewportSize({ width: 1100, height: 520 }); // small enough that 512×512 needs Fit < 100%
    await page.goto(openUrl(repo));
    await page.getByRole('row').filter({ hasText: 'Add viewbox svg' }).click();
    await open(page, 'viewbox.svg');
    const d = diff(page);
    await expect(d.getByTestId('image-dims')).toHaveText('512×512');
    const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(0.5);
    const check = async (inside: boolean) => {
      const img = (await d.locator('img.image-layer').boundingBox())!;
      const frame = (await d.locator('.image-frame').boundingBox())!;
      const view = (await d.locator('.image-viewport').boundingBox())!;
      near(img.x, frame.x); near(img.y, frame.y); near(img.width, frame.width); near(img.height, frame.height);
      expect(img.width).toBeGreaterThan(8);
      if (!inside) return img; // 100% of 512×512 is larger than this viewport; only the box match matters
      expect(img.x).toBeGreaterThanOrEqual(view.x - 0.5);
      expect(img.x + img.width).toBeLessThanOrEqual(view.x + view.width + 0.5);
      expect(img.y + img.height).toBeLessThanOrEqual(view.y + view.height + 0.5);
      return img;
    };
    await fitButton(page).click();
    await expect(fitButton(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(d.getByTestId('zoom-label')).not.toHaveText('100%');
    const fit = await check(true);
    expect(fit.width).toBeLessThan(512);
    await d.getByRole('slider', { name: 'Zoom' }).dblclick(); // K14: back to 100%
    const full = await check(false);
    near(full.width, 512);
    near(full.height, 512);

    await test.step('Match sizes: a resized PNG shows the toggle, on by default; in Swipe both images have the same box', async () => {
      await open(page, 'shot.png');
      await expect(d.getByTestId('image-dims')).toHaveText('640×400 → 320×200');
      const toggle = d.getByRole('button', { name: 'Match sizes' });
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await modeButton(page, 'Swipe').click();
      await expect(d.getByTestId('match-note')).toHaveText('scaled to match');
      const [before, after] = await Promise.all([d.locator('img.image-layer[alt="before"]').boundingBox(), d.locator('img.image-layer[alt="after"]').boundingBox()]);
      near(before!.x, after!.x); near(before!.y, after!.y); near(before!.width, after!.width); near(before!.height, after!.height);
      near(after!.width, 320); // 100%: the common size is the new image's
    });

    await test.step('a PNG converted to WebP is one renamed row, and the image diff compares the two', async () => {
      await d.getByRole('button', { name: 'Close diff' }).click(); // its diff hides the graph
      await page.getByRole('row').filter({ hasText: 'Screenshot as WebP' }).click();
      await expect(page.getByTestId('file-counts')).toHaveAccessibleName('1 renamed');
      await expect(fileRow(page, 'docs/images/screenshot.png')).toHaveCount(0);
      await fileRow(page, 'docs/images/screenshot.webp').hover();
      await expect(page.getByTestId('format-change')).toHaveText('Format changed: PNG → WebP');
      await fileRow(page, 'docs/images/screenshot.webp').click();
      await expect(d.getByTestId('diff-path')).toHaveText('docs/images/screenshot.png ⇒ screenshot.webp');
      await expect(d.locator('img.image-layer')).toHaveCount(2);
      await expect(d.getByTestId('image-dims')).toHaveText(/40×30\s*→\s*48×30/);
    });
  });
});
