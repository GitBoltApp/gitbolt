import { expect, test, type Page } from '@playwright/test';
import { allocateColumns, COLUMN_MIN, DEFAULT_COLUMN_PREFS } from '../src/graph/columns';
import { RAIL_W, STRIP_W } from '../src/graph/draw';
import { METRICS } from '../src/graph/metrics';
import { GRAPH_COLORS } from '../src/theme/graphColors';
import { fixtures, openUrl } from './fixtures';

test.describe('commit graph', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(openUrl(fixtures.basic));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
  });

  test('renders every row of the basic fixture with labels and WIP rows', async ({ page }) => {
    const rows = page.getByRole('row');
    await expect(rows).toHaveCount(10);
    await expect(page.getByText("Merge branch 'feature/login'")).toBeVisible();
    await expect(page.getByText('// WIP')).toHaveCount(2);
    await expect(page.getByText('wt-hotfix')).toBeVisible();
    await expect(rows.nth(4).getByText('main', { exact: true })).toBeVisible();
    await expect(page.getByText('v1.0')).toBeVisible();
    await expect(page).toHaveTitle('GitBolt — repo');
  });

  test('canvas draws lanes', async ({ page }) => {
    const inked = await page.getByTestId('graph-canvas').evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n;
    });
    expect(inked).toBeGreaterThan(500);
  });

  test('canvas paints a non-transparent colour at a row band', async ({ page }) => {
    // Sample near the band's right side (canvas.width - strip - 2*dpr) rather than a
    // hard-coded lane-0 x: the tinted row band (see draw.ts BAND_ALPHA) covers the row from the
    // node's lane out to the darker "collapse strip" at the canvas edge, so this point is inked
    // regardless of how many lanes the fixture happens to use. Row 0's vertical center is
    // CSS y = rowH / 2.
    const alpha = await page.getByTestId('graph-canvas').evaluate((c: HTMLCanvasElement, [stripW, rowH]: number[]) => {
      const rect = c.getBoundingClientRect();
      const dpr = c.width / rect.width;
      const x = Math.round(c.width - stripW * dpr - 2 * dpr);
      const y = Math.round((rowH / 2) * dpr);
      return c.getContext('2d')!.getImageData(x, y, 1, 1).data[3];
    }, [STRIP_W, METRICS.rowH]);
    expect(alpha).toBeGreaterThan(0);
  });

  test('rows are the single-sourced METRICS.rowH tall', async ({ page }) => {
    const box = await page.getByRole('row').first().boundingBox();
    expect(box?.height).toBe(METRICS.rowH);
  });

  test('canvas paints an opaque lane-colored rail at its right edge on every row', async ({ page }) => {
    // Row 0 (the stash) and row 4 (main's merge, lane 0): sample the rail's last device pixel
    // column at each row's center. It must be fully opaque and exactly the lane's color.
    const samples = await page.getByTestId('graph-canvas').evaluate((c: HTMLCanvasElement, [railW, rowH]: number[]) => {
      const dpr = c.width / c.getBoundingClientRect().width;
      const ctx = c.getContext('2d')!;
      return [0, 1, 2, 3, 4].map((i) => {
        const d = ctx.getImageData(c.width - Math.max(1, Math.round(railW * dpr)), Math.round((i * rowH + rowH / 2) * dpr), 1, 1).data;
        return { a: d[3], hex: '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('') };
      });
    }, [RAIL_W, METRICS.rowH]);
    for (const s of samples) {
      expect(s.a).toBe(255);
      expect(GRAPH_COLORS).toContain(s.hex);
    }
    expect(samples[4].hex).toBe(GRAPH_COLORS[0]);
  });

  test('about 10px of margin separates the summary from the dimmed body', async ({ page }) => {
    await page.goto(openUrl(fixtures.longLabels));
    const summary = page.locator('.msg-summary', { hasText: 'Initial commit' });
    const body = summary.locator('xpath=following-sibling::*[1]');
    await expect(body).toHaveClass(/msg-body/);
    const [s, b] = await Promise.all([summary.boundingBox(), body.boundingBox()]);
    if (!s || !b) throw new Error('missing summary/body box');
    expect(b.x - (s.x + s.width)).toBeGreaterThanOrEqual(9);
    expect(b.x - (s.x + s.width)).toBeLessThanOrEqual(11);
  });

  test('label connector reaches the canvas edge', async ({ page }) => {
    const connector = page.locator('.ref-connector').first();
    await expect(connector).toBeVisible();
    const canvas = page.getByTestId('graph-canvas');
    const [connBox, canvasBox] = await Promise.all([connector.boundingBox(), canvas.boundingBox()]);
    if (!connBox || !canvasBox) throw new Error('missing bounding box for connector or canvas');
    expect(connBox.width).toBeGreaterThanOrEqual(8);
    expect(Math.abs(connBox.x + connBox.width - canvasBox.x)).toBeLessThanOrEqual(0.5);
  });

  test('keyboard navigation moves the selection', async ({ page }) => {
    const rows = page.getByRole('row');
    await rows.nth(0).click();
    await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(2)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true');
  });

  test('clicking a SHA copies the full hash', async ({ page, browserName }) => {
    const sha = page.getByTestId('sha').first();
    const short = (await sha.textContent())!;
    await sha.click();
    await expect(page.getByRole('status')).toHaveText('Copied');
    if (browserName === 'chromium') {
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toHaveLength(40);
      expect(copied.startsWith(short)).toBe(true);
    }
  });
});

test('unborn repository shows an empty state', async ({ page }) => {
  await page.goto(openUrl(fixtures.unborn));
  await expect(page.getByText('No commits yet')).toBeVisible();
});

test('a folder that is not a repository shows the error', async ({ page }) => {
  await page.goto(openUrl(fixtures.notRepo));
  await expect(page.getByRole('alert')).toContainText('Not a git repository');
});

test('label connector survives a very long branch name and a second label', async ({ page }) => {
  await page.goto(openUrl(fixtures.longLabels));
  await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();

  // Two labels on the same row (the long branch name, plus a tag) collapse the second into a
  // "+1" badge; the chip itself must still ellipsize instead of pushing the connector out.
  await expect(page.locator('.ref-more')).toHaveText('+1');
  const refName = page.locator('.ref-name').first();
  const truncated = await refName.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(truncated).toBe(true);

  const connector = page.locator('.ref-connector').first();
  await expect(connector).toBeVisible();
  const canvas = page.getByTestId('graph-canvas');
  const [connBox, canvasBox] = await Promise.all([connector.boundingBox(), canvas.boundingBox()]);
  if (!connBox || !canvasBox) throw new Error('missing bounding box for connector or canvas');
  expect(connBox.width).toBeGreaterThanOrEqual(8);
  expect(Math.abs(connBox.x + connBox.width - canvasBox.x)).toBeLessThanOrEqual(0.5);
});

test.describe('hover polish', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(openUrl(fixtures.longLabels));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
  });

  test('hovering a truncated label chip floats it at full width over the graph, then collapses', async ({ page }) => {
    const chip = page.locator('.ref-labels > .ref-label').first();
    const connector = page.locator('.ref-connector').first();
    const [chipBefore, connBefore] = await Promise.all([chip.boundingBox(), connector.boundingBox()]);
    if (!chipBefore || !connBefore) throw new Error('missing chip/connector box');
    const labelsW = (await page.locator('.graph-header [data-col="labels"]').boundingBox())!.width;

    await chip.hover();
    const full = page.locator('.ref-label-full');
    await expect(full).toBeVisible();
    const fullBox = (await full.boundingBox())!;
    expect(fullBox.width).toBeGreaterThan(labelsW);
    // Exactly over the resting chip.
    expect(Math.abs(fullBox.x - chipBefore.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(fullBox.y - chipBefore.y)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(fullBox.height - chipBefore.height)).toBeLessThanOrEqual(0.5);
    // Untruncated.
    const name = full.locator('.ref-name-full');
    await expect(name).toHaveText(/extremely-long-branch-name.*commit-graph-ui$/);
    expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    // The row layout and the connector's resting geometry don't move.
    expect(await chip.boundingBox()).toEqual(chipBefore);
    expect(await connector.boundingBox()).toEqual(connBefore);
    // It floats above the canvas. Both the copy and the canvas ignore the pointer, so for this
    // check only they're made hit-testable: hit-testing follows paint order, so the point where
    // the copy overlaps the canvas must hit the copy (it hits the canvas when a row transform
    // traps the copy underneath).
    const canvasX = (await page.getByTestId('graph-canvas').boundingBox())!.x;
    const hit = await page.evaluate(([x, y]) => {
      const els = [document.querySelector<HTMLElement>('[data-testid="graph-canvas"]')!, document.querySelector<HTMLElement>('.graph-canvas-clip')!, document.querySelector<HTMLElement>('.ref-label-full')!];
      for (const el of els) el.style.pointerEvents = 'auto';
      const el = document.elementFromPoint(x, y);
      for (const e of els) e.style.pointerEvents = '';
      return !!el?.closest('.ref-label-full');
    }, [canvasX + 10, fullBox.y + fullBox.height / 2]);
    expect(hit).toBe(true);
    // The instant tooltip lists the refs the chip stands for.
    await expect(page.getByRole('tooltip')).toHaveText(/^refs\/heads\/feature\/this-is-an-extremely-long/);

    await page.locator('.graph-header [data-col="message"]').hover();
    await expect(full).toHaveCount(0);
    await expectConnectorMeetsCanvas(page);
  });

  test('moving right from the expanded chip reaches the +N badge and its tooltip', async ({ page }) => {
    const chip = page.locator('.ref-labels > .ref-label').first();
    await chip.hover();
    await expect(page.locator('.ref-label-full')).toBeVisible();
    const chipBox = (await chip.boundingBox())!;
    const moreBox = (await page.locator('.ref-more').boundingBox())!;
    // Horizontally, at the chip's height, across the part the expanded copy covers.
    const y = chipBox.y + chipBox.height / 2;
    await page.mouse.move(chipBox.x + chipBox.width - 2, y);
    await page.mouse.move(moreBox.x + moreBox.width / 2, y, { steps: 6 });
    await expect(page.locator('.ref-label-full')).toHaveCount(0);
    await expect(page.getByRole('tooltip')).toHaveText('also-tagged-here');
    await expectConnectorMeetsCanvas(page);
  });

  test('resting on a message cell loads and shows the full commit message after a delay', async ({ page }) => {
    // The graph payload carries no full bodies: the tooltip loads the message on demand.
    const requests: string[] = [];
    page.on('websocket', (ws) => ws.on('framesent', (f) => { if (typeof f.payload === 'string' && f.payload.includes('"commitMessage"')) requests.push(f.payload); }));
    await page.reload();
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    const cell = page.getByRole('row').filter({ hasText: 'Initial commit' }).locator('[data-col="message"]');
    await cell.hover();
    const tip = page.getByRole('tooltip');
    // Deliberately delayed (~500 ms): not there right away.
    await expect(tip).toHaveCount(0);
    await expect(tip).toBeVisible();
    await expect(tip.locator('.msg-tooltip-summary')).toHaveText('Initial commit');
    const body = await tip.locator('.msg-tooltip-body').evaluate((el) => (el as HTMLElement).innerText);
    expect(body).toContain('A second paragraph,\nwrapped over two lines.');
    expect(body.startsWith('With a body line\n')).toBe(true);
    const box = (await tip.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(600);

    expect(requests).toHaveLength(1);

    await page.locator('.graph-header [data-col="message"]').hover();
    await expect(tip).toHaveCount(0);

    // Cached per commit: resting on it again shows it without another request.
    await cell.hover();
    await expect(tip.locator('.msg-tooltip-body')).toContainText('wrapped over two lines.');
    expect(requests).toHaveLength(1);
  });
});

/** Asserts the DOM label connector ends exactly where the canvas begins (the continuity rule). */
async function expectConnectorMeetsCanvas(page: Page) {
  const connector = page.locator('.ref-connector').first();
  await expect(connector).toBeVisible();
  const [connBox, canvasBox] = await Promise.all([connector.boundingBox(), page.getByTestId('graph-canvas').boundingBox()]);
  if (!connBox || !canvasBox) throw new Error('missing bounding box for connector or canvas');
  expect(connBox.width).toBeGreaterThanOrEqual(8);
  expect(Math.abs(connBox.x + connBox.width - canvasBox.x)).toBeLessThanOrEqual(0.5);
}

const COLS = ['labels', 'graph', 'message', 'author', 'date', 'sha'] as const;

/** Rendered widths of each header cell and of the same cell in the first row. */
async function columnWidths(page: Page) {
  return page.evaluate((cols) => {
    const w = (el: Element | null) => (el ? el.getBoundingClientRect().width : NaN);
    const x = (el: Element | null) => (el ? el.getBoundingClientRect().x : NaN);
    const row = document.querySelector('[role="row"]');
    return Object.fromEntries(cols.map((c) => {
      const h = document.querySelector(`.graph-header [data-col="${c}"]`);
      const r = row?.querySelector(`[data-col="${c}"]`) ?? null;
      return [c, { header: w(h), cell: w(r), headerX: x(h), cellX: x(r) }];
    }));
  }, [...COLS]);
}

test.describe('resizable columns', () => {
  test('label connector still meets the canvas at a non-default Branch/Tag width (drag and keyboard)', async ({ page }) => {
    await page.goto(openUrl(fixtures.basic));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    const handle = page.getByRole('separator', { name: 'Resize Branch / Tag column' });

    // Pointer drag: +57 px (deliberately not a multiple of the 8 px key step).
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2, { steps: 3 });
    await page.mouse.move(box.x + box.width / 2 + 57, box.y + box.height / 2, { steps: 3 });
    await page.mouse.up();
    await expect(handle).toHaveAttribute('aria-valuenow', String(DEFAULT_COLUMN_PREFS.labels + 57));
    const canvasBox = (await page.getByTestId('graph-canvas').boundingBox())!;
    const labelsCell = (await page.getByRole('row').first().locator('[data-col="labels"]').boundingBox())!;
    expect(canvasBox.x).toBeCloseTo(labelsCell.x + DEFAULT_COLUMN_PREFS.labels + 57, 1);
    await expectConnectorMeetsCanvas(page);

    // Keyboard: focus the handle, ArrowLeft x5 moves the boundary 40 px left.
    await handle.focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', String(DEFAULT_COLUMN_PREFS.labels + 57 - 40));
    await expectConnectorMeetsCanvas(page);

    // And at the minimum width.
    for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', String(COLUMN_MIN.labels));
    await expectConnectorMeetsCanvas(page);
  });

  test('the canvas and its backing store follow a resized Graph column live', async ({ page }) => {
    await page.goto(openUrl(fixtures.basic));
    const canvas = page.getByTestId('graph-canvas');
    const before = (await canvas.boundingBox())!.width;
    const handle = page.getByRole('separator', { name: 'Resize Graph column' });
    await handle.focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await canvas.boundingBox())!.width).toBe(before + 32);
    const graphCell = (await page.getByRole('row').first().locator('[data-col="graph"]').boundingBox())!;
    expect((await canvas.boundingBox())!.x).toBeCloseTo(graphCell.x, 1);
    const w = await canvas.evaluate((c: HTMLCanvasElement) => c.width / (window.devicePixelRatio || 1));
    expect(w).toBeCloseTo(before + 32, 0);
  });

  for (const viewport of [{ width: 1400, height: 700 }, { width: 800, height: 700 }]) {
    test(`smart fit at ${viewport.width}px: header and rows share the allocated widths`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(openUrl(fixtures.basic));
      const grid = page.getByRole('grid', { name: 'Commit graph' });
      await expect(grid).toBeVisible();
      const clientWidth = await grid.evaluate((el) => el.clientWidth);
      const graphW = (await page.getByTestId('graph-canvas').boundingBox())!.width;
      const expected = allocateColumns({ ...DEFAULT_COLUMN_PREFS, graph: graphW }, clientWidth);
      const got = await columnWidths(page);
      for (const c of COLS) {
        expect(got[c].header, `${c} header`).toBeCloseTo(expected[c], 0);
        expect(got[c].cell, `${c} cell`).toBeCloseTo(expected[c], 0);
        expect(got[c].headerX, `${c} x`).toBeCloseTo(got[c].cellX, 0);
      }
      if (viewport.width === 1400) {
        // Plenty of room: Author and Date keep their preferred widths and Message flexes.
        expect(expected.author).toBe(DEFAULT_COLUMN_PREFS.author);
        expect(expected.date).toBe(DEFAULT_COLUMN_PREFS.date);
        expect(expected.message).toBeGreaterThan(COLUMN_MIN.message);
      } else {
        // Message is at its minimum and Author/Date have given up space, but not all of it.
        expect(expected.message).toBe(COLUMN_MIN.message);
        expect(expected.author).toBeLessThan(DEFAULT_COLUMN_PREFS.author);
        expect(expected.author).toBeGreaterThan(COLUMN_MIN.author);
        expect(expected.date).toBeLessThan(DEFAULT_COLUMN_PREFS.date);
        expect(expected.date).toBeGreaterThan(COLUMN_MIN.date);
        // Squeezed cells truncate with an ellipsis rather than wrapping or overflowing.
        for (const c of ['author', 'date']) {
          const style = await page.getByRole('row').first().locator(`[data-col="${c}"]`).evaluate((el) => [getComputedStyle(el).textOverflow, getComputedStyle(el).overflow]);
          expect(style).toEqual(['ellipsis', 'hidden']);
        }
      }
      // No horizontal scrolling while everything fits.
      expect(await grid.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    });
  }

  test('below the sum of minimums the table scrolls horizontally, header in sync, connector intact', async ({ page }) => {
    await page.setViewportSize({ width: 520, height: 700 });
    await page.goto(openUrl(fixtures.basic));
    const grid = page.getByRole('grid', { name: 'Commit graph' });
    await expect(grid).toBeVisible();
    const graphW = (await page.getByTestId('graph-canvas').boundingBox())!.width;
    const { scrollWidth, clientWidth } = await grid.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    const minTotal = allocateColumns({ ...DEFAULT_COLUMN_PREFS, graph: graphW }, 0).total;
    expect(scrollWidth).toBe(minTotal);
    expect(scrollWidth).toBeGreaterThan(clientWidth);

    await grid.evaluate((el) => { el.scrollLeft = 90; });
    // Wait for the scroll to reach the header (React re-renders from the scroll event).
    await expect.poll(async () => { const w = await columnWidths(page); return Math.round(w.message.headerX - w.message.cellX); }).toBe(0);
    expect((await columnWidths(page)).labels.cellX).toBeLessThan(0);
    const got = await columnWidths(page);
    for (const c of COLS) expect(got[c].headerX, `${c} x after scroll`).toBeCloseTo(got[c].cellX, 0);
    const [canvasBox, graphCell] = await Promise.all([page.getByTestId('graph-canvas').boundingBox(), page.getByRole('row').nth(4).locator('[data-col="graph"]').boundingBox()]);
    expect(canvasBox!.x).toBeCloseTo(graphCell!.x, 0);
    await expectConnectorMeetsCanvas(page);
  });

  test('squeezed Author/Date: the handle under the pointer moves 1:1, and Message is a wall', async ({ page }) => {
    // At 800 px Message is at its minimum and Author/Date are squeezed below their preferences.
    await page.setViewportSize({ width: 800, height: 700 });
    await page.goto(openUrl(fixtures.basic));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    const w = async () => columnWidths(page);
    const start = await w();
    expect(start.message.cell).toBeCloseTo(COLUMN_MIN.message, 0);
    expect(start.author.cell).toBeLessThan(DEFAULT_COLUMN_PREFS.author);

    // Author: widening hits the Message wall; narrowing moves its handle right 8 px and gives
    // Message the space, after which widening can take it back.
    const author = page.getByRole('separator', { name: 'Resize Author column' });
    await author.focus();
    await page.keyboard.press('ArrowLeft');
    expect((await w()).author.cell).toBe(start.author.cell);
    await page.keyboard.press('ArrowRight');
    let now = await w();
    expect([now.author.cell, now.message.cell]).toEqual([start.author.cell - 8, start.message.cell + 8]);
    expect(now.author.headerX).toBeCloseTo(start.author.headerX + 8, 0);
    await page.keyboard.press('ArrowLeft');
    now = await w();
    expect([now.author.cell, now.message.cell]).toEqual([start.author.cell, start.message.cell]);

    // Date: dragging its handle left 1 px at a time moves it exactly with the pointer,
    // taking the width out of Author, until Author is at its minimum.
    const date = page.getByRole('separator', { name: 'Resize Date column' });
    const box = (await date.boundingBox())!;
    const y = box.y + box.height / 2;
    const x0 = box.x + box.width / 2;
    const room = start.author.cell - COLUMN_MIN.author;
    await page.mouse.move(x0, y);
    await page.mouse.down();
    for (let d = 1; d <= room + 10; d++) {
      await page.mouse.move(x0 - d, y);
      const now = await w();
      expect(now.date.headerX, `date handle, d=${d}`).toBeCloseTo(start.date.headerX - Math.min(d, room), 0);
    }
    await page.mouse.up();
    expect((await w()).author.cell).toBeCloseTo(COLUMN_MIN.author, 0);

    // Author at its minimum, Message at its wall: dragging Author's handle left moves nothing.
    const before = await w();
    const abox = (await author.boundingBox())!;
    await page.mouse.move(abox.x + abox.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(abox.x + abox.width / 2 - 20, y, { steps: 4 });
    await page.mouse.up();
    expect((await w()).author.headerX).toBeCloseTo(before.author.headerX, 0);
    expect((await w()).author.cell).toBe(before.author.cell);
  });

  test('Branch/Tag widened in a wide window keeps its width after the window narrows (no snap-back)', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 700 });
    await page.goto(openUrl(fixtures.basic));
    const handle = page.getByRole('separator', { name: 'Resize Branch / Tag column' });
    const box = (await handle.boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 500, y, { steps: 10 });
    await page.mouse.up();
    await expect(handle).toHaveAttribute('aria-valuenow', '700');

    await page.setViewportSize({ width: 1000, height: 700 });
    await expect.poll(async () => page.getByRole('grid', { name: 'Commit graph' }).evaluate((el) => el.clientWidth)).toBeLessThan(1001);
    const max = Number(await handle.getAttribute('aria-valuemax'));
    expect(max).toBeGreaterThanOrEqual(700);
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', '700');
    const b2 = (await handle.boundingBox())!;
    await page.mouse.move(b2.x + b2.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(b2.x + b2.width / 2 + 1, y);
    await expect(handle).toHaveAttribute('aria-valuenow', '700');
    await page.mouse.move(b2.x + b2.width / 2 - 12, y, { steps: 3 });
    await page.mouse.up();
    await expect(handle).toHaveAttribute('aria-valuenow', '688');
    await expectConnectorMeetsCanvas(page);
  });

  test('the canvas is clipped to the scroll viewport (never over the vertical scrollbar)', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 300 });
    await page.goto(openUrl(fixtures.basic));
    const grid = page.getByRole('grid', { name: 'Commit graph' });
    await expect(grid).toBeVisible();
    const { clientWidth, clientHeight } = await grid.evaluate((el) => ({ clientWidth: el.clientWidth, clientHeight: el.clientHeight }));
    const clip = (await page.locator('.graph-canvas-clip').boundingBox())!;
    const gridBox = (await grid.boundingBox())!;
    expect(clip.x).toBeCloseTo(gridBox.x, 0);
    expect(clip.width).toBeCloseTo(clientWidth, 0);
    expect(clip.height).toBeCloseTo(clientHeight, 0);
    // The 300 px viewport makes the 10 rows overflow vertically, so there is a real scrollbar
    // to protect (unless the platform uses overlay scrollbars).
    expect(await page.locator('.graph-canvas-clip').evaluate((el) => getComputedStyle(el).overflow)).toBe('hidden');
  });
});

test.describe('graph column width', () => {
  test('at the default (auto) width, the Graph column fits every lane of a very wide graph', async ({ page }) => {
    await page.goto(openUrl(fixtures.wide));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    // The real lane count, straight from the backend (the same harness the page talks to).
    const maxLanes = await page.evaluate(async (path) => {
      const ws = new WebSocket('ws://127.0.0.1:7433/ws');
      let id = 0;
      const call = (req: unknown) => new Promise<{ ok?: Record<string, unknown>; err?: unknown }>((resolve) => {
        const my = ++id;
        ws.addEventListener('message', function on(e) {
          const msg = JSON.parse(String(e.data));
          if (msg.id !== my) return;
          ws.removeEventListener('message', on);
          resolve(msg);
        });
        ws.send(JSON.stringify({ id: my, req }));
      });
      await new Promise((r) => ws.addEventListener('open', r, { once: true }));
      const repo = await call({ method: 'openRepo', params: { path } });
      const graph = await call({ method: 'graph', params: { repo: repo.ok!.id, limit: null } });
      ws.close();
      return graph.ok!.maxLanes as number;
    }, fixtures.wide);
    expect(maxLanes).toBeGreaterThanOrEqual(30); // wider than the old 400 px cap (24 lanes)

    // No lane may be clipped: the canvas (CSS px and backing store) and the column fit them all.
    const need = maxLanes * METRICS.laneW + 2 * METRICS.padX;
    const canvas = page.getByTestId('graph-canvas');
    await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.width / (window.devicePixelRatio || 1))).toBeGreaterThanOrEqual(need);
    expect((await canvas.boundingBox())!.width).toBeGreaterThanOrEqual(need);
    expect((await page.locator('.graph-header [data-col="graph"]').boundingBox())!.width).toBeGreaterThanOrEqual(need);
  });
});
