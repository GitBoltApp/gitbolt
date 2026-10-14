// The site's screenshots (`just site-shots`; spec §2 decision 6, §6.2): each scene on the demo
// build at device scale 2, into GITVOLT_SITE_SHOTS_RAW as <id>@<2x width>.png, which
// scripts/site-shots.py turns into site/shots/<id>.webp and <id>-1x.webp. On demand only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
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
  /** The part of the viewport that shows the feature, at the shot's proportions (its height
   * follows from the width), found once the scene has run; the whole viewport when absent. */
  clip?: (page: Page) => Promise<Box>;
  run?(page: Page): Promise<void>;
  /** A collage instead of one view (COLLAGE): its tiles, left to right and top to bottom. */
  tiles?: Tile[];
  /** The scene leaves the pointer where it is (hovering what it shows) instead of moving it off. */
  pointer?: true;
}
interface Box { x: number; y: number; width: number }
/** A collage tile: the diff panel at `width` CSS px, its header (the file path and the Diff View
 * row) above the part of it `show` returns, from that part's top to the panel's bottom. */
interface Tile {
  /** The panel's width: the tile is taken at the device scale that makes it COLLAGE.tile wide. */
  width: number;
  /** Brings the diff up; returns the part to show under the header. */
  show(page: Page): Promise<Locator>;
  /** Once the window has the panel's size: the last touches, and checks of what shows. */
  settle?(page: Page, part: Locator, bottom: number): Promise<void>;
}

/** The app at a comfortable size, 16:10. */
const FEATURE = { width: 1200, height: 750 };

const grid = (page: Page) => page.getByRole('grid', { name: 'Commit graph' });
const diff = (page: Page) => page.getByRole('region', { name: 'Diff' });
async function box(l: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await l.boundingBox();
  if (!b) throw new Error(`${l} isn't on screen`);
  return b;
}
/** Headless Chromium draws no mouse pointer: a plain arrow, its tip at (x, y), for the shot only. */
async function drawPointer(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(({ x, y }) => {
    const el = document.createElement('div');
    el.innerHTML = '<svg width="13" height="19" viewBox="0 0 13 19"><path d="M1 1v15.5l3.9-3.8 2.6 5.8 2.4-1-2.6-5.7h5.4z" fill="#fff" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/></svg>';
    Object.assign(el.style, { position: 'fixed', left: `${x - 1}px`, top: `${y - 1}px`, pointerEvents: 'none', zIndex: '2147483647', lineHeight: '0' });
    document.body.append(el);
  }, { x, y });
}
/** The diff panel, its toolbar and file name included. */
const diffPanel = async (page: Page): Promise<Box> => box(diff(page));
async function selectWip(page: Page): Promise<void> {
  await grid(page).getByRole('row').filter({ hasText: '// WIP' }).first().locator('[data-col="message"]').click({ position: { x: 3, y: 3 } });
  await expect(page.getByTestId('wip-header')).toBeVisible();
}
/** Scrolls the graph down from its top until `row` is there, and selects it. */
async function selectRow(page: Page, row: Locator): Promise<void> {
  const sc = await grid(page).evaluateHandle((g) => { let e: HTMLElement | null = g as HTMLElement; while (e && e.scrollHeight <= e.clientHeight + 5) e = e.parentElement; return e!; });
  await sc.evaluate((e) => { (e as HTMLElement).scrollTop = 0; });
  for (let i = 0; i < 400 && !(await row.count()); i++) {
    await sc.evaluate((e) => { (e as HTMLElement).scrollTop += 400; });
    await page.waitForTimeout(60);
  }
  await row.locator('[data-col="message"]').click();
}
/** The commit with this subject (not a merge that names it in its message), and `path` in it. */
async function commitFile(page: Page, subject: string, path: string): Promise<void> {
  await selectRow(page, grid(page).getByRole('row').filter({ hasText: subject }).filter({ hasNotText: 'Merge branch' }).first());
  await page.locator(`.file-row[data-path="${path}"]`).first().click();
}
/** A file in the WIP's staged or unstaged list; a path ending in / matches the first file under it. */
const fileRow = (page: Page, section: 'staged' | 'unstaged', path: string) =>
  page.locator(`.wip-section[data-section="${section}"] .file-row[data-path${path.endsWith('/') ? '^' : ''}="${path}"]`).first();

const SCENES: Scene[] = [
  // What a visitor sees before the demo is up (and on a phone): Orbital as the demo opens it, at
  // the hero frame's size.
  { id: 'hero', needs: [], viewport: { width: SHOTS.hero.width, height: SHOTS.hero.height }, run: async () => {} },
  // The tab switched to Orbital's release worktree from its WIP row: both worktrees' WIP rows,
  // the sidebar's Worktrees, the tab and toolbar naming it. Left to the end of the WIP rows' text.
  {
    id: 'worktrees',
    needs: [],
    run: async (page) => {
      await grid(page).getByRole('row').filter({ hasText: 'wt-release' }).first().locator('[data-col="message"]').dblclick({ position: { x: 3, y: 3 } });
      await expect(page.getByTestId('wip-header')).toContainText('release/1.2');
      await expect(grid(page).getByRole('row').filter({ hasText: '// WIP' })).toHaveCount(2);
    },
    clip: async (page) => {
      const right = Math.max(...await Promise.all((await page.locator('.wip-summary').all()).map(async (w) => { const b = await box(w); return b.x + b.width; })));
      return { x: 0, y: 0, width: Math.ceil(right) + 12 };
    },
  },
  // A branch chip's menu, its Delete row armed in place (Remote clicked once: it can't be undone), with the graph around it.
  {
    id: 'menus',
    needs: [],
    viewport: { width: 1200, height: 800 },
    run: async (page) => {
      await grid(page).locator('.ref-label').filter({ hasText: 'feature/wormholes' }).first().click({ button: 'right' });
      const menu = page.getByRole('menu').first();
      await expect(menu).toBeVisible();
      await menu.getByRole('menuitem', { name: 'Delete' }).locator('[data-variant-id="remote"]').click();
    },
    clip: async (page) => {
      const [g, m] = [await box(grid(page)), await box(page.getByRole('menu').first())];
      // From the top of the row above the chip's (rows are 28 px) to the last whole row above the status bar.
      return { x: g.x, y: m.y - 42, width: 720 };
    },
  },
  {
    id: 'markdown',
    needs: [],
    run: async (page) => {
      await selectWip(page);
      await fileRow(page, 'unstaged', 'docs/controls.md').click();
      await page.getByRole('group', { name: 'Markdown view' }).getByRole('button', { name: 'Rendered' }).click();
      await page.getByRole('group', { name: 'View mode' }).getByRole('button', { name: 'Split' }).click();
      await expect(page.locator('.diff-panel').getByRole('heading').first()).toBeVisible({ timeout: 20_000 });
    },
    clip: diffPanel,
  },
  {
    id: 'image',
    needs: [],
    run: async (page) => {
      // The merge that brings in the redrawn title art (v1 -> v2).
      await selectRow(page, grid(page).getByRole('row').filter({ hasText: 'Redraw the title screen' }).first());
      await page.locator('.file-row[data-path="assets/title/title.png"]').first().click();
      const swipe = diff(page).getByRole('toolbar', { name: 'Image diff options' }).getByRole('button', { name: 'Swipe', exact: true });
      await swipe.click();
      await expect(swipe).toHaveAttribute('aria-pressed', 'true');
      const fit = diff(page).getByRole('toolbar', { name: 'Image diff options' }).getByRole('button', { name: 'Fit' });
      if (await fit.count()) await fit.first().click();
    },
    clip: diffPanel,
  },
  // Four previews, each a real change: the WIP's retuned commodities table, the design document's
  // update, the HUD font gaining its lowercase, and the trailer's recut (both at their last frame,
  // the title each cut ends on). Each tile's part is its sides, under the panel's header: the
  // toolbar between (Hex, the sizes) gives way to a larger preview.
  {
    id: 'previews',
    needs: [],
    tiles: [
      // The table's text two steps smaller (Ctrl+- over it), and the panel wide enough for its five
      // columns and the change ruler past them: ten rows under the header, the last one whole.
      {
        width: 525,
        show: async (page) => {
          await selectWip(page);
          await fileRow(page, 'unstaged', 'assets/data/economy/commodities.csv').click();
          const table = diff(page).getByRole('table').first();
          await expect(table).toBeVisible({ timeout: 20_000 });
          await table.focus();
          await page.keyboard.press('Control+Minus');
          await page.keyboard.press('Control+Minus');
          await expect(page.getByText('Text size 11 px')).toBeVisible();
          await expect(page.getByText('Text size 11 px')).toBeHidden({ timeout: 15_000 });
          return table;
        },
        settle: async (_page, table, bottom) => {
          const fit = await table.evaluate((t, bottom) => {
            const ruler = t.closest('.ruler-box')?.querySelector('.ruler-strip')?.getBoundingClientRect().left ?? Infinity;
            const cut: string[] = [];
            let right = 0;
            for (const c of t.querySelectorAll<HTMLElement>('[role=columnheader], [role=cell]')) {
              const r = document.createRange();
              r.selectNodeContents(c);
              const text = r.getBoundingClientRect();
              const cs = getComputedStyle(c);
              if (text.width > c.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) + 0.5) cut.push(c.textContent ?? '');
              right = Math.max(right, text.right);
            }
            const rows = [...t.querySelectorAll('[role=row]')].map((r) => r.getBoundingClientRect().bottom);
            // The last column's text may end on the ruler's edge (within a px of it), not under it.
            return { cut, clear: right <= ruler + 1, onRow: rows.some((b) => Math.abs(b - bottom) < 1) };
          }, bottom);
          expect(fit, 'every cell whole, the ruler past them, the last row whole').toEqual({ cut: [], clear: true, onRow: true });
        },
      },
      // The covers; the pages' overview ruler (its viewport slider, at each side's top right)
      // hidden for the shot.
      {
        width: 445,
        show: async (page) => {
          await commitFile(page, 'Update the design document', 'docs/design/orbital-design.pdf');
          await expect(diff(page).locator('.pdf-pane')).toHaveCount(2, { timeout: 20_000 });
          await expect(diff(page).locator('.pdf-pane[aria-busy]')).toHaveCount(0, { timeout: 20_000 });
          return diff(page).locator('.pdf-stage');
        },
        settle: async (page) => {
          await page.addStyleTag({ content: '.pdf-stage .ruler-slider { visibility: hidden; }' });
        },
      },
      // The name and the samples from 12 to 36 px, each cut by the side's edge between two words:
      // the panes scrolled to their Old and New labels, so the 36 px line shows whole.
      {
        width: 510,
        show: async (page) => {
          await commitFile(page, 'Widen the HUD digits', 'assets/fonts/OrbitalHud.ttf');
          await expect(diff(page).getByTestId('font-glyphs')).toHaveCount(2, { timeout: 20_000 });
          await expect(diff(page).getByTestId('font-name').last()).toContainText('Orbital HUD');
          return diff(page).locator('.media-stage');
        },
        settle: async (page, _stage, bottom) => {
          const panes = diff(page).locator('.media-font-pane');
          await panes.evaluateAll((ps) => ps.forEach((p) => { p.scrollTop = 16; }));
          const lines = await panes.evaluateAll((ps, bottom) => ps.flatMap((p) => {
            const edge = p.getBoundingClientRect().left + p.clientWidth;
            return [...p.querySelectorAll('.font-line')].filter((l) => l.getBoundingClientRect().top < bottom).map((l) => {
              const text = l.lastElementChild!.firstChild as Text;
              const at = (i: number) => { const r = document.createRange(); r.setStart(text, i); r.setEnd(text, i + 1); return r.getBoundingClientRect(); };
              let i = 0;
              while (i < text.length && at(i).right <= edge) i++;
              // A line's box ends a few px below its descenders.
              return { whole: l.getBoundingClientRect().bottom <= bottom + 3, cut: i < text.length && text.data[i] !== ' ' ? text.data.slice(0, i + 1) : '' };
            });
          }), bottom);
          expect(lines.length, 'four sample lines a side').toBe(8);
          expect(lines.filter((l) => !l.whole || l.cut), 'each line whole, cut between words').toEqual([]);
        },
      },
      {
        width: 445,
        show: async (page) => {
          await commitFile(page, 'Recut the trailer with the new ships', 'press/trailer.webm');
          const videos = diff(page).locator('video');
          await expect(videos).toHaveCount(2, { timeout: 20_000 });
          await videos.evaluateAll((vs) => Promise.all((vs as HTMLVideoElement[]).map((v) => new Promise<void>((done) => {
            const end = () => {
              v.addEventListener('seeked', () => done(), { once: true });
              v.currentTime = Number.isFinite(v.duration) ? v.duration - 0.01 : 1e6;
            };
            if (v.readyState >= 1) end(); else v.addEventListener('loadedmetadata', end, { once: true });
          }))));
          await expect.poll(() => videos.evaluateAll((vs) => (vs as HTMLVideoElement[]).every((v) => v.readyState >= 2))).toBe(true);
          return diff(page).locator('.media-stage');
        },
      },
    ],
  },
  // The toolbar's Undo caret open over a few writes made through the UI: stage, commit, branch.
  {
    id: 'undo',
    needs: ['stage', 'commit', 'stashPush', 'createTag', 'createBranch', 'undo', 'undoEntry'],
    run: async (page) => {
      await selectWip(page);
      const bar = page.getByRole('toolbar', { name: 'Repository toolbar' });
      // Two more of the changed files go in the commit with the staged sprite; the rest is stashed.
      for (const path of ['assets/data/economy/commodities.csv', 'crates/orbital-game/src/hud.rs']) {
        const row = fileRow(page, 'unstaged', path);
        await row.hover();
        await row.getByRole('button', { name: /^Stage / }).click();
      }
      await expect(page.getByRole('heading', { name: 'Staged (3)' })).toBeVisible();
      const message = page.getByTestId('commit-box').getByRole('textbox', { name: 'Commit summary' });
      await message.fill('Tune the warp drive economy');
      await message.press('Control+Enter');
      const row = grid(page).getByRole('row').filter({ hasText: 'Tune the warp drive economy' }).first();
      await expect(row).toBeVisible();
      await bar.getByRole('button', { name: 'Stash', exact: true }).click();
      await expect(bar.getByRole('button', { name: 'Stash', exact: true })).toBeDisabled();
      await row.locator('[data-col="message"]').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Create tag here' }).click();
      const tag = grid(page).getByRole('textbox', { name: 'Tag name' });
      await tag.fill('v1.3-rc1');
      await tag.press('Enter');
      await expect(tag).toBeHidden();
      await page.getByRole('button', { name: 'Branch', exact: true }).click();
      const name = grid(page).getByRole('textbox', { name: 'Branch name' });
      await name.fill('feature/warp-tuning');
      await name.press('Enter');
      await expect(name).toBeHidden();
      await page.getByRole('toolbar', { name: 'Repository toolbar' }).getByRole('button', { name: 'Undo options' }).click();
      await expect(page.locator('.ctx-menu [role="menuitem"]').first()).toBeVisible();
    },
    clip: async (page) => {
      const [t, m] = [await box(page.getByRole('toolbar', { name: 'Repository toolbar' })), await box(page.locator('.ctx-menu'))];
      return { x: 0, y: Math.max(0, t.y - 4), width: Math.ceil(m.x + m.width) + 40 };
    },
  },
  // feature/hud-polish's interactive rebase onto main, feature/hud-gauges stacked under it (its
  // chip moves with the rebase): the fixup moved under its commit, the typo reworded, the debug
  // prints squashed, and the editor's predicted-conflict marks. The editor, whole, at a height that
  // leaves it little empty space (the flow runs at full height, where the graph shows the branch).
  {
    id: 'rebase',
    needs: ['stashPush', 'checkout', 'rebasePlan', 'predictRebase'],
    viewport: { width: 1020, height: 500 },
    run: async (page) => {
      await page.setViewportSize({ width: 1020, height: 750 });
      const bar = page.getByRole('toolbar', { name: 'Repository toolbar' });
      // The working tree's changes aside first, so feature/hud-polish checks out cleanly.
      await bar.getByRole('button', { name: 'Stash', exact: true }).click();
      await expect(bar.getByRole('button', { name: 'Stash', exact: true })).toBeDisabled();
      await grid(page).locator('.ref-label').filter({ hasText: 'feature/hud-polish' }).first().dblclick();
      // The menu names the branch once the checkout is done.
      await grid(page).locator('.ref-label').getByText('main', { exact: true }).first().click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Interactive rebase feature/hud-polish onto main' }).click();
      const panel = page.getByTestId('irebase');
      const row = (subject: string) => panel.locator('[data-irebase-row]', { hasText: subject }).locator('.irebase-summary');
      await expect(panel).toBeVisible();
      await row('fixup! Draw the HUD gauges').click();
      await page.keyboard.press('f');
      await page.keyboard.press('Control+ArrowDown');
      await page.keyboard.press('Control+ArrowDown');
      await row('Add the fuel gague').click();
      await page.keyboard.press('r');
      await panel.locator('.commit-summary').fill('Add the fuel gauge');
      await panel.getByRole('button', { name: 'Save' }).click();
      await expect(row('Add the fuel gauge')).toBeVisible();
      await row('Remove the debug prints').click();
      await page.keyboard.press('s');
      await expect(panel.locator('[data-irebase-row]', { hasText: 'Remove the debug prints' })).toHaveClass(/is-folded/);
      await expect(panel.locator('[data-irebase-row]', { hasText: 'Add the fuel gauge' }).getByText('feature/hud-gauges')).toBeVisible();
      await expect(panel.locator('[data-irebase-row]').filter({ has: page.getByRole('img', { name: 'Predicted conflict' }) })).toHaveCount(2, { timeout: 20_000 });
      await page.setViewportSize({ width: 1020, height: 500 });
    },
    clip: async (page) => {
      const b = await box(page.getByTestId('irebase'));
      return { x: b.x, y: b.y, width: b.width };
    },
  },
  // A pending comment with a suggested change on three lines of !182's station screen, dragged
  // from the gutter's +, its source diff in review mode (the MR's Compare), the lines high enough
  // for the card and the lines after it, a new range being dragged above it, the pointer on the +.
  {
    id: 'review',
    needs: ['forgeMrList', 'forgeMrDetail', 'forgeMrDiscussions', 'forgeReviewDiff', 'forgeReviewDrafts', 'forgeAddDraft'],
    run: async (page) => {
      const mrs = page.getByRole('region', { name: 'Merge requests' });
      await expect(mrs).toBeVisible({ timeout: 30_000 });
      await mrs.getByRole('treeitem', { name: /^!182 / }).click();
      const view = page.getByRole('dialog', { name: 'Merge request !182' });
      await view.getByRole('region', { name: 'Branches' }).getByRole('button', { name: 'Compare' }).click();
      const file = 'crates/orbital-game/src/station_ui.rs';
      await page.locator(`[role="option"][data-path="${file}"], [role="treeitem"][data-path="${file}"]`).first().click();
      const panel = page.locator('.diff-panel');
      // Review mode is on once the MR's thread there shows.
      await expect(panel.getByRole('article', { name: 'Thread by Kasimir Oduya' })).toBeAttached({ timeout: 20_000 });
      const lineNo = (n: number) => panel.locator('.editor.modified .margin-view-overlays .line-numbers').filter({ hasText: new RegExp(`^${n}$`) });
      await panel.locator('.editor.modified .view-lines').last().hover();
      for (let i = 0; i < 30 && !(await lineNo(66).count()); i++) {
        await page.mouse.wheel(0, 200);
        await page.waitForTimeout(100);
      }
      const glyph = panel.locator('.review-glyph:visible');
      const plus = async (line: Locator) => {
        await expect(async () => {
          await line.hover({ position: { x: 1, y: 1 } });
          await line.hover();
          await expect(glyph).toBeVisible({ timeout: 500 });
        }).toPass({ timeout: 20_000 });
        return box(glyph);
      };
      // The existing pending comment first, on lines 57-59.
      const drag = async (from: Locator, to: Locator, release: boolean) => {
        const g = await plus(from);
        await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
        await page.mouse.down();
        const end = await box(to);
        await page.mouse.move(g.x + g.width / 2, end.y + end.height / 2, { steps: 6 });
        if (release) await page.mouse.up();
      };
      await drag(lineNo(57), lineNo(59), true);
      const form = panel.getByRole('form', { name: 'New comment' });
      await form.getByRole('textbox', { name: 'Comment' }).fill('The count could hang off it too, so the two move together:\n```suggestion:-2+0\n            glyphs,\n            &format!("{} PORTS", self.ports),\n            Vec2::new(120.0, PORTS_TOP - 16.0),\n```');
      await form.getByRole('button', { name: 'Add to review' }).click();
      const pending = panel.getByRole('article', { name: 'Pending comment' });
      await expect(pending).toContainText('Pending');
      await expect(pending.getByText('Suggested change')).toBeVisible();
      // Line 51 near the top, so the range, lines 54-56 between, the card and the lines after it show.
      const [first, at] = [lineNo(51), lineNo(53)];
      const d = await box(diff(page));
      await page.mouse.move(d.x + d.width / 2, d.y + d.height - 40);
      const want = (await box(panel.locator('.editor.modified'))).y + 0.5 * (await box(first)).height;
      for (let i = 0; i < 6; i++) {
        const dy = (await box(first)).y - want;
        if (Math.abs(dy) < 2) break;
        await page.mouse.wheel(0, dy);
        await page.waitForTimeout(200);
      }
      // A new range, dragged from 51's + to 53 and still held, the pointer where the drag is, in the gutter at its end.
      await drag(first, at, false);
      const [tip, end] = [await box(glyph), await box(at)];
      await drawPointer(page, tip.x + tip.width * 0.55, end.y + end.height * 0.55);
    },
    clip: diffPanel,
    pointer: true,
  },
  // The stack playground's three branches after "Create stack MRs…": the top MR docked beside the
  // graph, scrolled to its merge box and the Stack table GitVolt keeps in each description, the
  // branches' MR icons beside it. Left to the graph's lanes.
  {
    id: 'stack',
    needs: ['forgeStack', 'forgeCreateContext', 'forgeCreateMr', 'forgeMrList', 'forgeMrDetail'],
    viewport: { width: 1200, height: 560 },
    run: async (page) => {
      await page.setViewportSize({ width: 1200, height: 750 });
      await page.getByRole('button', { name: 'Tab group: Playground' }).click();
      await page.getByRole('tab', { name: /^stack/ }).click();
      const mrs = page.getByRole('region', { name: 'Merge requests' });
      await expect(mrs).toBeVisible({ timeout: 30_000 });
      await grid(page).locator('.ref-label').getByText('feature/cargo-tests', { exact: true }).first().click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Create stack MRs…', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Create stack MRs' });
      await dialog.getByRole('button', { name: 'Create 3 MRs' }).click();
      await expect(page.getByText(/^Created !\d+, !\d+ and !\d+$/)).toBeVisible();
      await expect(mrs.getByRole('treeitem')).toHaveCount(3);
      await mrs.getByRole('treeitem').filter({ hasText: "Test the hold's limits" }).click();
      const view = page.getByRole('dialog', { name: /^Merge request !\d+$/ });
      await view.getByRole('button', { name: 'Dock beside the graph' }).click();
      const table = page.getByRole('region', { name: 'Description' }).getByRole('table');
      await expect(table.getByRole('row')).toHaveCount(4);
      await page.setViewportSize({ width: 1200, height: 560 });
      // The merge box right under the MR's header, the Stack table under it.
      await view.getByRole('region', { name: 'Merge', exact: true }).evaluate((el) => {
        let s = el.parentElement;
        while (s && !(s.scrollHeight > s.clientHeight + 5 && getComputedStyle(s).overflowY !== 'visible')) s = s.parentElement;
        if (s) s.scrollTop += el.getBoundingClientRect().top - s.getBoundingClientRect().top - 8;
      });
      // The Branch / Tag column wide enough for every branch's whole name.
      const clipped = () => grid(page).locator('.ref-label').evaluateAll((ls) => ls.some((l) => [l, ...l.querySelectorAll('*')].some((e) => e.scrollWidth > e.clientWidth + 1)));
      await page.getByRole('separator', { name: 'Resize Branch / Tag column' }).focus();
      for (let i = 0; i < 20 && (await clipped()); i++) await page.keyboard.press('ArrowRight');
      expect(await clipped()).toBe(false);
      await expect(page.getByText(/^Created !\d+, !\d+ and !\d+$/)).toBeHidden({ timeout: 15_000 });
    },
    clip: async (page) => {
      const sidebar = await box(page.getByRole('complementary', { name: 'Sidebar', exact: true }));
      const message = await box(grid(page).locator('[data-col="message"]').first());
      const x = Math.round(sidebar.x + sidebar.width);
      return { x, y: sidebar.y, width: Math.floor(message.x) - x - 2 };
    },
  },
];

async function capture(page: Page, scene: Scene, viewport: { width: number; height: number }): Promise<void> {
  // Nothing hovered or focused that a visitor wouldn't see at rest.
  if (!scene.pointer) await page.mouse.move(1, viewport.height - 1);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(500);
  const part = scene.clip ? await scene.clip(page) : { x: 0, y: 0, width: viewport.width };
  const clip = { ...part, height: Math.round((part.width * SHOTS[scene.id].height) / SHOTS[scene.id].width) };
  expect(clip.x >= 0 && clip.y >= 0 && clip.x + clip.width <= viewport.width && clip.y + clip.height <= viewport.height, `${scene.id}'s part ${JSON.stringify(clip)} fits the viewport`).toBe(true);
  await page.screenshot({ path: join(out ?? '', `${scene.id}@${SHOTS[scene.id].width * 2}.png`), clip, animations: 'disabled', caret: 'hide' });
}

/** A collage of 2×2 tiles, `gap` px apart, each `tile` px at 1x. A tile is the diff panel at its
 * `width` (Tile), taken at the device scale that makes it twice `tile`'s width: the 2x image's
 * own pixels. At 445 CSS px that is 1.6, the app at 80%: enough of each preview to read at 1x. */
const COLLAGE = { gap: 8, tile: { width: 356, height: 196 } };
/** The page's colour between the tiles (site.css --bg2). */
const COLLAGE_BG = '#0b1230';

async function openDemo(page: Page, viewport: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(viewport);
  await page.goto('demo/demo.html');
  await expect(grid(page)).toBeVisible({ timeout: 60_000 });
  await expect(page).toHaveTitle(/orbital/);
}

/** A tile, as two PNGs: the diff panel's header, through the Diff View row, and the tile's part
 * of the panel under it. The window is sized so the panel is the tile's width and ends at the
 * tile's bottom. */
async function shootTile(browser: Browser, tile: Tile): Promise<[Buffer, Buffer]> {
  const scale = (2 * COLLAGE.tile.width) / tile.width;
  const size = { width: tile.width, height: (2 * COLLAGE.tile.height) / scale };
  const use = test.info().project.use;
  const context = await browser.newContext({ userAgent: use.userAgent, baseURL: use.baseURL, timezoneId: use.timezoneId, locale: use.locale, colorScheme: use.colorScheme, deviceScaleFactor: scale });
  try {
    const page = await context.newPage();
    let viewport = { ...FEATURE };
    await openDemo(page, viewport);
    const part = await tile.show(page);
    // Whole device pixels: a multiple of 1/scale CSS px.
    const snap = (v: number) => Math.round(v * scale) / scale;
    const header = async () => {
      const [p, view, bar] = [await box(diff(page)), await box(diff(page).getByRole('button', { name: 'Diff View' })), await box(diff(page).getByRole('toolbar', { name: 'Diff options' }))];
      return { panel: p, height: snap(Math.min(bar.y + bar.height, view.y + view.height + 5) - p.y) };
    };
    for (let i = 0; i < 6; i++) {
      const [{ panel, height }, b] = [await header(), await box(part)];
      const dx = size.width - panel.width;
      const dy = b.y + size.height - height - (panel.y + panel.height);
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) break;
      viewport = { width: Math.round(viewport.width + dx), height: Math.round(viewport.height + dy) };
      await page.setViewportSize(viewport);
      await page.waitForTimeout(300);
    }
    await page.mouse.move(1, viewport.height - 1);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.waitForTimeout(1_000);
    const [{ panel, height }, b] = [await header(), await box(part)];
    if (tile.settle) {
      await tile.settle(page, part, snap(b.y) + size.height - height);
      await page.waitForTimeout(300);
    }
    expect(Math.abs(panel.width - size.width), `the panel is ${panel.width} px wide`).toBeLessThan(1);
    const shot = (y: number, h: number) => page.screenshot({ clip: { x: snap(panel.x), y: snap(y), width: size.width, height: h }, animations: 'disabled', caret: 'hide' });
    return [await shot(panel.y, height), await shot(b.y, size.height - height)];
  } finally {
    await context.close();
  }
}

/** The tiles side by side on the page's colour, at device scale 2: each tile's pixels as taken. */
async function collage(page: Page, browser: Browser, scene: Scene): Promise<void> {
  const tiles = [];
  for (const tile of scene.tiles ?? []) tiles.push(await shootTile(browser, tile));
  const { width, height } = SHOTS[scene.id];
  const { gap } = COLLAGE;
  await page.setViewportSize({ width, height });
  const img = (png: Buffer) => `<img src="data:image/png;base64,${png.toString('base64')}" alt="">`;
  await page.setContent(`<!doctype html><style>
    html, body { margin: 0; background: ${COLLAGE_BG}; }
    .collage { display: grid; grid-template-columns: repeat(2, ${(width - gap) / 2}px); grid-template-rows: repeat(2, ${(height - gap) / 2}px); gap: ${gap}px; }
    .tile { overflow: hidden; border-radius: 6px; }
    .tile img { display: block; width: 100%; }
  </style><div class="collage">${tiles.map(([head, rest]) => `<div class="tile">${img(head)}${img(rest)}</div>`).join('')}</div>`);
  await page.locator('img').evaluateAll((imgs) => Promise.all((imgs as HTMLImageElement[]).map((i) => i.decode())));
  await page.screenshot({ path: join(out ?? '', `${scene.id}@${width * 2}.png`), animations: 'disabled' });
}

for (const scene of SCENES) {
  test(scene.id, async ({ page, browser }) => {
    const missing = scene.needs.filter((m) => pending.has(m));
    test.skip(missing.length > 0, `needs ${missing.join(', ')}, still PENDING in ui/src/demo/coverage.ts`);
    if (scene.tiles) return collage(page, browser, scene);
    const viewport = scene.viewport ?? FEATURE;
    await openDemo(page, viewport);
    await scene.run?.(page);
    await capture(page, scene, viewport);
  });
}
