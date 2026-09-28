import { expect, test, type Locator, type Page } from '@playwright/test';
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
      const panel = document.querySelector('.diff-panel');
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

async function selectCommit(page: Page) {
  await page.getByRole('row').filter({ hasText: COMMIT }).click();
  await expect(page.getByTestId('file-counts')).toBeVisible();
}

async function open(page: Page, path: string) {
  await fileRow(page, path).click();
  await expect(diff(page).getByTestId('diff-path')).toContainText(path.split('/').pop()!);
}

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

  test('Inline pressed by default; Hunk, Inline and Split views', async ({ page }) => {
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

  test("toolbar (H9): File/Diff centred; prev/next, the modes, then the toggles at the far right", async ({ page }) => {
    await open(page, 'src/app.php');
    const d = diff(page);
    const bar = (await d.getByRole('toolbar', { name: 'Diff options' }).boundingBox())!;
    const views = (await d.getByRole('button', { name: 'File View' }).locator('..').boundingBox())!;
    const box = async (l: Locator) => (await l.boundingBox())!;
    const [prev, next, modes, ws, wrap] = await Promise.all([
      box(d.getByRole('button', { name: 'Previous change' })),
      box(d.getByRole('button', { name: 'Next change' })),
      box(d.getByRole('group', { name: 'View mode' })),
      box(d.getByRole('button', { name: 'Ignore whitespace' })),
      box(d.getByRole('button', { name: 'Word wrap' })),
    ]);
    expect(Math.abs(views.x + views.width / 2 - (bar.x + bar.width / 2))).toBeLessThanOrEqual(2);
    // Left to right after the centre: prev, next, the modes, whitespace, wrap.
    expect(views.x + views.width).toBeLessThan(prev.x);
    expect([prev.x < next.x, next.x < modes.x, modes.x + modes.width <= ws.x, ws.x < wrap.x]).toEqual([true, true, true, true]);
    // Only the toolbar's padding (8 px) past the last toggle.
    expect(bar.x + bar.width - (wrap.x + wrap.width)).toBeLessThanOrEqual(9);
    for (const name of ['Ignore whitespace', 'Word wrap', 'Previous change', 'Next change']) await expect(d.getByRole('button', { name })).toHaveText('');
  });

  test("a rename's header: the common base, old ⇒ new with only the new name bright; a stacked tooltip (H21)", async ({ page }) => {
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

  test('toolbar: at narrow centre widths nothing overlaps, and every control stays inside the bar', async ({ page }) => {
    // With the default 400 px details panel: 1060 px gives a 660 px centre (just under the
    // 760 px wrapping breakpoint) and 900 px a 500 px one. At 720 px the panel
    // clamps to 400 (innerWidth − CENTER_MIN), so the centre is CENTER_MIN, 320 px.
    for (const width of [1060, 900, 720]) {
      await page.setViewportSize({ width, height: 700 });
      await open(page, 'src/app.php');
      const d = diff(page);
      const bar = (await d.getByRole('toolbar', { name: 'Diff options' }).boundingBox())!;
      const boxes = await Promise.all([
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

  // In every mode, from a prefetched neighbour (ws.txt) and from a file loaded on the click
  // (crlf.txt): app.php swaps in whole. Neither ws.txt (4 lines) nor crlf.txt (3) shows a line
  // past 5. Hunk: app.php's line 20 sits inside its collapsed region and 52 is shown; Inline and
  // Split show line 10 (its first change, line 5, is on the first screen: no reveal).
  for (const [mode, marker, hidden] of [['Hunk', '52', '20'], ['Inline', '10', null], ['Split', '10', null]] as const) {
    test(`${mode} mode: switching files swaps in the new diff whole, never a blank editor, Loading${hidden ? ' or the full file' : ''}`, async ({ page }) => {
      for (const from of ['ws.txt', 'crlf.txt']) {
        await open(page, from);
        const d = diff(page);
        await d.getByRole('button', { name: mode }).click();
        await expect(d.getByRole('button', { name: mode })).toHaveAttribute('aria-pressed', 'true');
        // The first diff also loads the editor's chunk: allow for a cold start.
        await expect.poll(() => computedCount(page), { timeout: 15_000 }).toBeGreaterThan(0);
        const stop = await sampleFrames(page);
        await fileRow(page, 'src/app.php').click();
        await expect(d.locator('.editor.modified .margin-view-overlays .line-numbers').filter({ hasText: new RegExp(`^${marker}$`) })).toBeVisible();
        const frames = await stop();
        expect(frames.filter((f) => f.phase === 'post').length).toBeGreaterThan(3);
        expect(frames.filter((f) => f.lines.length === 0 || f.busy)).toEqual([]);
        if (hidden) expect(frames.filter((f) => f.lines.includes(hidden))).toEqual([]);
        // Header and editor switch together: app.php's path only over app.php's diff, the
        // previous path only over the previous diff.
        expect(frames.filter((f) => (f.path === 'src/app.php') !== f.lines.includes(marker))).toEqual([]);
        expect(frames.at(-1)).toMatchObject({ path: 'src/app.php' });
        expect(frames.at(-1)!.lines).toContain('5');
      }
    });
  }

  // H6: close the file, select another commit, open a file there (Split): the one editor is shared,
  // and it still holds the first commit's diff. It must never be painted under the new header.
  test("reopening after a close shows only the new commit's file, never the previous one for a frame (Split)", async ({ page }) => {
    await open(page, 'src/app.php');
    const d = diff(page);
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

  test('Esc closes the file even from inside the editor with a selection; an open find widget closes first', async ({ page, browserName }) => {
    await open(page, 'src/app.php');
    await computed(page);
    const d = diff(page);
    // A selection in the editor: Monaco's own Esc (cancelSelection) would take the key.
    await d.locator('.editor.modified .view-line').filter({ hasText: 'final class Card' }).getByText('Card', { exact: true }).dblclick();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.editor.modified'))).toBe(true);
    await expect(d.locator('.editor.modified .selected-text').first()).toBeVisible();
    // WebKit's "Desktop Safari" user agent makes Monaco use the macOS bindings.
    await page.keyboard.press(browserName === 'webkit' ? 'Meta+f' : 'Control+f');
    const find = d.locator('.editor.modified .find-widget.visible');
    await expect(find).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(find).toHaveCount(0);
    await expect(d).toBeVisible();
    // Monaco's context menu (on in 1B): Esc closes the menu, not the file.
    await d.locator('.editor.modified .view-line').filter({ hasText: 'final class Card' }).click({ button: 'right' });
    const menu = page.locator('.context-view .monaco-menu');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(d).toBeVisible();
    await d.locator('.editor.modified .view-line').filter({ hasText: 'final class Card' }).getByText('Card', { exact: true }).dblclick();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.editor.modified'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
  });

  test("diff colours are forest green and brick red, lighter for whole lines", async ({ page }) => {
    await open(page, 'src/app.php');
    await computed(page);
    const d = diff(page);
    await d.getByRole('button', { name: 'Split' }).click();
    const bg = (sel: string) => d.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);
    await expect.poll(() => bg('.editor.modified .line-insert')).toBe('rgba(92, 184, 92, 0.1)');
    expect(await bg('.editor.modified .char-insert')).toBe('rgba(92, 184, 92, 0.12)');
    expect(await bg('.editor.original .line-delete')).toBe('rgba(217, 65, 61, 0.15)');
    expect(await bg('.editor.original .char-delete')).toBe('rgba(217, 65, 61, 0.2)');
  });

  test('the picked mode is remembered across a reload', async ({ page }) => {
    await open(page, 'src/app.php');
    await diff(page).getByRole('button', { name: 'Split' }).click();
    await expect(diff(page).getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await selectCommit(page);
    await open(page, 'src/app.php');
    const d = diff(page);
    await expect(d.getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true');
    await expect(d.getByRole('button', { name: 'Inline' })).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => sideRatio(page)).toBeGreaterThan(0.8);
  });

  test('Ignore whitespace hides a re-indentation', async ({ page }) => {
    await open(page, 'ws.txt');
    const d = diff(page);
    await d.getByRole('button', { name: 'Split' }).click();
    // The test's first diff: allow for a cold start (the editor's chunk loads), as `computed` does.
    await expect.poll(() => d.locator('.editor.modified .line-insert').count(), { timeout: 15_000 }).toBeGreaterThan(0);
    // The diff recomputes after the toggle: wait for that result, so "no inserted lines" can't be
    // read off the gap in between.
    const before = await computedCount(page);
    await d.getByRole('button', { name: /Ignore whitespace/ }).click();
    await expect(d.getByRole('button', { name: /Ignore whitespace/ })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => computedCount(page)).toBeGreaterThan(before);
    await expect(d.locator('.editor.modified .line-insert')).toHaveCount(0);
  });

  test('Word wrap wraps the long line', async ({ page }) => {
    await open(page, 'src/app.php');
    await computed(page);
    const d = diff(page);
    await d.getByRole('button', { name: 'Split' }).click();
    const longLine = d.locator('.editor.modified .view-line', { hasText: 'long line' });
    await expect(longLine).toHaveCount(1);
    await d.getByRole('button', { name: 'Word wrap' }).click();
    await expect.poll(() => longLine.count()).toBeGreaterThan(1);
  });

  test('F7 and Shift+F7 move between changes', async ({ page }) => {
    await open(page, 'src/app.php');
    const d = diff(page);
    await d.getByRole('button', { name: 'Split' }).click();
    await computed(page);
    // A click in the diff zone puts the keyboard in the editor; F7 is still the panel's.
    await d.getByTestId('diff-path').click();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.editor.modified'))).toBe(true);
    const active = d.locator('.editor.modified .active-line-number');
    await page.keyboard.press('F7');
    await expect(active).toHaveText('5');
    await page.keyboard.press('F7');
    await expect(active).toHaveText('55');
    await page.keyboard.press('Shift+F7');
    await expect(active).toHaveText('5');
    await d.getByRole('button', { name: 'Next change' }).click();
    await expect(active).toHaveText('55');
  });

  test('F7 wraps from the last change to the first, and Shift+F7 back', async ({ page }) => {
    // src/app.php has exactly two changes, at lines 5 and 55.
    await open(page, 'src/app.php');
    const d = diff(page);
    await computed(page);
    const active = d.locator('.editor.modified .active-line-number');
    await d.getByTestId('diff-path').click();
    await page.keyboard.press('F7');
    await expect(active).toHaveText('5');
    await page.keyboard.press('F7');
    await expect(active).toHaveText('55');
    await page.keyboard.press('F7');
    await expect(active).toHaveText('5');
    await page.keyboard.press('Shift+F7');
    await expect(active).toHaveText('55');
  });

  test('a toolbar click leaves the focus in the file list: ↓ then opens the next file', async ({ page }) => {
    await open(page, 'src/app.php');
    const d = diff(page);
    await expect(page.getByRole('listbox', { name: 'Changed files' })).toBeFocused();
    await d.getByRole('button', { name: 'Split' }).click();
    await expect(d.getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('listbox', { name: 'Changed files' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(d.getByTestId('diff-path')).toContainText('ws.txt');
  });

  test('File View shows the whole file at the commit', async ({ page }) => {
    await open(page, 'src/app.php');
    const d = diff(page);
    await d.getByRole('button', { name: 'File View' }).click();
    await expect(d.getByTestId('file-view')).toContainText('enum Suit: string');
    await d.getByRole('button', { name: 'Diff View' }).click();
    await expect(d.getByTestId('text-diff')).toBeVisible();
  });

  test('an unchanged file from View all files has Diff View disabled', async ({ page }) => {
    await page.getByRole('button', { name: 'View all files' }).click();
    await open(page, 'latin1.txt');
    const d = diff(page);
    await expect(d.getByTestId('file-view')).toBeVisible();
    await expect(d.getByRole('button', { name: 'File View' })).toHaveAttribute('aria-pressed', 'true');
    await expect(d.getByRole('button', { name: 'Diff View' })).toBeDisabled();
  });

  test('an EOL-only change shows a banner', async ({ page }) => {
    await open(page, 'crlf.txt');
    await expect(diff(page).getByRole('note')).toHaveText('Only line endings changed (CRLF → LF)');
  });

  test('a large file asks before loading', async ({ page }) => {
    await open(page, 'big.txt');
    const d = diff(page);
    await expect(d.getByText('Large file — load anyway?')).toBeVisible();
    await d.getByRole('button', { name: 'Load anyway' }).click();
    // Shown once its (80,000-line) diff has computed.
    await expect(d.getByTestId('text-diff')).toContainText('line 00000 of the big file', { timeout: 15_000 });
  });

  test('a binary file shows its sizes', async ({ page }) => {
    await open(page, 'data.bin');
    await expect(diff(page).getByTestId('binary-summary')).toHaveText('Binary file · 9 B → 10 B');
  });
});

// The `diff_view` fixture: 200-line long.txt, first changed at line 120 (fixtures.rs).
test.describe('presenting a long file', () => {
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

  // mixed.txt (diff_view fixture): unchanged line 20 long enough to wrap, lines 50-52 deleted (50
  // and 51 long enough to wrap), 120-127 and 150-153 re-indented, 135 and 175 changed. The Word
  // wrap and Ignore whitespace tests put the affected deleted-lines zone between the viewport's top
  // and its centre, where Monaco's own scroll restore (which keeps the top line) would move the
  // centre.
  test('Word wrap mid-file keeps the centre line, with wrapping deleted lines between the top and the centre', async ({ page }) => {
    await open(page, 'mixed.txt');
    await expect.poll(() => computedCount(page), { timeout: 15_000 }).toBeGreaterThan(0);
    const d = diff(page);
    // Opened at the first change (the deletion at 50): its zone is above the centre.
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

  test('Ignore whitespace mid-file keeps the centre line, with the re-indented block between the top and the centre', async ({ page }) => {
    await open(page, 'mixed.txt');
    await expect.poll(() => computedCount(page), { timeout: 15_000 }).toBeGreaterThan(0);
    const d = diff(page);
    // Next change twice: the re-indent (new 117-124) centred, its 8 old lines in the zone above.
    await d.getByRole('button', { name: 'Next change' }).click();
    await d.getByRole('button', { name: 'Next change' }).click();
    await expect.poll(() => oldLinesAboveCentre(page, 120, 127)).toBe(true);
    await expect.poll(() => centreLineOf(page, 'modified')).not.toBeNull();
    const before = (await centreLineOf(page, 'modified'))!;
    const computedBefore = await computedCount(page);
    await d.getByRole('button', { name: 'Ignore whitespace' }).click();
    // The recompute drops the change: the 8 old lines' zone goes.
    await expect.poll(() => computedCount(page)).toBeGreaterThan(computedBefore);
    await expect.poll(() => d.locator('.editor.modified .view-zones .line-delete .view-line').filter({ hasText: /row\s12/ }).count()).toBe(0);
    await expect.poll(async () => Math.abs(((await centreLineOf(page, 'modified')) ?? 0) - before)).toBeLessThanOrEqual(1);
  });

  test('Hunk + Ignore whitespace mid-file keeps the centre line, with the collapsed regions above the viewport changing', async ({ page }) => {
    await open(page, 'mixed.txt');
    await expect.poll(() => computedCount(page), { timeout: 15_000 }).toBeGreaterThan(0);
    const d = diff(page);
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

  test('a click on a deleted line copies it, Shift+click the whole deleted block (Hunk and Inline)', async ({ page, browserName }) => {
    await open(page, 'long.txt');
    await expect.poll(() => computedCount(page), { timeout: 15_000 }).toBeGreaterThan(0);
    const d = diff(page);
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
    // A changed line's old text copies the same way, in Inline mode too.
    await d.getByRole('button', { name: 'Inline' }).click();
    // A mode switch isn't a new presentation (no reveal): go to the change.
    await d.getByRole('button', { name: 'Next change' }).click();
    await expect(deleted('line 120')).toBeVisible();
    await deleted('line 120').click();
    await expect(toast).toHaveText('Copied 1 line');
    if (browserName === 'chromium') expect(await clip()).toBe('line 120');
  });

  test('switching Inline → Split keeps the line at the viewport centre, deleted lines included', async ({ page }) => {
    /** The line whose number sits at the vertical centre of `side`'s viewport, or null. */
    const centreLine = (side: 'modified' | 'original') => centreLineOf(page, side);
    await open(page, 'long.txt');
    await expect.poll(() => computedCount(page), { timeout: 15_000 }).toBeGreaterThan(0);
    const d = diff(page);
    await expect.poll(() => topLine(page)).toBe(117);
    // Somewhere mid-file, off a line boundary.
    await d.locator('.editor.modified').hover();
    await page.mouse.wheel(0, -333);
    await expect.poll(() => centreLine('modified')).not.toBeNull();
    const before = (await centreLine('modified'))!;
    expect(before).toBeGreaterThan(60);
    await d.getByRole('button', { name: 'Split' }).click();
    await expect.poll(() => sideRatio(page)).toBeGreaterThan(0.8);
    await expect.poll(async () => Math.abs((await centreLine('modified'))! - before)).toBeLessThanOrEqual(1);

    // Deleted lines at the centre in Inline: the same old line is at the centre in Split. Next
    // change centres the deletion of lines 150-152 (Monaco's revealRangeInCenter).
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
  });

  test('Inline and Split open at the first change, three lines of context above it', async ({ page }) => {
    await open(page, 'long.txt');
    // Not `computed`: long.txt's inserted lines start below the first screen. The first diff also
    // loads the editor's chunk: allow for a cold start.
    await expect.poll(() => computedCount(page), { timeout: 15_000 }).toBeGreaterThan(0);
    await expect.poll(() => topLine(page)).toBe(117);
    // Only once per presentation: the user's own scrolling isn't undone.
    await diff(page).locator('.editor.modified').hover();
    for (let i = 0; i < 100 && (await topLine(page)) > 1; i++) await page.mouse.wheel(0, -1000);
    await expect.poll(() => topLine(page)).toBe(1);
    await diff(page).getByRole('button', { name: 'Split' }).click();
    await page.keyboard.press('Escape');
    await expect(diff(page)).toHaveCount(0);
    await open(page, 'long.txt');
    await expect.poll(() => sideRatio(page)).toBeGreaterThan(0.8);
    await expect.poll(() => topLine(page)).toBe(117);
  });
});
