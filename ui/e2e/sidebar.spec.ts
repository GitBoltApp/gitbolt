import type { Page } from '@playwright/test';
import { fixtures, openUrl } from './fixtures';
import { expect, test } from './test';

const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Sidebar', exact: true });
const panel = (page: Page, name: string) => sidebar(page).getByRole('region', { name, exact: true });
const count = (page: Page, name: string) => panel(page, name).getByLabel(`${name} count`);
const item = (page: Page, panelName: string, name: string, exact = true) => panel(page, panelName).getByRole('treeitem', { name, exact });
const height = async (page: Page, name: string) => (await panel(page, name).boundingBox())!.height;

test.describe('sidebar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(openUrl(fixtures.basic));
    await expect(panel(page, 'Local').getByRole('tree')).toBeVisible();
  });

  test('stacks a panel per section with counts, nesting branches by "/"', async ({ page }) => {
    await expect(sidebar(page).getByRole('region')).toHaveCount(5);
    await expect(count(page, 'Local')).toHaveText('3');
    await expect(count(page, 'Remote')).toHaveText('2');
    await expect(count(page, 'Worktrees')).toHaveText('2');
    await expect(count(page, 'Stashes')).toHaveText('1');
    await expect(count(page, 'Tags')).toHaveText('1');
    await expect(item(page, 'Local', 'feature/login')).toBeVisible();
    await expect(item(page, 'Local', 'main').getByLabel('current branch')).toBeVisible();
    // The checked-out branch's row is green (not the blue selection tint).
    await expect(item(page, 'Local', 'main')).toHaveCSS('background-color', 'rgb(55, 86, 62)');
    // Each panel scrolls on its own: the Tags header is on screen without scrolling past Local.
    await expect(panel(page, 'Tags')).toBeInViewport();
  });

  test('the filter filters every panel; counts follow it; Esc clears', async ({ page }) => {
    await page.keyboard.press('Control+Alt+f');
    await expect(page.getByLabel('Filter branches')).toBeFocused();
    await page.keyboard.type('login');
    await expect(count(page, 'Local')).toHaveText('1');
    await expect(count(page, 'Remote')).toHaveText('1');
    await expect(count(page, 'Tags')).toHaveText('0');
    await expect(panel(page, 'Tags').getByText('No matches')).toBeVisible();
    await expect(item(page, 'Local', 'hotfix')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(count(page, 'Local')).toHaveText('3');
  });

  test('sort toggle flattens a panel; folder collapse persists across reload', async ({ page }) => {
    await panel(page, 'Local').getByRole('button', { name: 'Sort Local: tree' }).click();
    await expect(panel(page, 'Local').getByRole('button', { name: 'Sort Local: recent' })).toBeVisible();
    await panel(page, 'Local').getByRole('button', { name: 'Sort Local: recent' }).click();
    const folder = panel(page, 'Local').locator('.sb-folder').filter({ hasText: 'feature' }).first();
    await folder.click();
    await expect(folder).toHaveAttribute('aria-expanded', 'false');
    await page.evaluate(() => window.__gb!.flush());
    await page.reload();
    await expect(panel(page, 'Local').locator('.sb-folder').filter({ hasText: 'feature' }).first()).toHaveAttribute('aria-expanded', 'false');
  });

  test('a collapsed panel shrinks to its header in place and the others take its space; it persists', async ({ page }) => {
    const before = await height(page, 'Local');
    await panel(page, 'Remote').getByRole('button', { name: 'Remote', exact: true }).click();
    await expect(panel(page, 'Remote').getByRole('tree')).toHaveCount(0);
    expect(await height(page, 'Remote')).toBeLessThan(40);
    expect(await height(page, 'Local')).toBeGreaterThan(before);
    // Still between Local and Worktrees.
    const [l, r, w] = await Promise.all(['Local', 'Remote', 'Worktrees'].map(async (n) => (await panel(page, n).boundingBox())!.y));
    expect(l).toBeLessThan(r);
    expect(r).toBeLessThan(w);
    await page.evaluate(() => window.__gb!.flush());
    await page.reload();
    await expect(panel(page, 'Local').getByRole('tree')).toBeVisible();
    await expect(panel(page, 'Remote').getByRole('tree')).toHaveCount(0);
  });

  test('dragging a divider trades height between neighbours; arrow keys too; heights persist', async ({ page }) => {
    // Collapse the rest so Local and Remote have room to trade.
    for (const n of ['Worktrees', 'Stashes', 'Tags']) await panel(page, n).getByRole('button', { name: n, exact: true }).click();
    const sep = sidebar(page).getByRole('separator', { name: 'Resize Local and Remote' });
    const [l0, r0] = [await height(page, 'Local'), await height(page, 'Remote')];
    const box = (await sep.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 40, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => height(page, 'Local')).toBeGreaterThan(l0 + 30);
    expect(await height(page, 'Remote')).toBeLessThan(r0 - 30);
    await sep.focus();
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => height(page, 'Local')).toBeLessThan(l0 + 30);
    // Dragging far up stops at the minimum (header + about three rows), not zero.
    const b2 = (await sep.boundingBox())!;
    await page.mouse.move(b2.x + 5, b2.y + 3);
    await page.mouse.down();
    await page.mouse.move(b2.x + 5, b2.y - 900, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => height(page, 'Local')).toBeGreaterThan(90);
    expect(await height(page, 'Local')).toBeLessThan(110);
    const h = await height(page, 'Local');
    await page.evaluate(() => window.__gb!.flush());
    await page.reload();
    await expect(panel(page, 'Local').getByRole('tree')).toBeVisible();
    expect(Math.abs((await height(page, 'Local')) - h)).toBeLessThan(3);
  });

  test('clicking a branch selects its commit in the graph', async ({ page }) => {
    await item(page, 'Local', 'hotfix').click();
    await expect(page.getByRole('row').filter({ hasText: 'Hotfix: null check' })).toHaveAttribute('aria-selected', 'true');
  });

  test('hover card shows the last push', async ({ page }) => {
    await item(page, 'Local', 'main').hover();
    await expect(page.getByRole('tooltip', { name: 'main details' })).toContainText('Last push:');
  });

  test('the (<) button and Ctrl+B toggle narrow mode; the strip shows counts and its icons open a panel', async ({ page }) => {
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    const strip = page.getByRole('complementary', { name: 'Sidebar (collapsed)' });
    await expect(strip).toBeVisible();
    await expect(strip.getByRole('button', { name: 'Local (3)' })).toBeVisible();
    await strip.getByRole('button', { name: 'Expand sidebar' }).click();
    await expect(sidebar(page)).toBeVisible();
    await page.keyboard.press('Control+b');
    await expect(strip).toBeVisible();
    await strip.getByRole('button', { name: 'Tags (1)' }).click();
    await expect(sidebar(page)).toBeVisible();
    await expect(panel(page, 'Tags')).toBeInViewport();
    await page.keyboard.press('Control+b');
    await expect(strip).toBeVisible();
    await page.keyboard.press('Control+b');
    await expect(sidebar(page)).toBeVisible();
  });

  test('a strip icon opens its collapsed panel', async ({ page }) => {
    await panel(page, 'Stashes').getByRole('button', { name: 'Stashes', exact: true }).click();
    await expect(panel(page, 'Stashes').getByRole('tree')).toHaveCount(0);
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await page.getByRole('complementary', { name: 'Sidebar (collapsed)' }).getByRole('button', { name: 'Stashes (1)' }).click();
    await expect(panel(page, 'Stashes').getByRole('tree')).toBeVisible();
  });

  test('the sidebar narrows while a diff is open', async ({ page }) => {
    await page.getByRole('row').filter({ hasText: 'Fix typo' }).click();
    await page.keyboard.press('Enter'); // spec §11.1: Enter on the graph opens the first changed file's diff
    await expect(page.getByRole('complementary', { name: 'Sidebar (collapsed)' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sidebar(page)).toBeVisible();
  });
  // K56: the sidebar never grows its own scrollbar; only the panel bodies scroll. The harness has
  // no webview zoom, so CSS zoom on the root stands in (it gives the same fractional layout).
  for (const z of [1, 1.2, 1.25]) {
    for (const h of [900, 600, 400]) {
      test(`the sidebar does not overflow at zoom ${z * 100}% and ${h}px tall`, async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: h });
        await page.evaluate((zoom) => { document.documentElement.style.zoom = String(zoom); }, z);
        await expect(panel(page, 'Tags')).toBeVisible();
        const m = await page.evaluate(() => {
          const el = document.querySelector('.sidebar')!;
          const stack = el.querySelector('.sb-stack')!;
          return { sh: el.scrollHeight, ch: el.clientHeight, ssh: stack.scrollHeight, sch: stack.clientHeight };
        });
        expect(m.sh).toBeLessThanOrEqual(m.ch);
        expect(m.ssh).toBeLessThanOrEqual(m.sch);
      });
    }
  }

  test('collapsed panel headers are separated by 1px borders; counts are bold light blue (K55)', async ({ page }) => {
    for (const n of ['Stashes', 'Tags']) if ((await panel(page, n).getByRole('tree').count()) > 0) await panel(page, n).getByRole('button', { name: n, exact: true }).click();
    await expect(panel(page, 'Tags').getByRole('tree')).toHaveCount(0);
    await expect(panel(page, 'Tags')).toHaveCSS('border-top-width', '1px');
    // The header must not paint over the next panel's border.
    const ov = await page.evaluate(() => {
      const a = document.querySelector('[data-panel="stashes"]')!.getBoundingClientRect();
      const hd = document.querySelector('[data-panel="stashes"] .sb-panel-head')!.getBoundingClientRect();
      return hd.bottom - a.bottom;
    });
    expect(ov).toBeLessThanOrEqual(0);
    await expect(count(page, 'Local')).toHaveCSS('font-weight', '700');
    await expect(count(page, 'Local')).toHaveCSS('color', 'rgb(109, 157, 235)');
  });
  test('tree rows have no carets; icons align by depth (K61)', async ({ page }) => {
    const local = panel(page, 'Local');
    await expect(local.locator('.sb-folder').first()).toBeVisible();
    // Only the section header keeps its chevron.
    await expect(local.locator('.sb-row .lucide-chevron-right, .sb-row .lucide-chevron-down')).toHaveCount(0);
    await expect(local.locator('.sb-folder').filter({ hasText: 'feature' }).first().locator('.lucide-folder-open')).toHaveCount(1);
    const xs = await local.evaluate((el) => {
      const left = (e: Element | null) => e!.getBoundingClientRect().left;
      const folder = el.querySelector('.sb-folder')!;
      const leaf = [...el.querySelectorAll('.sb-item')].find((r) => r.getAttribute('aria-level') === '1')!;
      const child = [...el.querySelectorAll('.sb-item')].find((r) => r.getAttribute('aria-level') === '2')!;
      return { folderIcon: left(folder.querySelector('svg')), leafIcon: left(leaf.querySelector('svg, .co-check')), folderName: left(folder.querySelector('.sb-label')), childIcon: left(child.querySelector('svg, .co-check')) };
    });
    expect(Math.abs(xs.leafIcon - xs.folderIcon)).toBeLessThanOrEqual(1);
    expect(Math.abs(xs.childIcon - xs.folderName)).toBeLessThanOrEqual(1);
  });
});
