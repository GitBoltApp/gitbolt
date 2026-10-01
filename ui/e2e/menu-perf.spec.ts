import { expect, test, type Page } from './test';
import { fixtures, openUrl } from './fixtures';

// The context menus' latency budgets (spec §7, §17.3), apart from the functional specs so a
// loaded machine can't fail those. The menu records its own open-to-first-paint time in
// `window.__gbMenuLatency`; these tests read it. Because load only ever makes a timing slower,
// each bound is checked against the best of several samples: a regression slows every sample,
// a busy machine only some. (Cold samples after the first are on the same browser context, so
// the HTTP and code caches make them a little warmer than a first launch: fine for a tripwire.)

const ATTEMPTS = 3;
/** A tripwire for the cold first opening (typically 20-36 ms on Chromium, 26-35 on WebKit; ~3x). */
const COLD_MS = 75;
const MENU = 'context-menu';
const FILE_ROW = '[role="option"][data-path="src/app.php"]';

interface Target {
  name: string;
  /** Loads the page to the state a user's first right-click finds it in. */
  load(page: Page): Promise<void>;
  /** Right-clicks the target. */
  open(page: Page): Promise<void>;
}

const targets: Target[] = [
  {
    name: 'file menu',
    async load(page) {
      await page.goto(openUrl(fixtures.details));
      await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
      await page.getByRole('row').filter({ hasText: 'Rename guide and update assets' }).click();
      await expect(page.getByTestId('commit-message')).toContainText('Rename guide');
      await expect(page.locator(FILE_ROW)).toBeVisible();
      // Settled: the selection's loads are done.
      await page.evaluate(() => new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 200)));
    },
    open: (page) => page.locator(FILE_ROW).click({ button: 'right', position: { x: 40, y: 10 } }),
  },
  {
    name: 'commit menu',
    async load(page) {
      await page.goto(openUrl(fixtures.basic));
      await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    },
    open: (page) => page.getByRole('row').filter({ hasText: 'Fix typo' }).locator('[data-col="message"]').click({ button: 'right' }),
  },
];

/** Opens the menu and returns the latency it recorded, once it is on screen. */
async function openTimed(page: Page, t: Target) {
  await t.open(page);
  await expect(page.getByTestId(MENU)).toBeVisible();
  return page.evaluate(() => window.__gbMenuLatency!);
}

async function close(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId(MENU)).toBeHidden();
}

for (const t of targets) {
  test.describe(`${t.name} latency`, () => {
    test('the cold first opening is under the tripwire (best of a few fresh loads)', async ({ page }) => {
      const samples: number[] = [];
      for (let i = 0; i < ATTEMPTS; i++) {
        await t.load(page);
        samples.push(await openTimed(page, t));
        if (Math.min(...samples) < COLD_MS) break;
      }
      expect(Math.min(...samples), `cold samples ${samples.map((n) => n.toFixed(1)).join(', ')} ms`).toBeLessThan(COLD_MS);
    });

    test('a warm opening is within the budget (median of five, best of a few rounds)', async ({ page, browserName }) => {
      await t.load(page);
      await openTimed(page, t);
      await close(page);
      // The budget is the app's (CEF, i.e. Chromium); WebKit on the dev build only gets a sanity bound.
      const budget = browserName === 'chromium' ? 16 : 33;
      const medians: number[] = [];
      for (let round = 0; round < ATTEMPTS; round++) {
        const warm: number[] = [];
        for (let i = 0; i < 5; i++) {
          warm.push(await openTimed(page, t));
          await close(page);
        }
        medians.push(warm.sort((p, q) => p - q)[2]);
        if (medians[round] < budget) break;
      }
      expect(Math.min(...medians), `warm medians ${medians.map((n) => n.toFixed(1)).join(', ')} ms`).toBeLessThan(budget);
    });
  });
}

test('a file menu is on screen within two frames of its contextmenu event (best of five)', async ({ page, browserName }) => {
  await targets[0].load(page);
  await openTimed(page, targets[0]);
  await close(page);
  const frames: number[] = [];
  for (let i = 0; i < 5; i++) {
    frames.push(await page.evaluate((sel) => new Promise<number>((resolve) => {
      const el = document.querySelector<HTMLElement>(sel)!;
      const r = el.getBoundingClientRect();
      const t0 = performance.now();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 5 }));
      requestAnimationFrame(() => resolve(performance.now() - t0));
    }), FILE_ROW));
    // A sample only counts if the event really opened the menu.
    await expect(page.getByTestId(MENU)).toBeVisible();
    await close(page);
  }
  expect(Math.min(...frames), `frame samples ${frames.map((n) => n.toFixed(1)).join(', ')} ms`).toBeLessThan(browserName === 'chromium' ? 33 : 100);
});
