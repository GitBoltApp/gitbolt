import { expect, test } from '@playwright/test';
import { STRIP_W } from '../src/graph/draw';
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
    // regardless of how many lanes the fixture happens to use. Row 0's vertical center is CSS
    // y=11 (rowH=22).
    const alpha = await page.getByTestId('graph-canvas').evaluate((c: HTMLCanvasElement, stripW: number) => {
      const rect = c.getBoundingClientRect();
      const dpr = c.width / rect.width;
      const x = Math.round(c.width - stripW * dpr - 2 * dpr);
      const y = Math.round(11 * dpr);
      return c.getContext('2d')!.getImageData(x, y, 1, 1).data[3];
    }, STRIP_W);
    expect(alpha).toBeGreaterThan(0);
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
