// The site's screenshots (`just site-shots`; spec §2 decision 6, §6.2): each scene on the demo
// build at device scale 2, into GITVOLT_SITE_SHOTS_RAW as <id>@<2x width>.png, which
// scripts/site-shots.py turns into site/shots/<id>.webp and <id>-1x.webp. On demand only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { pendingMethods } from '../build/pending.ts';
import { SHOTS, type ShotId } from '../build/shots.ts';

const out = process.env.GITVOLT_SITE_SHOTS_RAW;
test.skip(!out, 'the site screenshots run through `just site-shots`');

const pending = pendingMethods(readFileSync(new URL('../../ui/src/demo/coverage.ts', import.meta.url), 'utf8'));

interface Scene {
  id: ShotId;
  /** Demo methods the scene drives; it's skipped while one is still PENDING. */
  needs: string[];
  viewport?: { width: number; height: number };
  /** A 16:10 part of the viewport (its height follows from the width); the whole viewport when absent. */
  clip?: { x: number; y: number; width: number };
  run(page: Page): Promise<void>;
}

/** The app at a comfortable size, 16:10, shown at 720 px wide on the page. */
const FEATURE = { width: 1200, height: 750 };

const grid = (page: Page) => page.getByRole('grid', { name: 'Commit graph' });
const diff = (page: Page) => page.getByRole('region', { name: 'Diff' });
async function selectWip(page: Page): Promise<void> {
  await grid(page).getByRole('row').filter({ hasText: '// WIP' }).first().locator('[data-col="message"]').click({ position: { x: 3, y: 3 } });
  await expect(page.getByTestId('wip-header')).toBeVisible();
}
/** A file in the WIP's staged or unstaged list; a path ending in / matches the first file under it. */
const fileRow = (page: Page, section: 'staged' | 'unstaged', path: string) =>
  page.locator(`.wip-section[data-section="${section}"] .file-row[data-path${path.endsWith('/') ? '^' : ''}="${path}"]`).first();

const SCENES: Scene[] = [
  // What a visitor sees before the demo is up (and on a phone): Orbital as the demo opens it, at
  // the hero frame's size.
  { id: 'hero', needs: [], viewport: { width: SHOTS.hero.width, height: SHOTS.hero.height }, run: async () => {} },
  {
    id: 'graph',
    needs: [],
    run: async (page) => {
      await page.getByRole('button', { name: 'Tab group: Playground' }).click();
      await expect(page.getByRole('tab', { name: /basic/ })).toBeVisible();
      await page.getByRole('tab', { name: /orbital/ }).click();
      await expect(grid(page)).toBeVisible();
    },
  },
  {
    id: 'markdown',
    needs: [],
    run: async (page) => {
      await selectWip(page);
      await fileRow(page, 'unstaged', 'docs/devlog/').click();
      await page.getByRole('group', { name: 'Markdown view' }).getByRole('button', { name: 'Rendered' }).click();
      await page.getByRole('group', { name: 'View mode' }).getByRole('button', { name: 'Split' }).click();
      await expect(page.locator('.diff-panel').getByRole('heading').first()).toBeVisible({ timeout: 20_000 });
    },
  },
  {
    id: 'image',
    needs: [],
    run: async (page) => {
      // The merge that brings in the redrawn title art (v1 -> v2).
      const sc = await grid(page).evaluateHandle((g) => { let e: HTMLElement | null = g as HTMLElement; while (e && e.scrollHeight <= e.clientHeight + 5) e = e.parentElement; return e!; });
      const row = grid(page).getByRole('row').filter({ hasText: 'Redraw the title screen' }).first();
      for (let i = 0; i < 400 && !(await row.count()); i++) {
        await sc.evaluate((e) => { (e as HTMLElement).scrollTop += 400; });
        await page.waitForTimeout(60);
      }
      await row.locator('[data-col="message"]').click();
      await page.locator('.file-row[data-path="assets/title/title.png"]').first().click();
      const swipe = diff(page).getByRole('toolbar', { name: 'Image diff options' }).getByRole('button', { name: 'Swipe', exact: true });
      await swipe.click();
      await expect(swipe).toHaveAttribute('aria-pressed', 'true');
      const fit = diff(page).getByRole('toolbar', { name: 'Image diff options' }).getByRole('button', { name: 'Fit' });
      if (await fit.count()) await fit.first().click();
    },
  },
  {
    id: 'previews',
    needs: [],
    run: async (page) => {
      await selectWip(page);
      await fileRow(page, 'unstaged', 'assets/data/economy/commodities.csv').click();
      await expect(diff(page).getByRole('table').first()).toBeVisible({ timeout: 20_000 });
    },
  },
];

async function capture(page: Page, scene: Scene, viewport: { width: number; height: number }): Promise<void> {
  // Nothing hovered or focused that a visitor wouldn't see at rest.
  await page.mouse.move(1, viewport.height - 1);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(500);
  const width = scene.clip?.width ?? viewport.width;
  const clip = { x: scene.clip?.x ?? 0, y: scene.clip?.y ?? 0, width, height: Math.round((width * SHOTS[scene.id].height) / SHOTS[scene.id].width) };
  await page.screenshot({ path: join(out ?? '', `${scene.id}@${SHOTS[scene.id].width * 2}.png`), clip, animations: 'disabled', caret: 'hide' });
}

for (const scene of SCENES) {
  test(scene.id, async ({ page }) => {
    const missing = scene.needs.filter((m) => pending.has(m));
    test.skip(missing.length > 0, `needs ${missing.join(', ')}, still PENDING in ui/src/demo/coverage.ts`);
    const viewport = scene.viewport ?? FEATURE;
    await page.setViewportSize(viewport);
    await page.goto('demo/demo.html');
    await expect(grid(page)).toBeVisible({ timeout: 60_000 });
    await expect(page).toHaveTitle(/orbital/);
    await scene.run(page);
    await capture(page, scene, viewport);
  });
}
