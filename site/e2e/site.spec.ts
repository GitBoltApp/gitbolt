import { readFileSync } from 'node:fs';
import { devices, expect, test } from '@playwright/test';
import type { ReleaseFile } from '../build/release.ts';

const file = JSON.parse(readFileSync(new URL('../data/release.json', import.meta.url), 'utf8')) as ReleaseFile;
if (!file.release) throw new Error('site/data/release.json has no release: these checks need one');
const release = file.release;
// Playwright's desktop Chrome says Windows; the steps below are written for a Linux visitor.
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

test.describe('desktop', () => {
  test.use({ userAgent: LINUX });

  test("the page: its own origin only, no errors, downloads from release.json, the live demo boots and resets", async ({ page, baseURL }) => {
    test.setTimeout(240_000);
    const origin = new URL(baseURL ?? '').origin;
    const foreign: string[] = [];
    const errors: string[] = [];
    page.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith(`${origin}/`) && !/^(?:data|blob|about):/.test(u)) foreign.push(u);
    });
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => console.error(`[csp-violation] ${e.effectiveDirective} ${e.blockedURI}`));
    });
    await page.goto('./');

    await test.step("the header's Download names the visitor's system and goes to the downloads", async () => {
      await expect(page.getByRole('link', { name: 'Download for Linux' })).toHaveAttribute('href', '#downloads');
    });

    await test.step("downloads: Linux first and marked; every button is one of release.json's files", async () => {
      const cards = page.locator('#downloads .dl');
      await expect(cards.first()).toHaveAttribute('data-os', 'linux');
      await expect(cards.first().getByText('Your system')).toBeVisible();
      const deb = release.downloads.find((d) => d.kind === 'deb');
      await expect(cards.first().locator('.fbtn.primary')).toHaveAttribute('href', deb?.url ?? 'missing');
      const hrefs = await page.locator('#downloads .fbtn').evaluateAll((links) => links.map((a) => a.getAttribute('href')));
      expect(hrefs).toHaveLength(release.downloads.length);
      for (const h of hrefs) expect(release.downloads.map((d) => d.url)).toContain(h);
      await expect(page.getByRole('heading', { name: `Download GitBolt ${release.version}` })).toBeVisible();
    });

    const hero = page.locator('.hero-demo');
    await test.step('the live demo boots in its frame, then the still steps aside', async () => {
      await expect(hero).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
      await expect(page.frameLocator('iframe[title="GitBolt live demo"]').getByRole('grid', { name: 'Commit graph' })).toBeVisible();
      await expect(hero.locator('.still')).toBeHidden();
      await expect(hero.getByRole('status')).toHaveText('Live demo');
    });

    await test.step('keyboard: Tab reaches the Download CTA from the top, then Reset and Full screen in order', async () => {
      const active = () => page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el?.classList.contains('cta') ? 'cta' : (el?.getAttribute('data-action') ?? '');
      });
      await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
      let reached = false;
      for (let i = 0; i < 15 && !reached; i++) {
        await page.keyboard.press('Tab');
        reached = (await active()) === 'cta';
      }
      expect(reached, 'Tab reaches the CTA').toBe(true);
      // The demo's own controls sit after the frame, which holds many tab stops: start from the buttons.
      await hero.locator('[data-action="reset"]').focus();
      await page.keyboard.press('Tab');
      expect(await active()).toBe('fullscreen');
      await page.keyboard.press('Shift+Tab');
      expect(await active()).toBe('reset');
    });

    await test.step('Reset demo arms in place (nothing moves), Esc cancels, a second click restarts the demo', async () => {
      const reset = hero.locator('[data-action="reset"]');
      await expect(reset).toHaveAccessibleName('Reset demo');
      // Page coordinates: clicking may scroll the button into view, which isn't a layout shift.
      const box = () => reset.evaluate((el) => { const r = el.getBoundingClientRect(); return [r.x + scrollX, r.y + scrollY, r.width, r.height]; });
      await reset.scrollIntoViewIfNeeded();
      const before = await box();
      await reset.click();
      await expect(reset).toHaveAccessibleName('Reset and lose your changes');
      expect(await box()).toEqual(before);
      await page.keyboard.press('Escape');
      await expect(reset).toHaveAccessibleName('Reset demo');
      await reset.click();
      await reset.click();
      await expect(hero).toHaveAttribute('data-state', 'loading');
      await expect(hero).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
    });

    await test.step('the skip link jumps past the demo', async () => {
      await page.getByRole('link', { name: 'Skip the live demo' }).focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/#features$/);
    });

    expect(foreign, 'requests to other origins').toEqual([]);
    expect(errors, 'console errors').toEqual([]);
  });

  test("the Download CTA's label shifts nothing when the script fills it", async ({ browser, baseURL }) => {
    const box = async (javaScriptEnabled: boolean) => {
      const context = await browser.newContext({ userAgent: LINUX, viewport: { width: 1280, height: 860 }, javaScriptEnabled, baseURL });
      const page = await context.newPage();
      await page.goto('./');
      const b = await page.locator('.cta').boundingBox();
      await context.close();
      return b;
    };
    const before = await box(false);
    const after = await box(true);
    expect(after?.width).toBe(before?.width);
    expect(after?.height).toBe(before?.height);
    expect(after?.x).toBe(before?.x);
  });

  for (const [width, iframes] of [[992, 1], [991, 0]] as const) {
    test(`at ${width}px the demo ${iframes ? 'boots' : 'stays a still'}`, async ({ browser, baseURL }) => {
      const context = await browser.newContext({ userAgent: LINUX, viewport: { width, height: 860 }, baseURL });
      const page = await context.newPage();
      await page.goto('./');
      if (iframes) {
        await expect(page.locator('.hero-demo')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
        await expect(page.locator('iframe')).toHaveCount(1);
      } else {
        await page.waitForTimeout(2500);
        await expect(page.locator('iframe')).toHaveCount(0);
        await expect(page.locator('.hero-demo .still')).toBeVisible();
      }
      await context.close();
    });
  }
});

test('a phone gets the screenshot and the note, never the demo', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ ...devices['Pixel 7'], baseURL });
  const page = await context.newPage();
  const demo: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/demo/')) demo.push(r.url()); });
  await page.goto('./');
  await page.waitForLoadState('load');
  await expect(page.getByText('Try the live demo on a desktop.')).toBeVisible();
  await expect(page.locator('.hero-demo .still')).toBeVisible();
  // Past the load-and-idle start a wide screen would have made.
  await page.waitForTimeout(2500);
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(demo).toEqual([]);
  await expect(page.getByRole('link', { name: 'Download', exact: true })).toBeVisible();
  await context.close();
});
