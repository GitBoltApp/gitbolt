import { expect, test, type Locator, type Page } from './test';
import { COLUMN_MIN } from '../src/graph/columns';
import { graphLayout, nodeRadius, SHADE_W, zoneWidth } from '../src/graph/draw';
import { GRAPH_METRICS, METRICS } from '../src/graph/metrics';
import { DENSITIES, DENSITY_STORAGE_KEY } from '../src/theme/density';
import { fixtures, openUrl } from './fixtures';

/** Plan 1C Task 16a: the collapse zone and lane scrollbar (spec §8.3, F11, R11), collapsed and
 * hidden columns (§8.4). Session-only: persisting hidden columns and widths is Task 16b. */

const open = async (page: Page, path = fixtures.basic) => {
  await page.goto(openUrl(path));
  await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
};
/** Presses ArrowLeft on `name`'s resize handle until the column is at its minimum. */
const toMinimum = async (page: Page, name: string, min: number) => {
  const handle = page.getByRole('separator', { name: `Resize ${name} column` });
  await handle.focus();
  for (let i = 0; i < 60 && Number(await handle.getAttribute('aria-valuenow')) > min; i++) await page.keyboard.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', String(min));
};
const inked = (canvas: Locator) => canvas.evaluate((c: HTMLCanvasElement) => {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
});
/** The DOM label connector ends exactly where the canvas begins (the continuity rule), and the
 * canvas continues it at its left edge. */
async function expectConnectorMeetsCanvas(page: Page, row: Locator) {
  const connector = row.locator('.ref-connector').first();
  await expect(connector).toBeVisible();
  const [conn, canvas, box] = await Promise.all([connector.boundingBox(), page.getByTestId('graph-canvas').boundingBox(), row.boundingBox()]);
  expect(conn!.width).toBeGreaterThanOrEqual(8);
  expect(Math.abs(conn!.x + conn!.width - canvas!.x)).toBeLessThanOrEqual(0.5);
  const y = box!.y + box!.height / 2 - canvas!.y;
  const a = await page.getByTestId('graph-canvas').evaluate((c: HTMLCanvasElement, cy: number) => {
    const dpr = c.width / c.getBoundingClientRect().width;
    const ctx = c.getContext('2d')!;
    // The connector straddles the centre line: the brighter of the two device rows around it.
    return Math.max(...[-1, 0].map((d) => ctx.getImageData(Math.round(2 * dpr), Math.floor(cy * dpr) + d, 1, 1).data[3]));
  }, y);
  expect(a).toBeGreaterThan(0);
}

test.describe('graph extras', () => {
  test('the Graph column at its minimum: a strip of nodes, a header icon, no lane scrollbar', async ({ page }) => {
    await open(page);
    await toMinimum(page, 'Graph', COLUMN_MIN.graph);
    await expect(page.getByRole('img', { name: 'Graph' })).toBeVisible();
    await expect(page.locator('.graph-header [data-col="graph"]')).not.toContainText('GRAPH');
    const canvas = page.getByTestId('graph-canvas');
    await expect(canvas).toHaveAttribute('data-strip', 'true');
    expect(await inked(canvas)).toBeGreaterThan(200);
    await expect(page.getByLabel('Scroll lanes')).toHaveCount(0);
  });

  test('a wide graph narrowed: the lane scrollbar spans the lane area and scrolls the lanes; the zone stays put', async ({ page }) => {
    await open(page, fixtures.wide);
    const canvas = page.getByTestId('graph-canvas');
    await expect(page.getByLabel('Scroll lanes')).toHaveCount(0);
    const handle = page.getByRole('separator', { name: 'Resize Graph column' });
    await handle.focus();
    for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowLeft');
    await expect(canvas).toHaveAttribute('data-clipped', 'true');
    const bar = page.getByLabel('Scroll lanes');
    await expect(bar).toBeVisible();
    const [barBox, canvasBox] = await Promise.all([bar.boundingBox(), canvas.boundingBox()]);
    expect(barBox!.x).toBeCloseTo(canvasBox!.x, 0);
    expect(barBox!.width).toBeLessThan(canvasBox!.width);
    // At the bottom of the visible rows.
    const grid = (await page.getByRole('grid', { name: 'Commit graph' }).boundingBox())!;
    expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(grid.y + grid.height + 0.5);
    const snapshot = () => canvas.evaluate((c: HTMLCanvasElement, [zoneW, shadeW]: number[]) => {
      const dpr = c.width / c.getBoundingClientRect().width;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      // Hash the lane area (left of the shade) and the zone separately.
      const zoneX = c.width - Math.round(zoneW * dpr);
      let lanes = 0, zone = 0;
      for (let i = 0; i < d.length; i += 4) {
        const x = (i / 4) % c.width;
        const v = (d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7 + d[i + 3]) * ((i % 97) + 1);
        if (x < zoneX - (shadeW + 2) * dpr) lanes = (lanes + v) % 1e9;
        else if (x >= zoneX) zone = (zone + v) % 1e9;
      }
      return { lanes, zone };
    }, [zoneWidth(METRICS), SHADE_W]);
    const before = await snapshot();
    await expect(bar).toHaveAttribute('aria-valuenow', '0');
    await bar.evaluate((el) => { el.scrollLeft = 200; el.dispatchEvent(new Event('scroll')); });
    await expect.poll(async () => (await snapshot()).lanes).not.toBe(before.lanes);
    await expect(bar).toHaveAttribute('aria-valuenow', '200');
    // To the real far end (the last lane in view), then back to the start: the first picture
    // comes back exactly.
    await bar.evaluate((el) => { el.scrollLeft = el.scrollWidth; el.dispatchEvent(new Event('scroll')); });
    await expect(bar).toHaveAttribute('aria-valuenow', (await bar.getAttribute('aria-valuemax'))!);
    await bar.evaluate((el) => { el.scrollLeft = 0; el.dispatchEvent(new Event('scroll')); });
    await expect.poll(async () => (await snapshot()).lanes).toBe(before.lanes);
    expect((await snapshot()).zone).toBe(before.zone);
  });

  test('right-clicking the header hides and shows columns (session only, until Task 16b)', async ({ page }) => {
    await open(page);
    await page.locator('.graph-header').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Hide Author' }).click();
    await expect(page.locator('.graph-header [data-col="author"]')).toHaveCount(0);
    await expect(page.getByRole('row').first().locator('[data-col="author"]')).toHaveCount(0);
    // Header and rows still line up: Message took Author's width.
    const [h, c] = await Promise.all([page.locator('.graph-header [data-col="message"]').boundingBox(), page.getByRole('row').first().locator('[data-col="message"]').boundingBox()]);
    expect(h!.width).toBeCloseTo(c!.width, 0);
    await page.locator('.graph-header').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Show Author' }).click();
    await expect(page.getByRole('row').first().locator('[data-col="author"]')).toHaveCount(1);
  });

  test('the column menu opens from the keyboard (menu key or Shift+F10 on a header control) and runs from it', async ({ page }) => {
    await open(page);
    const handle = page.getByRole('separator', { name: 'Resize Branch / Tag column' });
    await handle.focus();
    await page.keyboard.press('Shift+F10');
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Hide Branch / Tag' })).toBeVisible();
    // Opened below the focused column's header cell.
    const [cell, box] = await Promise.all([page.locator('.graph-header [data-col="labels"]').boundingBox(), menu.boundingBox()]);
    expect(box!.y).toBeGreaterThanOrEqual(cell!.y + cell!.height - 1);
    // The first row is active: ↓ then Enter runs "Hide Author".
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.locator('.graph-header [data-col="author"]')).toHaveCount(0);
    // The menu key too; Esc closes it.
    await handle.focus();
    await page.keyboard.press('ContextMenu');
    await expect(menu.getByRole('menuitem', { name: 'Show Author' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('Author at its minimum: header icon, avatar-only cells named by a tooltip', async ({ page }) => {
    await open(page);
    await toMinimum(page, 'Author', COLUMN_MIN.author);
    await expect(page.getByRole('img', { name: 'Author' }).first()).toBeVisible();
    const cell = page.getByRole('row').nth(4).locator('[data-col="author"]');
    await expect(cell.getByTestId('avatar')).toBeVisible();
    const name = await cell.locator('.author-avatar').getAttribute('aria-label');
    expect(name).toBeTruthy();
    await cell.locator('.author-avatar').hover();
    await expect(page.getByRole('tooltip')).toHaveText(name!);
  });

  for (const d of DENSITIES) {
    test(`${d}: Branch/Tag at its minimum shows icon-only chips, the Graph column clipped packs its lanes, and the connector stays continuous`, async ({ page }) => {
      await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [DENSITY_STORAGE_KEY, d]);
      await open(page);
      await toMinimum(page, 'Branch / Tag', COLUMN_MIN.labels);
      await expect(page.getByRole('img', { name: 'Branch / Tag' })).toBeVisible();
      const row = page.getByRole('row').nth(4);
      const chip = row.locator('.ref-labels > .ref-label').first();
      await expect(chip).toHaveClass(/compact/);
      await expect(chip.locator('.ref-name')).toHaveCount(0);
      await expectConnectorMeetsCanvas(page, row);
      // Hovering names the ref again.
      await chip.hover();
      await expect(row.locator('.ref-label-full')).toContainText('main');
      // The Graph column one step narrower than its lanes: the zone shows; connectors still meet.
      const graph = page.getByRole('separator', { name: 'Resize Graph column' });
      await graph.focus();
      await page.keyboard.press('ArrowLeft');
      await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-clipped', 'true');
      await expectConnectorMeetsCanvas(page, row);
      // And at its minimum (the strip).
      await toMinimum(page, 'Graph', COLUMN_MIN.graph);
      await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-strip', 'true');
      await expectConnectorMeetsCanvas(page, row);
    });

    test(`${d}: a labelled row whose node is packed: its connector runs across the lane area all the way to the packed node`, async ({ page }) => {
      await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [DENSITY_STORAGE_KEY, d]);
      await open(page, fixtures.wide);
      const m = GRAPH_METRICS[d];
      const handle = page.getByRole('separator', { name: 'Resize Graph column' });
      await handle.focus();
      // Narrowed until about five lanes fit beside the zone: the rows below them are packed.
      const target = zoneWidth(m) + m.padX + 5 * m.laneW + SHADE_W;
      for (let i = 0; i < 200 && Number(await handle.getAttribute('aria-valuenow')) > target; i++) await page.keyboard.press('ArrowLeft');
      const canvas = page.getByTestId('graph-canvas');
      await expect(canvas).toHaveAttribute('data-clipped', 'true');
      const width = Number(await handle.getAttribute('aria-valuenow'));
      const { area, packedX } = graphLayout(width, m, true);
      expect(area).toBeGreaterThan(SHADE_W + m.laneW);
      const r = nodeRadius(m);
      const canvasBox = (await canvas.boundingBox())!;
      // Every row of the wide fixture is labelled; the first whose node sits in the packed column.
      const rows = page.getByRole('row');
      let packed = -1;
      for (let i = 0; i < 12 && packed < 0; i++) {
        const box = (await rows.nth(i).boundingBox())!;
        const y = box.y + box.height / 2 - canvasBox.y;
        const a = await canvas.evaluate((c: HTMLCanvasElement, [x, cy]: number[]) => {
          const dpr = c.width / c.getBoundingClientRect().width;
          return c.getContext('2d')!.getImageData(Math.floor(x * dpr), Math.floor(cy * dpr), 1, 1).data[3];
        }, [packedX, y]);
        if (a > 100) packed = i;
      }
      expect(packed).toBeGreaterThanOrEqual(0);
      const row = rows.nth(packed);
      await expect(row.locator('.ref-connector')).toHaveCount(1);
      await expectConnectorMeetsCanvas(page, row);
      const box = (await row.boundingBox())!;
      const y = box.y + box.height / 2 - canvasBox.y;
      // On the row's centre line vs 4 px above it (the band only): at a lane boundary left of the
      // shade (no lane line, and a packed row has no band there), and just before the packed
      // node's left edge (inside the zone, over the band).
      const laneGap = m.padX + Math.floor((area - SHADE_W - m.padX) / m.laneW) * m.laneW;
      const px = await canvas.evaluate((c: HTMLCanvasElement, [x1, x2, cy]: number[]) => {
        const dpr = c.width / c.getBoundingClientRect().width;
        const ctx = c.getContext('2d')!;
        const a = (x: number, yy: number) => Math.max(...[-1, 0].map((dy) => ctx.getImageData(Math.floor(x * dpr), Math.floor(yy * dpr) + dy, 1, 1).data[3]));
        return { gapOn: a(x1, cy), gapOff: a(x1, cy - 4), edgeOn: a(x2, cy), edgeOff: a(x2, cy - 4) };
      }, [laneGap, packedX - r - 1, y]);
      // (Off the line, at most an antialiased fringe of a nearby lane curve.)
      expect(px.gapOff).toBeLessThan(16);
      expect(px.gapOn).toBeGreaterThan(px.gapOff + 32);
      expect(px.edgeOn).toBeGreaterThan(px.edgeOff);
    });
  }
});
