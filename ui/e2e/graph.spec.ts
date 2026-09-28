import { expect, test, type Page } from '@playwright/test';
import { SHORT_SHA_LEN } from '../src/format/sha';
import { allocateColumns, COLUMN_MIN, DEFAULT_COLUMN_PREFS, SHA_MAX } from '../src/graph/columns';
import { RAIL_W, STRIP_W } from '../src/graph/draw';
import { METRICS } from '../src/graph/metrics';
import { DENSITIES, DENSITY_METRICS, DENSITY_STORAGE_KEY } from '../src/theme/density';
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

  test('author, date and SHA are the same dimmed colour as the rest of the commit message (F10)', async ({ page }) => {
    await page.goto(openUrl(fixtures.longLabels));
    const row = page.getByRole('row').filter({ hasText: 'Initial commit' });
    const color = (loc: ReturnType<Page['locator']>) => loc.evaluate((el) => getComputedStyle(el).color);
    const body = await color(row.locator('.msg-body'));
    expect(body).not.toBe(await color(row.locator('.msg-summary')));
    expect(await color(row.locator('[data-col="author"]'))).toBe(body);
    expect(await color(row.locator('[data-col="date"]'))).toBe(body);
    expect(await color(row.getByTestId('sha'))).toBe(body);
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

  test('the chip-to-node connector is the lane colour at 25%, on the canvas and in the DOM (F8)', async ({ page }) => {
    // Row 4 is main's merge (lane 0, labeled). Sample the canvas connector left of the node.
    const px = await page.getByTestId('graph-canvas').evaluate((c: HTMLCanvasElement, rowH: number) => {
      const dpr = c.width / c.getBoundingClientRect().width;
      const d = c.getContext('2d')!.getImageData(Math.round(2 * dpr), Math.floor((4 * rowH + rowH / 2) * dpr), 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    }, METRICS.rowH);
    expect(px[3]).toBeGreaterThanOrEqual(56);
    expect(px[3]).toBeLessThanOrEqual(72);
    // The lane colour, give or take the rounding of premultiplied alpha at 25%.
    const lane = [1, 3, 5].map((i) => parseInt(GRAPH_COLORS[0].slice(i, i + 2), 16));
    for (let i = 0; i < 3; i++) expect(Math.abs(px[i] - lane[i]), `channel ${i}`).toBeLessThanOrEqual(4);
    const connector = page.getByRole('row').nth(4).locator('.ref-connector');
    expect(await connector.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.25');
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

  test('a chip stays expanded over its forge (remote) icon, whose tooltip names the remote and branch (F4, F9, H12)', async ({ page }) => {
    // Not the dimmed membership chip (F7), which names feature/login too on a hovered row below it.
    const chip = page.locator('.ref-labels > .ref-label:not(.ref-label-dim)', { hasText: 'feature/login' });
    await chip.hover();
    const full = page.locator('.ref-label-full');
    await expect(full).toBeVisible();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    const cloud = full.locator('.ref-icon', { has: page.locator('[aria-label="remote origin"]') });
    const box = (await cloud.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await expect(full).toBeVisible();
    await expect(page.getByRole('tooltip')).toHaveText('origin → feature/login (Remote)');
    const local = full.locator('.ref-icon', { has: page.locator('[aria-label="local"]') });
    await local.hover();
    await expect(page.getByRole('tooltip')).toHaveText('feature/login (Local)');
  });

  test('source-icon tooltips show at once, even when the pointer lands straight on the icon; the remote name stands out, the branch is dimmed (H12)', async ({ page }) => {
    const chip = page.locator('.ref-labels > .ref-label:not(.ref-label-dim)', { hasText: 'feature/login' });
    const cloud = chip.locator(':scope > .ref-icon', { has: page.locator('[aria-label="remote origin"]') });
    const box = (await cloud.boundingBox())!;
    // One move, from outside the chip straight onto its cloud icon; then the pointer rests.
    await page.mouse.move(box.x + box.width / 2, box.y - 40);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const tip = page.getByRole('tooltip');
    await expect(tip).toHaveText('origin → feature/login (Remote)', { timeout: 50 });
    const colour = (sel: string) => tip.locator(sel).evaluate((el) => getComputedStyle(el).color);
    const [remote, branch] = [await colour('.ref-tip-remote'), await colour('.ref-tip-branch')];
    expect(remote).not.toBe(branch);
    expect(alphaOf(remote)).toBeGreaterThan(alphaOf(branch));
    // Still there once the chip has expanded under the resting pointer.
    await page.waitForTimeout(300);
    await expect(tip).toHaveText('origin → feature/login (Remote)');
    await expect(tip).toHaveCount(1);
  });

  test('pointer cursors on rows and chips; the chips column\'s empty space is inert (F5, F6)', async ({ page }) => {
    const rows = page.getByRole('row');
    const cursor = (loc: ReturnType<Page['locator']>) => loc.evaluate((el) => getComputedStyle(el).cursor);
    // The row with the real chip, not a hovered row showing the dimmed membership chip (F7).
    const labeled = rows.filter({ has: page.locator('.ref-label:not(.ref-label-dim)', { hasText: 'feature/login' }) });
    const plain = rows.filter({ hasText: 'Login form' });
    expect(await cursor(plain.locator('[data-col="message"]'))).toBe('pointer');
    expect(await cursor(plain.locator('[data-col="graph"]'))).toBe('pointer');
    expect(await cursor(plain.locator('[data-col="labels"]'))).toBe('default');
    expect(await cursor(labeled.locator('.ref-label').first())).toBe('pointer');
    expect(await cursor(page.getByTestId('sha').first())).toBe('pointer');
    expect(await cursor(page.getByRole('separator', { name: 'Resize Graph column' }))).toBe('col-resize');

    await plain.locator('[data-col="author"]').click();
    await expect(plain).toHaveAttribute('aria-selected', 'true');
    // Empty chip-cell space, on a row without chips and beside a chip: nothing changes.
    // (An empty labels cell is 0 px tall, so aim by the row's box.)
    const typoRow = (await rows.filter({ hasText: 'Fix typo' }).boundingBox())!;
    await page.mouse.click(typoRow.x + 20, typoRow.y + typoRow.height / 2);
    const labeledRow = (await labeled.boundingBox())!;
    const chipBox = (await labeled.locator('.ref-labels > .ref-label').boundingBox())!;
    await page.mouse.click(chipBox.x + 2, labeledRow.y + 2);
    await expect(plain).toHaveAttribute('aria-selected', 'true');
    await expect(labeled).toHaveAttribute('aria-selected', 'false');
    // The chip itself selects its row, and the graph cell of any row does too.
    await labeled.locator('.ref-labels > .ref-label').click();
    await expect(labeled).toHaveAttribute('aria-selected', 'true');
    // On the node (the graph column's first lane; the cell itself is empty and 0 px tall).
    const graphX = (await page.locator('.graph-header [data-col="graph"]').boundingBox())!.x;
    await page.mouse.click(graphX + METRICS.padX, typoRow.y + typoRow.height / 2);
    await expect(rows.filter({ hasText: 'Fix typo' })).toHaveAttribute('aria-selected', 'true');
  });

  test('a hovered or selected commit below its branch tip shows a dimmed chip naming the branch (F7)', async ({ page }) => {
    const rows = page.getByRole('row');
    const dim = (text: string) => rows.filter({ hasText: text }).locator('.ref-label-dim');
    await expect(page.locator('.ref-label-dim')).toHaveCount(0);
    await rows.filter({ hasText: 'Login form' }).locator('[data-col="message"]').hover();
    await expect(dim('Login form')).toHaveText('feature/login');
    expect(await dim('Login form').evaluate((el) => getComputedStyle(el).opacity)).toBe('0.5');
    await rows.filter({ hasText: 'Fix typo' }).locator('[data-col="author"]').hover();
    await expect(dim('Login form')).toHaveCount(0);
    await expect(dim('Fix typo')).toHaveText('main');
    // The tip of a branch has its own chip and gets none.
    await rows.filter({ hasText: 'Login validation' }).locator('[data-col="author"]').hover();
    await expect(page.locator('.ref-label-dim')).toHaveCount(0);
    // Selected: stays while the pointer is elsewhere.
    await rows.filter({ hasText: 'Initial commit' }).locator('[data-col="author"]').click();
    await page.locator('.graph-header [data-col="message"]').hover();
    await expect(dim('Initial commit')).toHaveText('main');
    await expect(page.locator('.ref-label-dim')).toHaveCount(1);
  });

  test('a row with chips that aren\'t its branch\'s tip gets the dimmed chip after them, dropped whole when it doesn\'t fit (F7)', async ({ page }) => {
    // "Add readme" carries only the v1.0 tag; it's on main.
    const row = page.getByRole('row').filter({ hasText: 'Add readme' });
    const tagChip = row.locator('.ref-labels > .ref-label').first();
    await expect(tagChip).toHaveText('v1.0');
    const tagBefore = (await tagChip.boundingBox())!;
    await row.locator('[data-col="message"]').hover();
    const dim = row.locator('.ref-dim-slot .ref-label-dim');
    await expect(dim).toHaveText('main');
    const [slot, dimBox] = [(await row.locator('.ref-dim-slot').boundingBox())!, (await dim.boundingBox())!];
    // On the slot's (only visible) line, after the tag chip; the tag chip didn't move or shrink.
    expect(dimBox.y).toBeGreaterThanOrEqual(slot.y - 0.5);
    expect(dimBox.x).toBeGreaterThan(tagBefore.x + tagBefore.width);
    expect(await tagChip.boundingBox()).toEqual(tagBefore);
    await expectConnectorMeetsCanvas(page, row);

    // Narrow the Branch/Tag column to its minimum: the dimmed chip is dropped (wrapped onto the
    // slot's hidden line), the tag chip keeps its full width, and the line to the node is intact.
    const handle = page.getByRole('separator', { name: 'Resize Branch / Tag column' });
    await handle.focus();
    for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', String(COLUMN_MIN.labels));
    // Selected, so it stays shown without the pointer on the row.
    await row.locator('[data-col="author"]').click();
    await page.locator('.graph-header [data-col="message"]').hover();
    await expect(dim).toHaveCount(1);
    const narrowSlot = (await row.locator('.ref-dim-slot').boundingBox())!;
    const narrowDim = (await dim.boundingBox())!;
    expect(narrowDim.y).toBeGreaterThanOrEqual(narrowSlot.y + narrowSlot.height);
    expect((await tagChip.boundingBox())!.width).toBeCloseTo(tagBefore.width, 1);
    await expectConnectorMeetsCanvas(page, row);
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
    // The branch name itself shows no tooltip (F9); only the source icons have one.
    await expect(page.getByRole('tooltip')).toHaveCount(0);

    await page.locator('.graph-header [data-col="message"]').hover();
    await expect(full).toHaveCount(0);
    await expectConnectorMeetsCanvas(page);
  });

  test('the expanded chip stays expanded all the way to its revealed icon, whose tooltip names the branch (F4, F9)', async ({ page }) => {
    const chip = page.locator('.ref-labels > .ref-label').first();
    await chip.hover();
    const full = page.locator('.ref-label-full');
    await expect(full).toBeVisible();
    const chipBox = (await chip.boundingBox())!;
    const icon = full.locator('.ref-icon').last();
    const iconBox = (await icon.boundingBox())!;
    // The local icon is in the part of the copy that sticks out past the resting chip (and
    // over the +N badge and the canvas).
    expect(iconBox.x).toBeGreaterThan(chipBox.x + chipBox.width);
    // Horizontally, at the chip's height, across the whole revealed part: never collapses.
    const y = chipBox.y + chipBox.height / 2;
    for (let x = chipBox.x + chipBox.width - 2; x <= iconBox.x + iconBox.width / 2; x += 12) {
      await page.mouse.move(x, y);
      await expect(full, `x=${x}`).toBeVisible();
    }
    await page.mouse.move(iconBox.x + iconBox.width / 2, y);
    await expect(full).toBeVisible();
    await expect(page.getByRole('tooltip')).toHaveText(/^feature\/this-is-an-extremely-long-branch-name.*commit-graph-ui \(Local\)$/);
    // Leaving the copy's bounds (just below it) collapses it.
    const fullBox = (await full.boundingBox())!;
    await page.mouse.move(iconBox.x + iconBox.width / 2, fullBox.y + fullBox.height + 3);
    await expect(full).toHaveCount(0);
    await expectConnectorMeetsCanvas(page);
  });

  test('the +N badge and its tooltip are reached from outside the chip', async ({ page }) => {
    const more = page.locator('.ref-more');
    const box = (await more.boundingBox())!;
    // Up from the row below, straight onto the badge: the chip never expands over it.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 25);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await expect(page.locator('.ref-label-full')).toHaveCount(0);
    await expect(page.getByRole('tooltip')).toHaveText('also-tagged-here');
  });

  test('the message tooltip sits right of the cursor, ignores the pointer, and is gone on the next row (F1)', async ({ page }) => {
    const cells = page.getByRole('row').locator('[data-col="message"]');
    const second = (await cells.nth(1).boundingBox())!;
    const x = second.x + 40, y = second.y + second.height / 2;
    await page.mouse.move(x, y);
    const tip = page.getByRole('tooltip');
    await expect(tip.locator('.msg-tooltip-summary')).toHaveText('Initial commit');
    const box = (await tip.boundingBox())!;
    expect(box.x - x).toBeGreaterThanOrEqual(11);
    expect(box.x - x).toBeLessThanOrEqual(13);
    expect(Math.abs(box.y - y)).toBeLessThanOrEqual(1);
    expect(await tip.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
    // Hit-testing inside the tooltip finds the row beneath it, never the tooltip.
    const hit = await page.evaluate(([hx, hy]) => !!document.elementFromPoint(hx, hy)?.closest('[role="tooltip"]'), [box.x + 5, box.y + 5]);
    expect(hit).toBe(false);
    // Follows the pointer along the message.
    await page.mouse.move(x + 30, y);
    await expect.poll(async () => Math.round((await tip.boundingBox())!.x - (x + 30))).toBe(12);
    // Up onto the other row: gone right away (well before that row's own ~500 ms delay).
    await page.mouse.move(x + 30, y - second.height, { steps: 2 });
    await expect(tip).toHaveCount(0, { timeout: 300 });
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

/** A computed colour's alpha: `rgba(…, a)`, `color(srgb … / a)`, or 1 when it has none. */
const alphaOf = (c: string) => {
  if (c === 'transparent') return 0;
  const m = /\/\s*([\d.]+)\s*\)$/.exec(c) ?? /rgba\((?:[^,]+,){3}\s*([\d.]+)\)/.exec(c);
  return m ? Number(m[1]) : 1;
};

test.describe('row and chip states (H3, H4, H5, H14)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(openUrl(fixtures.basic));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
  });
  const bg = (loc: ReturnType<Page['locator']>) => loc.evaluate((el) => getComputedStyle(el).backgroundColor);
  const fg = (loc: ReturnType<Page['locator']>) => loc.evaluate((el) => getComputedStyle(el).color);

  test('chips rest subdued (lane colour at 25%, normal text) and light up while their row is hovered or selected (H3)', async ({ page }) => {
    const row = page.getByRole('row').filter({ has: page.locator('.ref-labels > .ref-label', { hasText: 'feature/login' }) });
    const chip = row.locator('.ref-labels > .ref-label').first();
    await page.locator('.graph-header [data-col="message"]').hover();
    expect(alphaOf(await bg(chip))).toBeCloseTo(0.25, 2);
    const rest = await fg(chip);
    await row.locator('[data-col="message"]').hover();
    expect(alphaOf(await bg(chip))).toBeCloseTo(0.45, 2);
    expect(await fg(chip)).not.toBe(rest);
    // Selected, with the pointer elsewhere: still lit.
    await row.locator('[data-col="author"]').click();
    await page.locator('.graph-header [data-col="message"]').hover();
    expect(alphaOf(await bg(chip))).toBeCloseTo(0.45, 2);
    // Another row's chip, neither hovered nor selected, rests.
    const other = page.getByRole('row').nth(4).locator('.ref-labels > .ref-label').first();
    expect(alphaOf(await bg(other))).toBeCloseTo(0.25, 2);
  });

  test('the selected row: blue only behind the text columns, brighter author/date/SHA, a brighter graph band (H14)', async ({ page }) => {
    const rows = page.getByRole('row');
    const row = rows.filter({ hasText: 'Fix typo' });
    const other = rows.filter({ hasText: 'Login form' });
    const dimAuthor = await fg(row.locator('[data-col="author"]'));
    await row.locator('[data-col="author"]').click();
    await page.locator('.graph-header [data-col="message"]').hover();
    await expect(row).toHaveAttribute('aria-selected', 'true');
    expect(alphaOf(await bg(row))).toBe(0);
    expect(alphaOf(await bg(row.locator('[data-col="labels"]')))).toBe(0);
    expect(alphaOf(await bg(row.locator('[data-col="graph"]')))).toBe(0);
    const rowBox = (await row.boundingBox())!;
    for (const col of ['message', 'author', 'date', 'sha']) {
      const cell = row.locator(`[data-col="${col}"]`);
      expect(alphaOf(await bg(cell)), col).toBeCloseTo(0.2, 2);
      // Full row height, so the four read as one band.
      expect((await cell.boundingBox())!.height, col).toBeCloseTo(rowBox.height, 1);
    }
    expect(alphaOf(await bg(other.locator('[data-col="message"]')))).toBe(0);
    // Brighter than the same cells unselected.
    for (const loc of [row.locator('[data-col="author"]'), row.locator('[data-col="date"]'), row.getByTestId('sha')]) {
      expect(alphaOf(await fg(loc))).toBeGreaterThan(alphaOf(dimAuthor));
    }
    expect(await fg(other.locator('[data-col="author"]'))).toBe(dimAuthor);
    // The canvas band, just left of the rail, at each row's centre: the selected one is brighter.
    const index = Number(await row.getAttribute('aria-rowindex')) - 1;
    const otherIndex = Number(await other.getAttribute('aria-rowindex')) - 1;
    const [sel, rest] = await page.getByTestId('graph-canvas').evaluate((c: HTMLCanvasElement, [rowH, a, b, railW]: number[]) => {
      const dpr = c.width / c.getBoundingClientRect().width;
      const ctx = c.getContext('2d')!;
      const x = c.width - Math.max(1, Math.round(railW * dpr)) - Math.round(2 * dpr);
      return [a, b].map((i) => ctx.getImageData(x, Math.floor((i * rowH + rowH / 2) * dpr), 1, 1).data[3]);
    }, [METRICS.rowH, index, otherIndex, RAIL_W]);
    expect(sel).toBeGreaterThan(2 * rest);
  });

  test('no per-panel focus visuals: no outline, and the selection stays blue whichever panel has focus (H4)', async ({ page }) => {
    const grid = page.getByRole('grid', { name: 'Commit graph' });
    const row = page.getByRole('row').filter({ hasText: 'Fix typo' });
    await row.locator('[data-col="author"]').click();
    await expect(grid).toHaveAttribute('data-zone-focused', 'true');
    const outline = (loc: ReturnType<Page['locator']>) => loc.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(await outline(grid)).toBe('none');
    const cell = row.locator('[data-col="message"]');
    const blue = await bg(cell);
    expect(alphaOf(blue)).toBeCloseTo(0.2, 2);
    // → moves focus to the file list (no diff is open, so none opens).
    await page.keyboard.press('ArrowRight');
    await expect(grid).toHaveAttribute('data-zone-focused', 'false');
    const files = page.locator('[data-focus-zone="files"]');
    await expect(files).toHaveAttribute('data-zone-focused', 'true');
    expect(await outline(files)).toBe('none');
    expect(await bg(cell)).toBe(blue);
    await page.keyboard.press('ArrowLeft');
    await expect(grid).toHaveAttribute('data-zone-focused', 'true');
    expect(await bg(cell)).toBe(blue);
  });

  test('every clickable thing in the table has the pointer cursor (H5)', async ({ page }) => {
    const cursor = (loc: ReturnType<Page['locator']>) => loc.evaluate((el) => getComputedStyle(el).cursor);
    const rows = page.getByRole('row');
    for (const i of [0, 3, 4]) {
      for (const col of ['graph', 'message', 'author', 'date', 'sha']) expect(await cursor(rows.nth(i).locator(`[data-col="${col}"]`)), `${i} ${col}`).toBe('pointer');
    }
    const chip = page.locator('.ref-labels > .ref-label:not(.ref-label-dim)', { hasText: 'feature/login' });
    expect(await cursor(chip)).toBe('pointer');
    expect(await cursor(chip.locator('.ref-icon').first())).toBe('pointer');
    await chip.hover();
    const full = page.locator('.ref-label-full');
    expect(await cursor(full)).toBe('pointer');
    expect(await cursor(full.locator('.ref-icon').first())).toBe('pointer');
    expect(await cursor(page.getByTestId('sha').first())).toBe('pointer');
    await page.goto(openUrl(fixtures.longLabels));
    expect(await cursor(page.locator('.ref-more'))).toBe('pointer');
  });
});

test.describe('display density (H1)', () => {
  for (const d of DENSITIES) {
    test(`${d}: rows, chips and canvas share its metrics, and the connector stays continuous`, async ({ page }) => {
      await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [DENSITY_STORAGE_KEY, d]);
      await page.goto(openUrl(fixtures.basic));
      await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
      const m = DENSITY_METRICS[d];
      const rows = page.getByRole('row');
      expect((await rows.first().boundingBox())!.height).toBe(m.rowH);
      // Row 4: main's merge (lane 0), labeled. Its chip is the density's height, centred in the
      // row, and the DOM connector sits on the row's centre line, like the canvas's.
      const row = (await rows.nth(4).boundingBox())!;
      const chip = (await rows.nth(4).locator('.ref-labels > .ref-label').first().boundingBox())!;
      expect(chip.height).toBeCloseTo(m.chipH, 1);
      expect(Math.abs(chip.y + chip.height / 2 - (row.y + row.height / 2))).toBeLessThanOrEqual(0.5);
      const conn = (await rows.nth(4).locator('.ref-connector').boundingBox())!;
      expect(Math.abs(conn.y + conn.height / 2 - (row.y + row.height / 2))).toBeLessThanOrEqual(0.5);
      await expectConnectorMeetsCanvas(page, rows.nth(4));
      // The canvas: the connector left of the node on the centre line, and the row's band and
      // rail inset by the density's bandInset (chip-high at standard). Sampled on the rail, at the
      // canvas's last device pixel column: no lane line ever gets there.
      const px = await page.getByTestId('graph-canvas').evaluate((c: HTMLCanvasElement, [rowH, inset]: number[]) => {
        const dpr = c.width / c.getBoundingClientRect().width;
        const ctx = c.getContext('2d')!;
        const a = (x: number, y: number) => ctx.getImageData(x, Math.floor(y * dpr), 1, 1).data[3];
        return { connector: a(Math.round(2 * dpr), 4 * rowH + rowH / 2), bandIn: a(c.width - 1, 4 * rowH + inset + 0.5), bandOut: a(c.width - 1, 4 * rowH + inset - 1) };
      }, [m.rowH, m.bandInset]);
      expect(px.connector).toBeGreaterThan(0);
      expect(px.bandIn).toBeGreaterThan(0);
      expect(px.bandOut).toBe(0);
    });
  }
});

/** Asserts the DOM label connector ends exactly where the canvas begins (the continuity rule). */
async function expectConnectorMeetsCanvas(page: Page, row?: ReturnType<Page['locator']>) {
  const connector = (row ?? page).locator('.ref-connector').first();
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
    // It starts at its lanes' width, its max (F2): narrow it (64 -> 48, its minimum).
    for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await canvas.boundingBox())!.width).toBe(before - 16);
    const graphCell = (await page.getByRole('row').first().locator('[data-col="graph"]').boundingBox())!;
    expect((await canvas.boundingBox())!.x).toBeCloseTo(graphCell.x, 1);
    const w = await canvas.evaluate((c: HTMLCanvasElement) => c.width / (window.devicePixelRatio || 1));
    expect(w).toBeCloseTo(before - 16, 0);
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

  test('each column\'s right-edge handle resizes that column, staying under the pointer (F3)', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 700 });
    await page.goto(openUrl(fixtures.basic));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    const w = async () => columnWidths(page);
    const right = (c: { headerX: number; header: number }) => c.headerX + c.header;
    // Graph starts at its lanes' width (its max, F2), so it's dragged left; the others right.
    // Date is dragged left (SHA takes the width; rightward SHA could give only 5 px).
    for (const [name, col, dx] of [['Branch / Tag', 'labels', 30], ['Graph', 'graph', -12], ['Commit message', 'message', 30], ['Author', 'author', 30], ['Date', 'date', -30]] as const) {
      const handle = page.getByRole('separator', { name: `Resize ${name} column` });
      const before = await w();
      // The handle sits on the column's right edge.
      const box = (await handle.boundingBox())!;
      expect(box.x + box.width / 2, `${col} handle on its right edge`).toBeCloseTo(right(before[col]), 0);
      const y = box.y + box.height / 2, x0 = box.x + box.width / 2;
      await page.mouse.move(x0, y);
      await page.mouse.down();
      for (let d = Math.sign(dx); Math.abs(d) <= Math.abs(dx); d += Math.sign(dx) * 3) {
        await page.mouse.move(x0 + d, y);
        const now = await w();
        expect(right(now[col]), `${col} right edge, d=${d}`).toBeCloseTo(right(before[col]) + d, 0);
        expect(now[col].cell, `${col} width, d=${d}`).toBeCloseTo(before[col].cell + d, 0);
      }
      await page.mouse.up();
    }
  });

  test('SHA: shows the app-wide 6 characters by default; Date\'s handle trades with it between 6 whole hex characters and all 40, walls holding (F3 review, H15)', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 700 });
    await page.goto(openUrl(fixtures.basic));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    await expect(page.locator('.graph-header [data-col="sha"] [role="separator"]')).toHaveCount(0);
    const sha = page.getByTestId('sha').first();
    /** Whole characters the SHA button shows: its width in `ch` of its own font. */
    const shown = () => sha.evaluate((el) => {
      const probe = document.createElement('span');
      probe.style.font = getComputedStyle(el).font;
      probe.style.position = 'absolute';
      probe.textContent = '0';
      document.body.appendChild(probe);
      const ch = probe.getBoundingClientRect().width;
      probe.remove();
      return el.getBoundingClientRect().width / ch;
    });
    expect(await sha.textContent()).toHaveLength(40);
    const press = async (name: string, key: string, n: number) => {
      await page.getByRole('separator', { name: `Resize ${name} column` }).focus();
      for (let i = 0; i < n; i++) await page.keyboard.press(key);
    };
    // The default is the minimum: exactly SHORT_SHA_LEN characters, as in the details panel.
    const start = await columnWidths(page);
    expect(start.sha.cell).toBeCloseTo(COLUMN_MIN.sha, 0);
    expect(await shown()).toBeCloseTo(SHORT_SHA_LEN, 1);
    // Minimum: Date can't grow into SHA below it (no fallback to Message either).
    await press('Date', 'ArrowRight', 5);
    let w = await columnWidths(page);
    expect(w.sha.cell).toBeCloseTo(COLUMN_MIN.sha, 0);
    expect(w.date.cell).toBeCloseTo(start.date.cell, 0);
    expect(w.message.cell).toBeCloseTo(start.message.cell, 0);
    expect(await shown()).toBeCloseTo(SHORT_SHA_LEN, 1);
    // Maximum: make Date wide (Message -> Author -> Date), then give SHA all of it it can take.
    await press('Commit message', 'ArrowLeft', 40);
    await press('Author', 'ArrowLeft', 60);
    await press('Date', 'ArrowLeft', 60);
    w = await columnWidths(page);
    expect(w.sha.cell).toBeCloseTo(SHA_MAX, 0);
    expect(await shown()).toBeCloseTo(40, 1);
    // The table still ends where it did: SHA's right edge is the table's end.
    expect(w.sha.headerX + w.sha.header).toBeCloseTo(start.sha.headerX + start.sha.header, 0);
  });

  test('the old F3 bug: dragging Author\'s right edge resizes Author (and Date), not the commit message', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 700 });
    await page.goto(openUrl(fixtures.basic));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    const start = await columnWidths(page);
    const handle = page.getByRole('separator', { name: 'Resize Author column' });
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    const now = await columnWidths(page);
    expect(now.author.cell).toBeCloseTo(start.author.cell + 40, 0);
    expect(now.date.cell).toBeCloseTo(start.date.cell - 40, 0);
    expect(now.message.cell).toBeCloseTo(start.message.cell, 0);
  });

  test('squeezed Author/Date: the handle under the pointer moves 1:1, and walls hold', async ({ page }) => {
    // At 800 px Message is at its minimum and Author/Date are squeezed below their preferences.
    await page.setViewportSize({ width: 800, height: 700 });
    await page.goto(openUrl(fixtures.basic));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    const w = async () => columnWidths(page);
    const start = await w();
    expect(start.message.cell).toBeCloseTo(COLUMN_MIN.message, 0);
    expect(start.author.cell).toBeLessThan(DEFAULT_COLUMN_PREFS.author);

    // Commit message: narrowing hits its own minimum (a wall); widening moves its right edge
    // 8 px out of Author, after which narrowing gives it back.
    const message = page.getByRole('separator', { name: 'Resize Commit message column' });
    await message.focus();
    await page.keyboard.press('ArrowLeft');
    expect((await w()).message.cell).toBe(start.message.cell);
    await page.keyboard.press('ArrowRight');
    let now = await w();
    expect([now.author.cell, now.message.cell]).toEqual([start.author.cell - 8, start.message.cell + 8]);
    expect(now.author.headerX).toBeCloseTo(start.author.headerX + 8, 0);
    await page.keyboard.press('ArrowLeft');
    now = await w();
    expect([now.author.cell, now.message.cell]).toEqual([start.author.cell, start.message.cell]);

    // Author: dragging its right edge left 1 px at a time moves it exactly with the pointer,
    // giving the width to Date, until Author is at its minimum.
    const author = page.getByRole('separator', { name: 'Resize Author column' });
    const box = (await author.boundingBox())!;
    const y = box.y + box.height / 2;
    const x0 = box.x + box.width / 2;
    const room = start.author.cell - COLUMN_MIN.author;
    await page.mouse.move(x0, y);
    await page.mouse.down();
    for (let d = 1; d <= room + 10; d++) {
      await page.mouse.move(x0 - d, y);
      const now = await w();
      expect(now.date.headerX, `author's right edge, d=${d}`).toBeCloseTo(start.date.headerX - Math.min(d, room), 0);
    }
    await page.mouse.up();
    expect((await w()).author.cell).toBeCloseTo(COLUMN_MIN.author, 0);
    expect((await w()).message.cell).toBeCloseTo(COLUMN_MIN.message, 0);
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

/** The canvas pixel inside the overflow strip (clear of the 2 px rail) at row `row`'s center. */
async function stripPixel(page: Page, row: number) {
  return page.getByTestId('graph-canvas').evaluate((c: HTMLCanvasElement, [stripW, railW, rowH, r]: number[]) => {
    const dpr = c.width / c.getBoundingClientRect().width;
    const d = c.getContext('2d')!.getImageData(Math.round(c.width - ((stripW + railW) / 2) * dpr), Math.round((r * rowH + rowH / 2) * dpr), 1, 1).data;
    return { a: d[3], hex: '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('') };
  }, [STRIP_W, RAIL_W, METRICS.rowH, row]);
}

test.describe('graph column width', () => {
  test('the dark overflow strip shows only while the lanes don\'t fit the Graph column (F2)', async ({ page }) => {
    await page.goto(openUrl(fixtures.basic));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    const canvas = page.getByTestId('graph-canvas');
    await expect(canvas).toHaveAttribute('data-clipped', 'false');
    // Fits: the strip's area is just the row band (translucent lane colour), not a solid panel.
    expect((await stripPixel(page, 4)).a).toBeLessThan(128);
    const handle = page.getByRole('separator', { name: 'Resize Graph column' });
    await handle.focus();
    for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', String(COLUMN_MIN.graph));
    await expect(canvas).toHaveAttribute('data-clipped', 'true');
    // Cut off: a solid panel in the app background, on every row.
    const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-bg0').trim().toLowerCase());
    await expect.poll(async () => (await stripPixel(page, 4)).a).toBe(255);
    for (const r of [0, 4, 7]) expect((await stripPixel(page, r)).hex, `row ${r}`).toBe(bg);
    // Widened back to its lanes: gone again.
    for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
    await expect(canvas).toHaveAttribute('data-clipped', 'false');
    await expect.poll(async () => (await stripPixel(page, 4)).a).toBeLessThan(128);
  });

  test('the Graph column can\'t be dragged wider than every lane plus padding (F2)', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 700 });
    await page.goto(openUrl(fixtures.basic));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    const handle = page.getByRole('separator', { name: 'Resize Graph column' });
    const max = Number(await handle.getAttribute('aria-valuemax'));
    await expect(handle).toHaveAttribute('aria-valuenow', String(max));
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(handle).toHaveAttribute('aria-valuenow', String(max));
    expect((await page.getByTestId('graph-canvas').boundingBox())!.width).toBeCloseTo(max, 0);
    await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-clipped', 'false');
  });


  test('at the default (auto) width, the Graph column fits every lane of a very wide graph', async ({ page }) => {
    await page.goto(openUrl(fixtures.wide));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    // The real lane count, straight from the backend (the same harness the page talks to).
    // Harness port follows GITBOLT_E2E_PORT_BASE (see playwright.config.ts), so this stays correct
    // when several `just e2e` runs share a machine on different port bases.
    const harnessPort = process.env.GITBOLT_E2E_PORT_BASE ? Number(process.env.GITBOLT_E2E_PORT_BASE) : 7433;
    const maxLanes = await page.evaluate(async ({ path, harnessPort }) => {
      const ws = new WebSocket(`ws://127.0.0.1:${harnessPort}/ws`);
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
    }, { path: fixtures.wide, harnessPort });
    expect(maxLanes).toBeGreaterThanOrEqual(30); // wider than the old 400 px cap (24 lanes)

    // No lane may be clipped: the canvas (CSS px and backing store) and the column fit them all.
    const need = maxLanes * METRICS.laneW + 2 * METRICS.padX;
    const canvas = page.getByTestId('graph-canvas');
    await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.width / (window.devicePixelRatio || 1))).toBeGreaterThanOrEqual(need);
    expect((await canvas.boundingBox())!.width).toBeGreaterThanOrEqual(need);
    expect((await page.locator('.graph-header [data-col="graph"]').boundingBox())!.width).toBeGreaterThanOrEqual(need);
  });
});
