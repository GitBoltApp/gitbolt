import { budgetApplies, expect, test, type Locator, type Page } from './test';
import { fixtures, openUrl } from './fixtures';

// Diff prefs persist in localStorage (plan 1B amendment 3). Every test starts from the defaults
// (Inline, no toggles): the key is cleared on the test's first page load only, so a reload inside
// a test keeps what it picked.
const DIFF_PREFS_KEY = 'gitbolt.diffPrefs.v1';
const COMMIT = 'Rename guide and update assets';

const fileRow = (page: Page, path: string) => page.getByRole('option').and(page.locator(`[data-path="${path}"]`));
const diff = (page: Page) => page.getByRole('region', { name: 'Diff' });
/** The original editor's width over the modified one's. Monaco 0.57 keeps the original editor in
 * Inline and Hunk too, as a narrow strip for the old line numbers; in Split they share the width. */
const sideRatio = (page: Page) => diff(page).evaluate((d) => {
  const w = (sel: string) => d.querySelector(sel)?.getBoundingClientRect().width ?? 0;
  return w('.editor.original') / w('.editor.modified');
});
/** Monaco has computed the diff: its inserted-line decorations are drawn. The diff shows once it's
 * computed (off-screen), and the first one also loads the editor's chunk: allow for a cold start. */
const computed = (page: Page) => expect(diff(page).locator('.editor.modified .line-insert').first()).toBeVisible({ timeout: 15_000 });
/** How many diffs (and prefs recomputes) the host has seen finish (`data-diff-computed`). */
const computedCount = (page: Page) => diff(page).locator('.monaco-host').first().evaluate((el) => Number((el as HTMLElement).dataset.diffComputed ?? 0));

interface Frame { path: string | null; lines: string[]; busy: boolean; visible: boolean; phase: 'raf' | 'post' }
/** Starts recording what the diff panel shows: the path, the modified editor's line numbers, and
 * whether it's loading. Twice per frame: in a rAF callback (callbacks run in registration order,
 * so it sees what the previous frame painted, before Monaco's own rAF render) and in a task
 * posted from it (MessageChannel), after every rAF callback of that frame, Monaco's included.
 * Returns a stop function that resolves to the samples. */
async function sampleFrames(page: Page): Promise<() => Promise<Frame[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { sampled: Frame[]; stopSampling: boolean };
    w.sampled = [];
    w.stopSampling = false;
    const sample = (phase: Frame['phase']) => {
      // The one on screen: a closed diff's panel is kept, hidden (J16).
      const panel = [...document.querySelectorAll('.diff-panel')].find((p) => p.getClientRects().length > 0);
      w.sampled.push({
        path: panel?.querySelector('[data-testid="diff-path"]')?.textContent ?? null,
        lines: [...(panel?.querySelectorAll('.editor.modified .margin-view-overlays .line-numbers') ?? [])].map((e) => e.textContent?.trim() ?? ''),
        busy: !!panel && (panel.getAttribute('aria-busy') === 'true' || !!panel.querySelector('[aria-busy="true"]')),
        // The editor is painted (the host hides one still holding another view's diff, H6).
        visible: !!panel?.querySelector('.monaco-host') && getComputedStyle(panel.querySelector('.monaco-host')!).visibility !== 'hidden',
        phase,
      });
    };
    const channel = new MessageChannel();
    channel.port1.onmessage = () => sample('post');
    const loop = () => {
      sample('raf');
      channel.port2.postMessage(null);
      if (!w.stopSampling) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  return async () => {
    // A few more frames after the caller's last wait.
    await page.evaluate(() => new Promise((r) => { let n = 5; const f = () => (--n ? requestAnimationFrame(f) : r(null)); requestAnimationFrame(f); }));
    return page.evaluate(() => {
      const w = window as unknown as { sampled: Frame[]; stopSampling: boolean };
      w.stopSampling = true;
      return w.sampled;
    });
  };
}

/** What the diff panel on screen actually paints (K7), as one string: `panel:<header path>` when
 * a panel is shown, then every text of its body and `img:W×H` (natural size) for every image layer that
 * `checkVisibility` counts as painted (laid out, `visibility: visible`, no ancestor at opacity 0).
 * Runs in the page; `painted(page)` evaluates it once. */
function paintedNow(): string {
  const shown = (el: Element) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const panel = [...document.querySelectorAll('.diff-panel')].find((p) => shown(p));
  const body = panel?.querySelector('.diff-body');
  if (!panel || !body) return '';
  const out = [`panel:${panel.querySelector('[data-testid="diff-path"]')?.textContent ?? ''}`];
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    // Monaco draws a line's spaces as no-break spaces.
    const text = n.textContent?.replace(/\u00a0/g, ' ').trim();
    if (text && n.parentElement && shown(n.parentElement)) out.push(text);
  }
  for (const img of body.querySelectorAll<HTMLImageElement>('img.image-layer')) if (img.naturalWidth && shown(img)) out.push(`img:${img.naturalWidth}×${img.naturalHeight}`);
  return out.join('|');
}
const painted = (page: Page) => page.evaluate(paintedNow);

/** `paintedNow` twice per frame (a rAF callback, and a task posted from it: `sampleFrames`'
 * pattern) until the returned stop function, which resolves to the samples. */
async function samplePainted(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate((fn) => {
    const now = new Function(`return (${fn})()`) as () => string;
    const w = window as unknown as { paintedSamples: string[]; stopPainted: boolean };
    w.paintedSamples = [];
    w.stopPainted = false;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => w.paintedSamples.push(now());
    const loop = () => {
      w.paintedSamples.push(now());
      channel.port2.postMessage(null);
      if (!w.stopPainted) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }, paintedNow.toString());
  return async () => {
    await page.evaluate(() => new Promise((r) => { let n = 5; const f = () => (--n ? requestAnimationFrame(f) : r(null)); requestAnimationFrame(f); }));
    return page.evaluate(() => {
      const w = window as unknown as { paintedSamples: string[]; stopPainted: boolean };
      w.stopPainted = true;
      return w.paintedSamples;
    });
  };
}

async function selectCommit(page: Page) {
  await page.getByRole('row').filter({ hasText: COMMIT }).click();
  await expect(page.getByTestId('file-counts')).toBeVisible();
}

async function open(page: Page, path: string) {
  await fileRow(page, path).click();
  await expect(diff(page).getByTestId('diff-path')).toContainText(path.split('/').pop()!);
}

// One page per group of checks below (each `test.step` was a test of its own, paying for a page
// load and Monaco's start-up). The steps run in an order where each starts from what it needs:
// no file open or another one, and the default mode until a step picks another.
test.describe('diff viewer controls', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((key) => {
      if (sessionStorage.getItem('diff-prefs-cleared')) return;
      localStorage.removeItem(key);
      sessionStorage.setItem('diff-prefs-cleared', '1');
    }, DIFF_PREFS_KEY);
    await page.goto(openUrl(fixtures.details));
    await selectCommit(page);
  });

  test('the view modes and toggles: Hunk, Inline and Split, the colours, Word wrap; the picked mode is remembered across a reload', async ({ page }) => {
    await test.step('Inline pressed by default; Hunk, Inline and Split views', async () => {
      await open(page, 'src/app.php');
      const d = diff(page);
      await expect(d.getByRole('button', { name: 'Inline' })).toHaveAttribute('aria-pressed', 'true');
      await computed(page);
      await expect(d.locator('.diff-hidden-lines')).toHaveCount(0);
      await expect.poll(() => sideRatio(page)).toBeLessThan(0.2);
      await d.getByRole('button', { name: 'Hunk' }).click();
      await expect(d.getByRole('button', { name: 'Hunk' })).toHaveAttribute('aria-pressed', 'true');
      // Monaco 0.57's `.diff-hidden-lines` box is 0 px tall; its `.center` is the visible
      // "N hidden lines" bar (as in files.spec.ts).
      await expect(d.locator('.editor.modified .diff-hidden-lines .center').first()).toBeVisible();
      await expect.poll(() => sideRatio(page)).toBeLessThan(0.2);
      await d.getByRole('button', { name: 'Split' }).click();
      await expect.poll(() => sideRatio(page)).toBeGreaterThan(0.8);
      // Monaco 0.57 forces `minimap.enabled = false` on both of the diff's inner editors
      // (DiffEditorEditors._adjustOptionsForSubEditor); the diff's own overview ruler takes its place.
      await expect(d.locator('.monaco-diff-editor .diffOverview')).toBeVisible();
      await d.getByRole('button', { name: 'Inline' }).click();
      await expect.poll(() => sideRatio(page)).toBeLessThan(0.2);
      await expect(d.locator('.diff-hidden-lines')).toHaveCount(0);
    });

    await test.step('Ctrl+Shift+3 / 1 / 2 pick Split, Hunk and Inline from the keyboard', async () => {
      const d = diff(page);
      await page.keyboard.press('Control+Shift+Digit3');
      await expect(d.getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => sideRatio(page)).toBeGreaterThan(0.8);
      await page.keyboard.press('Control+Shift+Digit1');
      await expect(d.getByRole('button', { name: 'Hunk' })).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.press('Control+Shift+Digit2');
      await expect(d.getByRole('button', { name: 'Inline' })).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => sideRatio(page)).toBeLessThan(0.2);
    });

    await test.step('diff colours are forest green and brick red, lighter for whole lines', async () => {
      const d = diff(page);
      await d.getByRole('button', { name: 'Split' }).click();
      const bg = (sel: string) => d.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);
      await expect.poll(() => bg('.editor.modified .line-insert')).toBe('rgba(92, 184, 92, 0.1)');
      expect(await bg('.editor.modified .char-insert')).toBe('rgba(92, 184, 92, 0.12)');
      expect(await bg('.editor.original .line-delete')).toBe('rgba(217, 65, 61, 0.15)');
      expect(await bg('.editor.original .char-delete')).toBe('rgba(217, 65, 61, 0.2)');
    });

    await test.step('Word wrap wraps the long line', async () => {
      const d = diff(page);
      await expect(d.getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true');
      const longLine = d.locator('.editor.modified .view-line', { hasText: 'long line' });
      await expect(longLine).toHaveCount(1);
      // The left side too, after Inline then Split: Monaco left its inline-mode "never wrap the
      // hidden editor" override on the original side (diff/monaco/originalWrap.ts).
      const oldLongLine = d.locator('.editor.original .view-line', { hasText: 'long line' });
      await expect(oldLongLine).toHaveCount(1);
      await d.getByRole('button', { name: 'Word wrap' }).click();
      await expect.poll(() => longLine.count()).toBeGreaterThan(1);
      await expect.poll(() => oldLongLine.count()).toBeGreaterThan(1);
    });

    await test.step('the picked mode is remembered across a reload', async () => {
      await expect(diff(page).getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true');
      await page.reload();
      await selectCommit(page);
      await open(page, 'src/app.php');
      const d = diff(page);
      await expect(d.getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true');
      await expect(d.getByRole('button', { name: 'Inline' })).toHaveAttribute('aria-pressed', 'false');
      // The reloaded page's first diff loads the editor's chunk again: allow for a cold start.
      await expect.poll(() => sideRatio(page), { timeout: 15_000 }).toBeGreaterThan(0.8);
    });
  });

  test("the toolbar's layout at every width, a rename's header, and the focus a toolbar click leaves", async ({ page }) => {
    await test.step("a rename's header: the common base, old ⇒ new with only the new name bright; a stacked tooltip (H21)", async () => {
      await open(page, 'docs/manual.txt');
      const path = diff(page).getByTestId('diff-path');
      await expect(path).toHaveText('docs/guide.txt ⇒ manual.txt');
      await expect(path.locator('strong')).toHaveText('manual.txt');
      const color = (l: Locator) => l.evaluate((el) => getComputedStyle(el).color);
      expect(await color(path.locator('strong'))).not.toBe(await color(path.locator('.crumb').first()));
      await path.hover();
      const tip = page.getByRole('tooltip');
      await expect(tip.locator('.rename-paths > *')).toHaveText(['docs/guide.txt', '↓', 'docs/manual.txt']);
      // The paths left-aligned, the arrow centred between them.
      const [a, arrow, b, box] = await Promise.all([...[0, 1, 2].map((i) => tip.locator('.rename-paths > *').nth(i).boundingBox()), tip.locator('.rename-paths').boundingBox()]);
      expect(Math.abs(a!.x - b!.x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(arrow!.x + arrow!.width / 2 - (box!.x + box!.width / 2))).toBeLessThanOrEqual(1);
    });

    await test.step('toolbar (H9): File/Diff centred; Blame | History, prev/next, the modes, then the toggles at the far right', async () => {
      // Centring needs a ~930 px centre panel with #3's Blame | History (narrower, File/Diff moves
      // left of centre: the next step): 1400 px less the 400 px details panel.
      await page.setViewportSize({ width: 1400, height: 720 });
      await open(page, 'src/app.php');
      const d = diff(page);
      const bar = (await d.getByRole('toolbar', { name: 'Diff options' }).boundingBox())!;
      const views = (await d.getByRole('button', { name: 'File View' }).locator('..').boundingBox())!;
      const box = async (l: Locator) => (await l.boundingBox())!;
      const [history, prev, next, modes, ws, wrap] = await Promise.all([
        box(d.getByRole('group', { name: 'History' })),
        box(d.getByRole('button', { name: 'Previous change' })),
        box(d.getByRole('button', { name: 'Next change' })),
        box(d.getByRole('group', { name: 'View mode' })),
        box(d.getByRole('button', { name: 'Ignore whitespace' })),
        box(d.getByRole('button', { name: 'Word wrap' })),
      ]);
      expect(Math.abs(views.x + views.width / 2 - (bar.x + bar.width / 2))).toBeLessThanOrEqual(2);
      // Left to right after the centre: Blame | History, prev, next, the modes, whitespace, wrap.
      expect(views.x + views.width).toBeLessThan(history.x);
      expect([history.x + history.width <= prev.x, prev.x < next.x, next.x < modes.x, modes.x + modes.width <= ws.x, ws.x < wrap.x]).toEqual([true, true, true, true, true]);
      // Only the toolbar's padding (8 px) past the last toggle.
      expect(bar.x + bar.width - (wrap.x + wrap.width)).toBeLessThanOrEqual(9);
      for (const name of ['Ignore whitespace', 'Word wrap', 'Previous change', 'Next change']) await expect(d.getByRole('button', { name })).toHaveText('');
      await page.keyboard.press('Escape');
      await expect(diff(page)).toHaveCount(0);
    });

    await test.step('toolbar: at narrow centre widths nothing overlaps, and every control stays inside the bar', async () => {
      // With the default 400 px details panel: 1280 px gives an 880 px centre (one row, too narrow
      // to centre File/Diff View: it moves left), 1060 px a 660 px one (just under the 760 px
      // wrapping breakpoint) and 900 px a 500 px one. At 720 px the panel
      // clamps to 400 (innerWidth − CENTER_MIN), so the centre is CENTER_MIN, 320 px.
      for (const width of [1280, 1060, 900, 720]) {
        await page.setViewportSize({ width, height: 700 });
        await open(page, 'src/app.php');
        const d = diff(page);
        const bar = (await d.getByRole('toolbar', { name: 'Diff options' }).boundingBox())!;
        // Open in… (J1) is on the bar too, at its far left.
        await expect(d.getByRole('toolbar', { name: 'Diff options' }).getByRole('group', { name: 'Open in' })).toBeVisible();
        const boxes = await Promise.all([
          d.getByRole('toolbar', { name: 'Diff options' }).getByRole('group', { name: 'Open in' }),
          d.getByRole('toolbar', { name: 'Diff options' }).getByRole('group', { name: 'History' }),
          d.getByRole('button', { name: 'Previous change' }),
          d.getByRole('button', { name: 'Next change' }),
          d.getByRole('button', { name: 'File View' }).locator('..'),
          d.getByRole('button', { name: 'Ignore whitespace' }),
          d.getByRole('button', { name: 'Word wrap' }),
          d.getByRole('group', { name: 'View mode' }),
        ].map(async (l) => (await l.boundingBox())!));
        for (const b of boxes) {
          expect(b.x).toBeGreaterThanOrEqual(bar.x);
          expect(b.y).toBeGreaterThanOrEqual(bar.y - 0.5);
          expect(b.x + b.width).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
          expect(b.y + b.height).toBeLessThanOrEqual(bar.y + bar.height + 0.5);
        }
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const [a, b] = [boxes[i], boxes[j]];
            const apart = a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5 || a.y + a.height <= b.y + 0.5 || b.y + b.height <= a.y + 0.5;
            expect(apart, `controls ${i} and ${j} overlap at ${width} px`).toBe(true);
          }
        }
        await page.keyboard.press('Escape');
      }
    });

    await test.step('a toolbar click leaves the focus in the file list: ↓ then opens the next file', async () => {
      await page.setViewportSize({ width: 1280, height: 720 });
      // Closed first (the last width's Esc may not have reached the list).
      if (await diff(page).count()) await diff(page).getByRole('button', { name: 'Close diff' }).click();
      await expect(diff(page)).toHaveCount(0);
      await open(page, 'src/app.php');
      const d = diff(page);
      await expect(page.getByRole('listbox', { name: 'Changed files' })).toBeFocused();
      await d.getByRole('button', { name: 'Split' }).click();
      await expect(d.getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByRole('listbox', { name: 'Changed files' })).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(d.getByTestId('diff-path')).toContainText('ws.txt', { timeout: 15_000 });
    });
  });

  // K7: what the panel paints while it switches files is only ever the file its header names.
  test('K7: a held editor takes no click or focus; switching, closing and reopening files never paints a stale file, text or image', async ({ page }) => {
    test.setTimeout(60_000);
    // Fix round 1: while hidden (another file computing), the held editor can't be clicked or
    // focused, though Monaco forces its inner editors visible; shown, it's the editor again. First:
    // it holds the page's first load of the PHP grammar.
    await test.step('K7: the hidden held editor takes no click and no focus; shown, it takes both', async () => {
      // A certain hidden gap: the held editor stays hidden until app.php is presented, and that
      // first waits for its PHP grammar, a chunk of its own (the dev server's pre-bundled module, or
      // the production build's asset). Hold it ~400 ms.
      // (Holding the file's contents wouldn't do: the panel shows "Loading…" instead, the editor
      // detached, and app.php is prefetched as ws.txt's neighbour anyway.)
      let held = 0;
      await page.route(/\/(\.vite\/deps|assets)\/php-[^/]*\.js/, async (route) => {
        held++;
        await new Promise((r) => setTimeout(r, 400));
        await route.continue();
      });
      await open(page, 'ws.txt');
      await expect.poll(() => painted(page), { timeout: 15_000 }).toContain('fn main() {');
      await diff(page).getByRole('button', { name: 'Close diff' }).click();
      await page.evaluate(() => {
        const w = window as unknown as { hiddenProbes: string[]; stopProbe: boolean };
        w.hiddenProbes = [];
        w.stopProbe = false;
        const probe = () => {
          const host = [...document.querySelectorAll<HTMLElement>('.diff-panel .monaco-host')].find((h) => h.checkVisibility());
          if (host && host.style.opacity === '0') {
            const r = host.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            host.querySelector<HTMLElement>('.editor.modified textarea')?.focus();
            w.hiddenProbes.push(`inert=${host.inert} hit=${!!hit && host.contains(hit)} focus=${host.contains(document.activeElement)}`);
          }
          if (!w.stopProbe) requestAnimationFrame(probe);
        };
        requestAnimationFrame(probe);
      });
      await fileRow(page, 'src/app.php').click();
      await expect.poll(() => painted(page), { timeout: 15_000 }).toContain('enum Suit');
      const probes = await page.evaluate(() => { const w = window as unknown as { hiddenProbes: string[]; stopProbe: boolean }; w.stopProbe = true; return w.hiddenProbes; });
      expect(held).toBeGreaterThan(0);
      expect(probes.length).toBeGreaterThan(0);
      expect([...new Set(probes)]).toEqual(['inert=true hit=false focus=false']);
      const line = diff(page).locator('.editor.modified .view-line').filter({ hasText: 'final class Card' });
      await line.click();
      await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.editor.modified'))).toBe(true);
      // The PHP grammar is loaded now: the steps below run unheld.
      await page.unroute(/\/(\.vite\/deps|assets)\/php-[^/]*\.js/);
    });
    // K7: open a file, ×, open another: the kept panel's editor still holds the first file until the
    // second is presented. The host's `visibility: hidden` didn't hide it: Monaco's diff editor sets
    // `visibility: visible` on its two inner editors, which a descendant's own value wins over. This
    // samples what is actually painted (`checkVisibility`: laid out, visible, no ancestor at
    // opacity 0), text and images, in every frame from the click on.
    await test.step('K7: a file, ×, then another: the first is never painted again (text and image pairs)', async () => {
      for (const [first, second, stale, fresh] of [
        ['ws.txt', 'src/app.php', 'fn main() {', 'enum Suit'],
        ['crlf.txt', 'docs/manual.txt', 'second', 'Step one.'],
        ['src/app.php', 'logo.png', 'enum Suit', 'img:6×4'],
        ['logo.png', 'icon.svg', 'img:6×4', 'img:16×16'],
        ['icon.svg', 'logo.png', 'img:16×16', 'img:6×4'],
      ] as const) {
        const at = `${first}, ×, then ${second}`;
        await open(page, first);
        await expect.poll(() => painted(page), { timeout: 15_000, message: at }).toContain(stale);
        await diff(page).getByRole('button', { name: 'Close diff' }).click();
        await expect(diff(page)).toHaveCount(0);
        const stop = await samplePainted(page);
        await fileRow(page, second).click();
        await expect.poll(() => painted(page), { timeout: 15_000, message: at }).toContain(fresh);
        const frames = await stop();
        expect(frames.length, at).toBeGreaterThan(6);
        expect(frames.filter((f) => f.includes(stale)), at).toEqual([]);
        expect(frames.at(-1), at).toContain(fresh);
        // Closed before the next pair: a click on the open file's own row would close it.
        await diff(page).getByRole('button', { name: 'Close diff' }).click();
        await expect(diff(page)).toHaveCount(0);
      }
    });

    // K7 via the editor's older content: the image in between leaves the editor holding ws.txt,
    // which must stay unpainted when app.php reopens the text diff.
    await test.step('K7: a text file, an image, ×, then another text file: the first text file is never painted', async () => {
      await open(page, 'ws.txt');
      await expect.poll(() => painted(page), { timeout: 15_000 }).toContain('fn main() {');
      await open(page, 'logo.png');
      await expect.poll(() => painted(page)).toContain('img:6×4');
      await diff(page).getByRole('button', { name: 'Close diff' }).click();
      const stop = await samplePainted(page);
      await fileRow(page, 'src/app.php').click();
      await expect.poll(() => painted(page), { timeout: 15_000 }).toContain('enum Suit');
      const frames = await stop();
      expect(frames.filter((f) => f.includes('fn main() {') || f.includes('img:'))).toEqual([]);
    });

    await test.step('K7: reopening the same file is instant: it is painted in the first frame after the click', async () => {
      await open(page, 'ws.txt');
      await expect.poll(() => painted(page), { timeout: 15_000 }).toContain('fn main() {');
      await diff(page).getByRole('button', { name: 'Close diff' }).click();
      const stop = await samplePainted(page);
      await fileRow(page, 'ws.txt').click();
      await expect.poll(() => painted(page)).toContain('fn main() {');
      const frames = (await stop()).filter((f) => f.startsWith('panel'));
      expect(frames[0]).toContain('fn main() {');
    });

    // K7, the direct switch (lane V's report): ↑/↓ from file to file, through a large file's
    // message, a binary, images and text. Every painted frame shows one file, the header's: the
    // header waits for the editor only while the editor still shows the header's file.
    await test.step('K7: stepping through every file with ↑/↓, each painted frame shows only the file its header names', async () => {
      const MARKS: Record<string, string[]> = {
        'big.txt': ['Large file'], 'crlf.txt': ['second', 'Only line endings changed'], 'data.bin': ['BIN...'], 'ünï.txt': ['unicode path'],
        'manual.txt': ['revised'], 'icon.svg': ['img:16×16'], 'logo.png': ['img:6×4', 'img:4×4'], 'old.txt': ['to be deleted'], 'app.php': ['filler11'], 'ws.txt': ['fn main() {'],
      };
      const fileOf = (f: string) => Object.keys(MARKS).find((k) => f.split('|')[0].includes(k)) ?? null;
      await open(page, 'crlf.txt');
      await expect.poll(() => painted(page), { timeout: 15_000 }).toContain('second');
      const stop = await samplePainted(page);
      const walk = [['ArrowUp', 'big.txt'], ['ArrowDown', 'crlf.txt'], ...['data.bin', 'ünï.txt', 'manual.txt', 'icon.svg', 'logo.png', 'old.txt', 'app.php', 'ws.txt'].map((p) => ['ArrowDown', p]), ['ArrowUp', 'app.php'], ['ArrowUp', 'old.txt']] as const;
      const reached = (file: string) => expect.poll(async () => { const f = await painted(page); return fileOf(f) === file && MARKS[file].some((m) => f.includes(m)); }, { timeout: 15_000 }).toBe(true);
      for (const [key, file] of walk) {
        await page.keyboard.press(key);
        await reached(file);
      }
      // And a click, from one text diff to another with a banner (crlf.txt's line endings).
      await fileRow(page, 'crlf.txt').click();
      await reached('crlf.txt');
      const frames = (await stop()).filter((f) => f.startsWith('panel'));
      expect(frames.length).toBeGreaterThan(20);
      const mixed = frames.filter((f) => {
        const own = fileOf(f);
        return Object.entries(MARKS).some(([file, marks]) => file !== own && marks.some((m) => f.includes(m)));
      });
      expect(mixed).toEqual([]);
      // Nor a header left behind: once a file's body is painted, the header naming it goes when its
      // body does (the next file's editor, hidden while it computes, is no reason to keep it).
      const orphaned = frames.filter((f, i) => {
        const own = fileOf(f);
        const has = (g: string) => MARKS[own!]?.some((m) => g.includes(m));
        if (!own || has(f)) return false;
        for (let j = i - 1; j >= 0 && fileOf(frames[j]) === own; j--) if (has(frames[j])) return true;
        return false;
      });
      expect(orphaned).toEqual([]);
    });

    // In every mode, from a prefetched neighbour (ws.txt) and from a file loaded on the click
    // (crlf.txt): app.php swaps in whole. Neither ws.txt (4 lines) nor crlf.txt (3) shows a line
    // past 5. Hunk: app.php's line 20 sits inside its collapsed region and 52 is shown; Inline and
    // Split show line 10 (its first change, line 5, is on the first screen: no reveal).
    await test.step('every mode: switching files swaps in the new diff whole, never a blank editor, Loading or (Hunk) the full file', async () => {
      for (const [mode, marker, hidden] of [['Hunk', '52', '20'], ['Inline', '10', null], ['Split', '10', null]] as const) {
        for (const from of ['ws.txt', 'crlf.txt']) {
          const at = `${mode}, from ${from}`;
          await open(page, from);
          const d = diff(page);
          await d.getByRole('button', { name: mode }).click();
          await expect(d.getByRole('button', { name: mode })).toHaveAttribute('aria-pressed', 'true');
          await expect.poll(() => computedCount(page), { timeout: 15_000 }).toBeGreaterThan(0);
          const stop = await sampleFrames(page);
          await fileRow(page, 'src/app.php').click();
          await expect(d.locator('.editor.modified .margin-view-overlays .line-numbers').filter({ hasText: new RegExp(`^${marker}$`) })).toBeVisible();
          const frames = await stop();
          expect(frames.filter((f) => f.phase === 'post').length, at).toBeGreaterThan(3);
          expect(frames.filter((f) => f.lines.length === 0 || f.busy), at).toEqual([]);
          if (hidden) expect(frames.filter((f) => f.lines.includes(hidden)), at).toEqual([]);
          // Header and editor switch together: app.php's path only over app.php's diff, the
          // previous path only over the previous diff.
          expect(frames.filter((f) => (f.path === 'src/app.php') !== f.lines.includes(marker)), at).toEqual([]);
          expect(frames.at(-1), at).toMatchObject({ path: 'src/app.php' });
          expect(frames.at(-1)!.lines, at).toContain('5');
        }
      }
    });

    // H6: close the file, select another commit, open a file there (Split): the one editor is shared,
    // and it still holds the first commit's diff. It must never be painted under the new header.
    await test.step("reopening after a close shows only the new commit's file, never the previous one for a frame (Split)", async () => {
      const d = diff(page);
      await expect(d.getByTestId('diff-path')).toContainText('app.php');
      await d.getByRole('button', { name: 'Split' }).click();
      await expect(d.locator('.editor.modified .margin-view-overlays .line-numbers').filter({ hasText: /^10$/ })).toBeVisible({ timeout: 15_000 });
      await page.keyboard.press('Escape');
      await expect(d).toHaveCount(0);
      await page.getByRole('row').filter({ hasText: 'Add feature file' }).click();
      await expect(fileRow(page, 'feature.txt')).toBeVisible();
      const stop = await sampleFrames(page);
      await fileRow(page, 'feature.txt').click();
      await expect(d.locator('.editor.modified .view-line').filter({ hasText: /^feature$/ })).toBeVisible();
      const frames = await stop();
      expect(frames.filter((f) => f.phase === 'post').length).toBeGreaterThan(3);
      // feature.txt has one line: any painted frame with app.php's line 10 is the stale diff.
      expect(frames.filter((f) => f.visible && f.lines.includes('10'))).toEqual([]);
      expect(frames.at(-1)).toMatchObject({ path: 'feature.txt', visible: true });
    });
  });

  test('the keyboard in the diff: F7/Shift+F7 and Shift+↑/↓ step the changes, Shift+↓ in the editor selects, Esc closes the file (J4, J14)', async ({ page }) => {
    test.setTimeout(60_000);
    const d = diff(page);
    const active = d.locator('.editor.modified .active-line-number');

    await test.step('right after a file is clicked, with the file list focused, F7 and Shift+↑/↓ step the changes; plain ↓ still switches files (J14)', async () => {
      await open(page, 'src/app.php');
      await computed(page);
      const list = page.getByRole('listbox', { name: 'Changed files' });
      await expect(list).toBeFocused();
      // Opened on its first change (line 5), the cursor there: F7 goes to the second.
      await expect(active).toHaveText('5');
      await page.keyboard.press('F7');
      await expect(active).toHaveText('55');
      await page.keyboard.press('Shift+ArrowUp');
      await expect(active).toHaveText('5');
      await page.keyboard.press('Shift+ArrowDown');
      await expect(active).toHaveText('55');
      await page.keyboard.press('Shift+ArrowUp');
      await expect(active).toHaveText('5');
      await page.keyboard.press('Shift+ArrowDown');
      await expect(active).toHaveText('55');
      // Still the same file, and the list keeps the keyboard.
      await expect(d.getByTestId('diff-path')).toContainText('app.php');
      await expect(list).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(d.getByTestId('diff-path')).toContainText('ws.txt');
      await d.getByRole('button', { name: 'Close diff' }).click();
      await expect(d).toHaveCount(0);
    });

    await test.step('Shift+↓ inside the editor extends its selection, not a change step (J14)', async () => {
      await open(page, 'src/app.php');
      await computed(page);
      await d.locator('.editor.modified .view-line').filter({ hasText: 'final class Card' }).click();
      const line = await active.textContent();
      await page.keyboard.press('Shift+ArrowDown');
      await page.keyboard.press('Shift+ArrowDown');
      // A selection of two lines, and the cursor two lines on: not at a change (5 or 55).
      await expect(d.locator('.editor.modified .selected-text')).not.toHaveCount(0);
      await expect(active).toHaveText(String(Number(line) + 2));
      await d.getByRole('button', { name: 'Close diff' }).click();
      await expect(d).toHaveCount(0);
    });

    await test.step('Esc closes the file even from inside the editor with a selection; an open find widget closes first; from the file list it closes the file (J4)', async () => {
      await open(page, 'src/app.php');
      await computed(page);
      // A selection in the editor: Monaco's own Esc (cancelSelection) would take the key.
      await d.locator('.editor.modified .view-line').filter({ hasText: 'final class Card' }).getByText('Card', { exact: true }).dblclick();
      await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.editor.modified'))).toBe(true);
      await expect(d.locator('.editor.modified .selected-text').first()).toBeVisible();
      // WebKit's "Desktop Safari" user agent makes Monaco use the macOS bindings.
      await page.keyboard.press('Control+f');
      const find = d.locator('.editor.modified .find-widget.visible');
      await expect(find).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(find).toHaveCount(0);
      await expect(d).toBeVisible();
      // The shared context menu replaces Monaco's own once a diff has opened (plan 1C Task 15):
      // Esc closes the menu, not the file.
      await d.locator('.editor.modified .view-line').filter({ hasText: 'final class Card' }).click({ button: 'right' });
      const menu = page.getByTestId('context-menu');
      await expect(menu).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).not.toBeVisible();
      await expect(d).toBeVisible();
      await d.locator('.editor.modified .view-line').filter({ hasText: 'final class Card' }).getByText('Card', { exact: true }).dblclick();
      await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.editor.modified'))).toBe(true);
      await page.keyboard.press('Escape');
      await expect(d).toHaveCount(0);
      await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
      // J4: with the find widget still open, Esc from the file list closes the file, and the graph
      // has the keyboard.
      await open(page, 'src/app.php');
      await d.locator('.editor.modified .view-line').filter({ hasText: 'final class Card' }).click();
      await page.keyboard.press('Control+f');
      await expect(find).toBeVisible();
      await page.getByRole('listbox', { name: 'Changed files' }).focus();
      await page.keyboard.press('Escape');
      await expect(d).toHaveCount(0);
      await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeFocused();
    });

    await test.step('F7 and Shift+F7 move between changes, and wrap at the ends', async () => {
      await open(page, 'src/app.php');
      await d.getByRole('button', { name: 'Split' }).click();
      await computed(page);
      // A click in the diff zone puts the keyboard in the editor; F7 is still the panel's.
      await d.getByTestId('diff-path').click();
      await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.editor.modified'))).toBe(true);
      // Opened on the first change (line 5).
      await page.keyboard.press('F7');
      await expect(active).toHaveText('55');
      await page.keyboard.press('Shift+F7');
      await expect(active).toHaveText('5');
      await d.getByRole('button', { name: 'Next change' }).click();
      await expect(active).toHaveText('55');
      // src/app.php has exactly two changes, at lines 5 and 55: F7 wraps from the last to the first
      // (on from the change it went to, though the end of the file keeps line 55 below the
      // centre), and Shift+F7 back.
      await page.keyboard.press('F7');
      await expect(active).toHaveText('5');
      await page.keyboard.press('Shift+F7');
      await expect(active).toHaveText('55');
    });
  });

  test('closing and reopening a file wakes the kept panel fast: the reopen is well under the cold open (J16)', { tag: '@budget' }, async ({ page }) => {
    const ready: number[] = [];
    page.on('console', (m) => {
      const t = /\[gitbolt\] diff ready in (\d+) ms/.exec(m.text());
      if (t) ready.push(Number(t[1]));
    });
    const d = diff(page);
    await open(page, 'src/app.php');
    await computed(page);
    await expect.poll(() => ready.length).toBe(1);
    for (let i = 0; i < 3; i++) {
      // The open file's row toggles it closed (H5b), and again open.
      await fileRow(page, 'src/app.php').click();
      await expect(d).toHaveCount(0);
      await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
      await open(page, 'src/app.php');
      await expect.poll(() => ready.length).toBe(i + 2);
      await expect(d.locator('.editor.modified .line-insert').first()).toBeVisible();
    }
    const [cold, ...reopens] = ready;
    // Before J16 a reopen remounted the panel and its lazy chunk suspended: React holds a
    // revealed Suspense boundary back ~300 ms. Now it's the diff's own present, tens of ms.
    if (budgetApplies()) for (const t of reopens) expect(t, `cold ${cold} ms, reopens ${reopens.join(', ')} ms`).toBeLessThan(Math.min(cold / 3, 200));
  });

  test('what a file shows: an EOL-only banner, a large file asks first, Ignore whitespace, File View, and an unchanged file with Diff View off', async ({ page }) => {
    const d = diff(page);
    await test.step('an EOL-only change shows a banner', async () => {
      await open(page, 'crlf.txt');
      await expect(d.getByRole('note')).toHaveText('Only line endings changed (CRLF → LF)');
    });

    await test.step('a large file asks before loading', async () => {
      await open(page, 'big.txt');
      await expect(d.getByText('Large file — load anyway?')).toBeVisible();
      await d.getByRole('button', { name: 'Load anyway' }).click();
      // Shown once its (80,000-line) diff has computed.
      await expect(d.getByTestId('text-diff')).toContainText('line 00000 of the big file', { timeout: 15_000 });
    });

    await test.step('Ignore whitespace hides a re-indentation', async () => {
      await open(page, 'ws.txt');
      await d.getByRole('button', { name: 'Split' }).click();
      await expect.poll(() => d.locator('.editor.modified .line-insert').count(), { timeout: 15_000 }).toBeGreaterThan(0);
      // The diff recomputes after the toggle: wait for that result, so "no inserted lines" can't be
      // read off the gap in between.
      const before = await computedCount(page);
      await d.getByRole('button', { name: /Ignore whitespace/ }).click();
      await expect(d.getByRole('button', { name: /Ignore whitespace/ })).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => computedCount(page)).toBeGreaterThan(before);
      await expect(d.locator('.editor.modified .line-insert')).toHaveCount(0);
    });

    await test.step('File View shows the whole file at the commit', async () => {
      await open(page, 'src/app.php');
      await d.getByRole('button', { name: 'File View' }).click();
      await expect(d.getByTestId('file-view')).toContainText('enum Suit: string');
      await d.getByRole('button', { name: 'Diff View' }).click();
      await expect(d.getByTestId('text-diff')).toBeVisible();
    });

    await test.step('an unchanged file from View all files has Diff View disabled', async () => {
      await page.getByRole('button', { name: 'View all files' }).click();
      await open(page, 'latin1.txt');
      await expect(d.getByTestId('file-view')).toBeVisible();
      await expect(d.getByRole('button', { name: 'File View' })).toHaveAttribute('aria-pressed', 'true');
      await expect(d.getByRole('button', { name: 'Diff View' })).toBeDisabled();
    });
  });
});

// The `diff_view` fixture: 200-line long.txt, first changed at line 120 (fixtures.rs).
test.describe('presenting a long file', () => {
  /** Whether modified line `line` sits in the middle third of the editor's viewport. */
  const inMiddleThird = (page: Page, line: number) => diff(page).locator('.editor.modified').evaluate((ed, n) => {
    const box = ed.querySelector('.overflow-guard')!.getBoundingClientRect();
    const row = [...ed.querySelectorAll('.margin-view-overlays .line-numbers')].find((e) => Number(e.textContent) === n);
    if (!row) return false;
    const mid = (row.getBoundingClientRect().top + row.getBoundingClientRect().bottom) / 2;
    return mid >= box.top + box.height / 3 && mid <= box.top + (2 * box.height) / 3;
  }, line);
  /** The smallest line number the modified editor draws: the top of its viewport. */
  const topLine = (page: Page) => diff(page).locator('.editor.modified .margin-view-overlays .line-numbers').evaluateAll((els) => Math.min(...els.map((e) => Number(e.textContent))));
  /** The line whose number sits at the vertical centre of `side`'s viewport, or null. */
  const centreLineOf = (page: Page, side: 'modified' | 'original') => diff(page).locator(`.editor.${side}`).evaluate((ed) => {
    const box = ed.querySelector('.overflow-guard')!.getBoundingClientRect();
    const y = box.top + box.height / 2;
    const hit = [...ed.querySelectorAll('.margin-view-overlays .line-numbers')].find((n) => {
      const r = n.getBoundingClientRect();
      return r.top <= y && y < r.bottom;
    });
    return hit ? Number(hit.textContent) : null;
  });
  /** Whether the old lines `from`-`to` (in the original strip) sit between the viewport's top and
   * its centre. */
  const oldLinesAboveCentre = (page: Page, from: number, to: number) => diff(page).locator('.editor.original').evaluate((ed, [a, b]) => {
    const box = ed.querySelector('.overflow-guard')!.getBoundingClientRect();
    const rows = [...ed.querySelectorAll('.margin-view-overlays .line-numbers')].filter((n) => Number(n.textContent) >= a && Number(n.textContent) <= b);
    return rows.length > 0 && rows.every((n) => n.getBoundingClientRect().top >= box.top && n.getBoundingClientRect().bottom <= box.top + box.height / 2);
  }, [from, to]);
  /** Every diff the page's editors have computed (`data-diff-computed`, summed): 0 before the first. */
  const computedSum = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.monaco-host')].reduce((n, h) => n + Number(h.dataset.diffComputed ?? 0), 0));
  /** Opens `path` (another file than the editor holds: a new presentation) and waits for its diff.
   * The first one also loads the editor's chunk: allow for a cold start. */
  const present = async (page: Page, path: string) => {
    const before = await computedSum(page);
    await open(page, path);
    await expect.poll(() => computedSum(page), { timeout: 15_000 }).toBeGreaterThan(before);
  };

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((key) => {
      if (sessionStorage.getItem('diff-prefs-cleared')) return;
      localStorage.removeItem(key);
      sessionStorage.setItem('diff-prefs-cleared', '1');
    }, DIFF_PREFS_KEY);
    await page.goto(openUrl(fixtures.diffView));
    await page.getByRole('row').filter({ hasText: 'Edit far down' }).click();
    await expect(page.getByTestId('file-counts')).toBeVisible();
  });

  // One page for these checks (each `test.step` was a test of its own, paying for a page load and
  // Monaco's start-up). Each step opens the other file than the one shown, so it starts from a new
  // presentation, as a test of its own did; in Inline, with Word wrap and Ignore whitespace off
  // unless the step turns them on.
  // mixed.txt (diff_view fixture): unchanged line 20 long enough to wrap, lines 50-52 deleted (50
  // and 51 long enough to wrap), 120-127 and 150-153 re-indented, 135 and 175 changed. The Word
  // wrap and Ignore whitespace steps put the affected deleted-lines zone between the viewport's top
  // and its centre, where Monaco's own scroll restore (which keeps the top line) would move the
  // centre.
  test('a long file: deleted lines copy on a click; mode switches, Word wrap and Ignore whitespace keep the centre line; Inline and Split open at the first change', async ({ page, browserName }) => {
    test.setTimeout(60_000);
    const d = diff(page);

    await test.step('a click on a deleted line copies it, Shift+click the whole deleted block (Hunk and Inline)', async () => {
      await present(page, 'long.txt');
      const toast = page.getByRole('status');
      const clip = () => page.evaluate(() => navigator.clipboard.readText());
      // Monaco draws spaces as no-break spaces (`\s` matches both).
      const deleted = (text: string) => d.locator('.editor.modified .view-zones .line-delete .view-line').filter({ hasText: new RegExp(`^${text.replaceAll(' ', '\\s')}$`) });
      await d.getByRole('button', { name: 'Hunk' }).click();
      await expect(deleted('line 151')).toBeVisible();
      await deleted('line 151').click();
      await expect(toast).toHaveText('Copied 1 line');
      if (browserName === 'chromium') expect(await clip()).toBe('line 151');
      await deleted('line 150').click({ modifiers: ['Shift'] });
      await expect(toast).toHaveText('Copied 3 lines');
      if (browserName === 'chromium') expect(await clip()).toBe('line 150\nline 151\nline 152');
      // A changed line's old text copies the same way, in Inline mode too. Hunk showed the change
      // on its first screen, at the top, and the mode switch keeps the top: Next change, from the
      // top, goes to it.
      await d.getByRole('button', { name: 'Inline' }).click();
      await d.getByRole('button', { name: 'Next change' }).click();
      await expect(deleted('line 120')).toBeVisible();
      await deleted('line 120').click();
      await expect(toast).toHaveText('Copied 1 line');
      if (browserName === 'chromium') expect(await clip()).toBe('line 120');
    });

    await test.step('Word wrap mid-file keeps the centre line, with wrapping deleted lines between the top and the centre', async () => {
      await present(page, 'mixed.txt');
      // Opened with the first change (the deletion at 50) centred; a few lines down, its zone is
      // above the centre.
      await expect.poll(() => inMiddleThird(page, 49)).toBe(true);
      await d.locator('.editor.modified').hover();
      await page.mouse.wheel(0, 60);
      await expect.poll(() => oldLinesAboveCentre(page, 50, 52)).toBe(true);
      await expect.poll(() => centreLineOf(page, 'modified')).not.toBeNull();
      const before = (await centreLineOf(page, 'modified'))!;
      await d.getByRole('button', { name: 'Word wrap' }).click();
      // The deleted long lines now wrap: the zone above the centre is several lines taller.
      await expect.poll(() => d.locator('.editor.modified .view-zones .line-delete .view-line').count()).toBeGreaterThan(3);
      await expect.poll(async () => Math.abs(((await centreLineOf(page, 'modified')) ?? 0) - before)).toBeLessThanOrEqual(1);
      // And back. (Monaco 0.57 keeps the deleted-lines zone's wrapped rendering until it next
      // redraws that zone, so there's no row count to wait on here.)
      await d.getByRole('button', { name: 'Word wrap' }).click();
      await expect(d.getByRole('button', { name: 'Word wrap' })).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(async () => Math.abs(((await centreLineOf(page, 'modified')) ?? 0) - before)).toBeLessThanOrEqual(1);
    });

    await test.step('switching Inline → Split keeps the line at the viewport centre, deleted lines included', async () => {
      /** The line whose number sits at the vertical centre of `side`'s viewport, or null. */
      const centreLine = (side: 'modified' | 'original') => centreLineOf(page, side);
      await present(page, 'long.txt');
      await expect.poll(() => inMiddleThird(page, 120)).toBe(true);
      // Somewhere mid-file, off a line boundary.
      await d.locator('.editor.modified').hover();
      await page.mouse.wheel(0, -333);
      await expect.poll(() => centreLine('modified')).not.toBeNull();
      const before = (await centreLine('modified'))!;
      expect(before).toBeGreaterThan(60);
      await d.getByRole('button', { name: 'Split' }).click();
      await expect.poll(() => sideRatio(page)).toBeGreaterThan(0.8);
      await expect.poll(async () => Math.abs((await centreLine('modified'))! - before)).toBeLessThanOrEqual(1);

      // Deleted lines at the centre in Inline: the same old line is at the centre in Split. From
      // above line 120, Next change goes to it, then centres the deletion of lines 150-152.
      await d.getByRole('button', { name: 'Inline' }).click();
      await expect.poll(() => sideRatio(page)).toBeLessThan(0.2);
      await d.getByRole('button', { name: 'Next change' }).click();
      await d.getByRole('button', { name: 'Next change' }).click();
      await expect.poll(async () => Math.abs(((await centreLine('original')) ?? 0) - 151)).toBeLessThanOrEqual(3);
      // Next change centres the (empty) modified side of the deletion, which lands a line or two
      // off the deleted block: nudge one of the old lines 150-152 to the centre (Chromium's wheel
      // steps by about three lines here, so any of them).
      const inBlock = (c: number | null) => c !== null && c >= 150 && c <= 152;
      await d.locator('.editor.modified').hover();
      for (let i = 0; i < 6 && !inBlock(await centreLine('original')); i++) {
        const c = (await centreLine('original')) ?? 151;
        await page.mouse.wheel(0, (c > 151 ? -1 : 1) * 19);
        await page.waitForTimeout(100);
      }
      const deleted = (await centreLine('original'))!;
      expect(inBlock(deleted)).toBe(true);
      expect(await centreLine('modified')).toBeNull(); // the centre is in the deleted-lines zone
      await d.getByRole('button', { name: 'Split' }).click();
      await expect.poll(() => sideRatio(page)).toBeGreaterThan(0.8);
      await expect.poll(async () => Math.abs(((await centreLine('original')) ?? 0) - deleted)).toBeLessThanOrEqual(1);

      // Hunk → Inline, where the layouts differ most (116 lines collapsed above the first hunk). A
      // short window, so the collapsed view scrolls and its centre isn't the top or the bottom.
      await page.setViewportSize({ width: 1280, height: 420 });
      await d.getByRole('button', { name: 'Hunk' }).click();
      await expect(d.locator('.editor.modified .diff-hidden-lines .center').first()).toBeAttached();
      // The kept centre is the deleted lines (no modified line number there): onto a modified line.
      await d.locator('.editor.modified').hover();
      for (let i = 0; i < 6 && (await centreLine('modified')) === null; i++) {
        await page.mouse.wheel(0, 19);
        await page.waitForTimeout(100);
      }
      const hunk = (await centreLine('modified'))!;
      expect(hunk).toBeGreaterThan(116);
      await d.getByRole('button', { name: 'Inline' }).click();
      await expect(d.locator('.editor.modified .diff-hidden-lines')).toHaveCount(0);
      await expect.poll(async () => Math.abs(((await centreLine('modified')) ?? 0) - hunk)).toBeLessThanOrEqual(1);
      await page.setViewportSize({ width: 1280, height: 720 });
    });

    await test.step('Ignore whitespace mid-file keeps the centre line, with the re-indented block between the top and the centre', async () => {
      await present(page, 'mixed.txt');
      // Opened on the deletion at 50: Next change centres the re-indent (its 8 old lines in the
      // zone above its 8 new ones, 117-124). A little further down, the old lines are all above
      // the centre.
      await d.getByRole('button', { name: 'Next change' }).click();
      await expect.poll(() => inMiddleThird(page, 117)).toBe(true);
      await d.locator('.editor.modified').hover();
      await page.mouse.wheel(0, 60);
      await expect.poll(() => oldLinesAboveCentre(page, 120, 127)).toBe(true);
      await expect.poll(() => centreLineOf(page, 'modified')).not.toBeNull();
      const before = (await centreLineOf(page, 'modified'))!;
      const computedBefore = await computedCount(page);
      await d.getByRole('button', { name: 'Ignore whitespace' }).click();
      // The recompute drops the change: the 8 old lines' zone goes.
      await expect.poll(() => computedCount(page)).toBeGreaterThan(computedBefore);
      await expect.poll(() => d.locator('.editor.modified .view-zones .line-delete .view-line').filter({ hasText: /row\s12/ }).count()).toBe(0);
      await expect.poll(async () => Math.abs(((await centreLineOf(page, 'modified')) ?? 0) - before)).toBeLessThanOrEqual(1);
      // Off again for the steps after this one.
      const on = await computedCount(page);
      await d.getByRole('button', { name: 'Ignore whitespace' }).click();
      await expect(d.getByRole('button', { name: 'Ignore whitespace' })).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(() => computedCount(page)).toBeGreaterThan(on);
    });

    await test.step('Inline and Split open with the first change centred', async () => {
      await present(page, 'long.txt');
      await expect.poll(() => inMiddleThird(page, 120)).toBe(true);
      // Only once per presentation: the user's own scrolling isn't undone.
      await d.locator('.editor.modified').hover();
      for (let i = 0; i < 100 && (await topLine(page)) > 1; i++) await page.mouse.wheel(0, -1000);
      await expect.poll(() => topLine(page)).toBe(1);
      await d.getByRole('button', { name: 'Split' }).click();
      await page.keyboard.press('Escape');
      await expect(d).toHaveCount(0);
      await open(page, 'long.txt');
      await expect.poll(() => sideRatio(page)).toBeGreaterThan(0.8);
      await expect.poll(() => inMiddleThird(page, 120)).toBe(true);
      // And it stays there once the diff's late layout is in.
      await page.waitForTimeout(300);
      expect(await inMiddleThird(page, 120)).toBe(true);
    });

    await test.step("Next/Previous change go by the scroll: from the open the second change; from the end, the last change above the view's centre", async () => {
      // long.txt in Split, opened on its first change (120): its changes are 120, the deletion of
      // old 150-152, and the line inserted at new 178.
      const active = d.locator('.editor.modified .active-line-number');
      await expect(active).toHaveText('120');
      await d.getByRole('button', { name: 'Next change' }).click();
      await expect(active).toHaveText('150');
      await expect.poll(async () => Math.abs(((await centreLineOf(page, 'original')) ?? 0) - 151)).toBeLessThanOrEqual(2);
      // To the end of the file: Previous goes to the insertion, not back to 120.
      await d.locator('.editor.modified').hover();
      for (let i = 0; i < 20 && (await topLine(page)) < 170; i++) await page.mouse.wheel(0, 1000);
      await d.getByRole('button', { name: 'Previous change' }).click();
      await expect(active).toHaveText('178');
      await expect.poll(() => inMiddleThird(page, 178)).toBe(true);
      await d.getByRole('button', { name: 'Previous change' }).click();
      await expect(active).toHaveText('150');
    });

    await test.step('Hunk + Ignore whitespace mid-file keeps the centre line, with the collapsed regions above the viewport changing', async () => {
      await present(page, 'mixed.txt');
      /** The modified editor's scroll position (its lines' offset). */
      const scrollTop = () => d.locator('.editor.modified .lines-content').first().evaluate((e) => -parseFloat((e as HTMLElement).style.top || '0'));
      const toggleWhitespace = async () => {
        const count = await computedCount(page);
        await d.getByRole('button', { name: 'Ignore whitespace' }).click();
        await expect.poll(() => computedCount(page)).toBeGreaterThan(count);
      };
      await d.getByRole('button', { name: 'Hunk' }).click();
      await expect(d.locator('.editor.modified .diff-hidden-lines .center').first()).toBeAttached();
      // Ignore whitespace on: both re-indented blocks (new 117-124 and 147-150) collapse with the
      // unchanged lines around them.
      await toggleWhitespace();
      // The real change at new line 172 at the centre: the regions holding the re-indents are
      // collapsed above it.
      const nearChange = (c: number | null) => c !== null && c >= 169 && c <= 175;
      for (let i = 0; i < 6 && !nearChange(await centreLineOf(page, 'modified')); i++) {
        await d.getByRole('button', { name: 'Next change' }).click();
        await page.waitForTimeout(150);
      }
      const before = (await centreLineOf(page, 'modified'))!;
      expect(nearChange(before)).toBe(true);
      const top = await scrollTop();
      expect(top).toBeGreaterThan(0);
      // Off: the re-indents are changes again, so their regions open up above the viewport (the
      // content above it grows by their lines and old lines), in the same result as the new zones.
      await toggleWhitespace();
      await expect.poll(scrollTop).toBeGreaterThan(top + 100);
      await expect.poll(async () => Math.abs(((await centreLineOf(page, 'modified')) ?? 0) - before)).toBeLessThanOrEqual(1);
      // And on again: their deleted-lines zones above the viewport go.
      const expanded = await scrollTop();
      await toggleWhitespace();
      await expect.poll(scrollTop).toBeLessThan(expanded - 100);
      await expect.poll(async () => Math.abs(((await centreLineOf(page, 'modified')) ?? 0) - before)).toBeLessThanOrEqual(1);
    });
  });
});
