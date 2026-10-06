import { expect, test } from './test';
import { fixtures, openUrl } from './fixtures';

test.describe('commit details', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(openUrl(fixtures.details));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
  });

  // Each `test.step` below was a test of its own, paying for a page load; they run in an order
  // where each starts from what it needs (the Rename commit selected once, by the first).
  test('the details panel: header, people, links, SHAs and parents, Esc and the divider lines, cursors, the width and the split', async ({ page, browserName }) => {
    await test.step('the panel appears when a commit is selected and shows its header and message', async () => {
      await expect(page.getByRole('complementary', { name: 'Commit details' })).toHaveCount(0);
      await page.getByRole('row').filter({ hasText: 'Rename guide and update assets' }).click();
      const panel = page.getByRole('complementary', { name: 'Commit details' });
      await expect(panel.getByTestId('details-summary')).toHaveText('Rename guide and update assets');
      await expect(panel.getByTestId('author')).toContainText('Grace Hopper');
      await expect(panel.getByTestId('committer')).toContainText('Ada Lovelace');
      await expect(panel.getByTestId('details-body')).toContainText('Refs !42');
      await expect(panel.getByTestId('parent-sha')).toHaveCount(1);
    });
    await test.step('co-authors, the signature badge and initials avatars', async () => {
      const panel = page.getByRole('complementary', { name: 'Commit details' });
      // The harness has no avatar provider: every avatar shows its initials.
      await expect(panel.getByTestId('co-author')).toHaveText(['MHMargaret Hamilton', 'LTLinus Torvalds']);
      await expect(panel.getByTestId('signature-badge')).toHaveAttribute('data-kind', 'unsigned');
      await expect(panel.getByTestId('author').getByTestId('avatar')).toHaveText('GH');
      await expect(panel.getByTestId('committer').getByTestId('avatar')).toHaveText('AL');
      await panel.getByTestId('co-author').first().hover();
      await expect(page.getByRole('tooltip')).toHaveText('Margaret Hamilton <margaret@example.com>');
      // F14: the author too.
      await panel.getByTestId('author').getByText('Grace Hopper').hover();
      await expect(page.getByRole('tooltip')).toHaveText('Grace Hopper <grace@example.com>');
    });
    await test.step('the header: signature icon left, SHA centred, parents right; the commit date first (F15, F16)', async () => {
      const panel = page.getByRole('complementary', { name: 'Commit details' });
      const [sig, sha, parents, row] = await Promise.all([
        panel.getByTestId('signature-badge').boundingBox(),
        panel.locator('.commit-id').boundingBox(),
        panel.locator('.parents').boundingBox(),
        panel.locator('.commit-ids').boundingBox(),
      ]);
      // The row spans the panel (K5), its content inset by the panel's 12 px padding.
      const pad = 12;
      expect(sig!.x - (row!.x + pad)).toBeLessThan(2);
      expect(Math.abs(sha!.x + sha!.width / 2 - (row!.x + row!.width / 2))).toBeLessThan(2);
      expect(row!.x + row!.width - pad - (parents!.x + parents!.width)).toBeLessThan(2);
      await expect(panel.getByTestId('signature-badge')).toHaveAccessibleName('Not signed');
      await panel.getByTestId('signature-badge').hover();
      await expect(page.getByRole('tooltip')).toHaveText('Not signed');
      // The fixture commits have one timestamp for author and committer: one date, no "authored".
      await expect(panel.getByTestId('commit-date')).toHaveText(/^\d{4}-\d{2}-\d{2} @ \d{1,2}:\d{2} [AP]M$/);
    });
    await test.step('H11: commit:/parent: labels, white hashes, the icon centred on the digits, an instant parent tooltip, the message box', async () => {
      const panel = page.getByRole('complementary', { name: 'Commit details' });
      const sha = panel.getByTestId('details-sha');
      const parent = panel.getByTestId('parent-sha');
      await expect(panel.locator('.commit-id')).toHaveText(/^commit: [0-9a-f]{6}$/);
      await expect(panel.locator('.parents')).toHaveText(/^parent: [0-9a-f]{6}$/);
      await expect(sha).toHaveCSS('color', 'rgb(255, 255, 255)');
      await expect(parent).toHaveCSS('color', 'rgb(255, 255, 255)');
      const label = panel.locator('.commit-id .id-label');
      await expect(label).toHaveCSS('color', 'rgba(255, 255, 255, 0.6)');
      // J8: the labels in the UI font, the hashes in monospace, at the same size.
      const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
      for (const l of [label, panel.locator('.parents .id-label')]) await expect(l).toHaveCSS('font-family', bodyFont);
      expect(await sha.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/monospace/);
      await expect(label).toHaveCSS('font-size', await sha.evaluate((el) => getComputedStyle(el).fontSize));
      await expect(sha).toHaveCSS('cursor', 'pointer');
      await expect(parent).toHaveCSS('cursor', 'pointer');
      // J8: the labels and the hashes share a baseline, at every zoom.
      const baselines = () => page.evaluate(() => [...document.querySelectorAll('.commit-ids .id-label, .commit-ids .sha')].map((el) => {
        const probe = document.createElement('span');
        probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
        el.appendChild(probe);
        const y = probe.getBoundingClientRect().top;
        probe.remove();
        return y;
      }));
      for (const zoom of [1, 1.25, 1.5]) {
        await page.evaluate((z) => { document.documentElement.style.zoom = String(z); }, zoom);
        const ys = await baselines();
        expect(ys.length).toBe(4);
        expect(Math.max(...ys) - Math.min(...ys), `baselines at ${zoom}`).toBeLessThan(0.5);
      }
      await page.evaluate(() => { document.documentElement.style.zoom = ''; });
      // "Go to parent commit", at once.
      await parent.hover();
      await expect(page.getByRole('tooltip')).toHaveText('Go to parent commit', { timeout: 300 });
      await sha.hover();
      await expect(page.getByRole('tooltip')).toHaveText('Copy full SHA', { timeout: 300 });
      // The message in a darker, rounded box.
      const box = panel.getByTestId('commit-message');
      await expect(box).toHaveCSS('background-color', 'rgb(28, 30, 35)');
      expect(parseFloat(await box.evaluate((el) => getComputedStyle(el).borderTopLeftRadius))).toBeGreaterThan(0);
      const summary = (await panel.getByTestId('details-summary').boundingBox())!;
      const b = (await box.boundingBox())!;
      expect(summary.x - b.x).toBeGreaterThanOrEqual(8);
      expect(summary.y - b.y).toBeGreaterThanOrEqual(4);
    });
    await test.step('message links and MR buttons point at the GitLab project', async () => {
      const panel = page.getByRole('complementary', { name: 'Commit details' });
      await expect(panel.getByRole('link', { name: '!42' })).toHaveAttribute('href', 'https://gitlab.example.com/group/project/-/merge_requests/42');
      await expect(panel.getByRole('link', { name: 'group/sub/project!7' })).toHaveAttribute('href', 'https://gitlab.example.com/group/sub/project/-/merge_requests/7');
      await expect(panel.getByRole('link', { name: '#12' })).toHaveAttribute('href', 'https://gitlab.example.com/group/project/-/issues/12');
      await expect(panel.getByRole('link', { name: 'https://example.com/docs' })).toHaveAttribute('href', 'https://example.com/docs');
      const buttons = panel.getByRole('button', { name: /^Open / });
      await expect(buttons).toHaveText(['Open !42', 'Open group/sub/project!7']);
      await expect(buttons.first()).toHaveAttribute('data-url', 'https://gitlab.example.com/group/project/-/merge_requests/42');
      await expect(buttons.last()).toHaveAttribute('data-url', 'https://gitlab.example.com/group/sub/project/-/merge_requests/7');
    });
    await test.step('Enter on a focused row SHA copies it and does not open a diff', async () => {
      const row = page.getByRole('row').filter({ hasText: 'Rename guide and update assets' });
      await row.click();
      await row.getByTestId('sha').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('status')).toHaveText('Copied');
      await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    });
    await test.step('J4: Esc closes the open file from the details header, the message and the diff toolbar', async () => {
      const row = page.getByRole('row').filter({ hasText: 'Rename guide and update assets' });
      await row.click();
      const panel = page.getByRole('complementary', { name: 'Commit details' });
      const diff = page.getByRole('region', { name: 'Diff' });
      const clicks: [string, () => Promise<void>][] = [
        // A blank spot of the header's top row: focus falls to <body>.
        ['the header', async () => {
          const ids = (await panel.locator('.commit-ids').boundingBox())!;
          const sha = (await panel.getByTestId('details-sha').boundingBox())!;
          await page.mouse.click((ids.x + sha.x) / 2, ids.y + ids.height / 2);
        }],
        ['the author row', () => panel.getByTestId('author').click({ position: { x: 150, y: 5 } })],
        ['the message', () => panel.getByTestId('details-body').click()],
        ['a diff toolbar button', () => diff.getByRole('button', { name: 'Split' }).click()],
      ];
      for (const [where, click] of clicks) {
        await page.getByRole('option').and(page.locator('[data-path="src/app.php"]')).click();
        await expect(diff).toBeVisible();
        await click();
        await page.keyboard.press('Escape');
        await expect(diff, where).toHaveCount(0);
        await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
        await expect(row).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeFocused();
      }
    });
    await test.step('K5/K6: the details header\'s divider lines up with the open file\'s bar, for a commit and a compare', async () => {
      const rename = page.getByRole('row').filter({ hasText: 'Rename guide and update assets' });
      const panel = page.getByRole('complementary', { name: /Commit details|Compare/ });
      const diffBar = page.getByRole('region', { name: 'Diff' }).locator('.diff-header');
      const check = async (bar: string) => {
        await page.getByRole('option').first().click();
        await expect(diffBar).toBeVisible();
        const [d, b] = await Promise.all([diffBar.boundingBox(), panel.locator(bar).boundingBox()]);
        // The density's height (standard: 37 px, 20% over 1B's 30 + 1), divider included (K6).
        expect(d!.height, bar).toBe(37);
        expect([b!.y, b!.height], bar).toEqual([d!.y, d!.height]);
        const border = (sel: string) => page.locator(sel).first().evaluate((e) => { const c = getComputedStyle(e); return `${c.borderBottomWidth} ${c.borderBottomStyle} ${c.borderBottomColor}`; });
        expect(await border(`aside ${bar}`), bar).toBe(await border('.diff-header'));
        expect(await border('.diff-header')).toBe('1px solid rgba(255, 255, 255, 0.08)');
      };
      await rename.click();
      await check('.commit-ids');
      // Nothing above the bar: it starts at the panel's top.
      const [aside, ids] = await Promise.all([page.locator('aside.right-panel').boundingBox(), panel.locator('.commit-ids').boundingBox()]);
      expect(ids!.y).toBe(aside!.y);
      await page.keyboard.press('Escape');
      await page.getByRole('row').filter({ hasText: 'Initial commit' }).click({ modifiers: ['Control'] });
      await expect(page.getByTestId('compare-header')).toBeVisible();
      await check('.compare-bar');
    });
    await test.step('clicking the details SHA copies the full hash', async () => {
      // The open file closed first (its diff hides the graph and its rows), back to one commit.
      await page.getByRole('region', { name: 'Diff' }).getByRole('button', { name: 'Close diff' }).click();
      await expect(page.getByRole('region', { name: 'Diff' })).toHaveCount(0);
      await page.getByRole('row').filter({ hasText: 'Initial commit' }).click();
      await page.getByTestId('details-sha').click();
      await expect(page.getByRole('status')).toHaveText('Copied');
      if (browserName === 'chromium') expect(await page.evaluate(() => navigator.clipboard.readText())).toHaveLength(40);
    });
    await test.step('arrow keys update the details immediately', async () => {
      await page.getByRole('row').filter({ hasText: "Merge branch 'feature/x'" }).click();
      const summary = page.getByTestId('details-summary');
      await expect(summary).toHaveText("Merge branch 'feature/x'");
      await page.keyboard.press('ArrowDown');
      await expect(summary).toHaveText('Rename guide and update assets');
    });
    await test.step('a merge lists both parents and a parent SHA selects that commit', async () => {
      await page.getByRole('row').filter({ hasText: "Merge branch 'feature/x'" }).click();
      await expect(page.getByTestId('parent-sha')).toHaveCount(2);
      await page.getByTestId('parent-sha').last().click();
      await expect(page.getByTestId('details-summary')).toHaveText('Add feature file');
      await expect(page.getByRole('row').filter({ hasText: 'Add feature file' })).toHaveAttribute('aria-selected', 'true');
    });
    await test.step('H5: every clickable element in the panel shows a pointer cursor', async () => {
      for (const [commit, tree] of [['Rename guide and update assets', true], ["Merge branch 'feature/x'", false]] as const) {
        await page.getByRole('row').filter({ hasText: commit }).click();
        const panel = page.getByRole('complementary', { name: 'Commit details' });
        await expect(panel.getByTestId('details-summary')).toHaveText(commit);
        if (tree) await panel.getByRole('button', { name: 'Tree' }).click();
        const cursors = await panel.evaluate((el) =>
          [...el.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [role="option"], [role="treeitem"]')].map((c) => [c.dataset.testid ?? c.dataset.path ?? c.textContent?.trim(), getComputedStyle(c).cursor]),
        );
        expect(cursors.length).toBeGreaterThan(5);
        // File rows are options (Path) or treeitems (Tree): the check must reach at least one.
        expect(await panel.locator('[role="option"][data-path], [role="treeitem"][data-path]').count()).toBeGreaterThan(0);
        expect(cursors.filter(([, cursor]) => cursor !== 'pointer')).toEqual([]);
      }
    });
    await test.step('double-clicking the panel resizer restores the default width (K73)', async () => {
      await page.getByRole('row').filter({ hasText: 'Rename guide and update assets' }).click();
      const panel = page.getByRole('complementary', { name: 'Commit details' });
      const sep = page.getByRole('separator', { name: 'Resize details panel' });
      const width = async () => Math.round((await panel.boundingBox())!.width);
      await sep.focus();
      for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
      expect(await width()).toBeGreaterThan(400);
      await sep.dblclick();
      await expect.poll(width).toBeLessThanOrEqual(401); // 1px of border
      expect(await width()).toBeGreaterThanOrEqual(400);
    });
    await test.step('the header stays put, only the message scrolls, and the split resizes and persists (F13)', async () => {
      // Tall enough that the default 25 % top clears the header's minimum (`splitBounds`) under the
      // shell's toolbar and status bar.
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByRole('row').filter({ hasText: 'Rename guide and update assets' }).click();
      const panel = page.getByRole('complementary', { name: 'Commit details' });
      const top = panel.locator('.commit-details');
      const files = panel.locator('.file-sections');
      const sep = panel.getByRole('separator', { name: 'Resize commit details' });
      const panelBox = (await panel.locator('.details-panel').boundingBox())!;
      // About 25 / 75 by default.
      await expect(sep).toHaveAttribute('aria-valuenow', '25');
      expect((await top.boundingBox())!.height / panelBox.height).toBeCloseTo(0.25, 1);
      // Drag it down 150 px: the top grows by that much, the file list shrinks.
      const s0 = (await sep.boundingBox())!;
      const [top0, files0] = [(await top.boundingBox())!.height, (await files.boundingBox())!.height];
      await page.mouse.move(s0.x + s0.width / 2, s0.y + s0.height / 2);
      await page.mouse.down();
      await page.mouse.move(s0.x + s0.width / 2, s0.y + s0.height / 2 + 150, { steps: 5 });
      await page.mouse.up();
      expect((await top.boundingBox())!.height - top0).toBeCloseTo(150, -1);
      expect(files0 - (await files.boundingBox())!.height).toBeCloseTo(150, -1);
      // At the smallest split, the message scrolls under a fixed header.
      await sep.focus();
      await page.keyboard.press('Home');
      const message = panel.getByTestId('commit-message');
      expect(await message.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      const headerY = (await panel.locator('.commit-header').boundingBox())!.y;
      await message.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      expect((await panel.locator('.commit-header').boundingBox())!.y).toBe(headerY);
      expect(await top.evaluate((el) => el.scrollTop)).toBe(0);
      // The ratio persists (localStorage).
      await page.keyboard.press('ArrowDown');
      const kept = await sep.getAttribute('aria-valuenow');
      await page.reload();
      await page.getByRole('row').filter({ hasText: 'Rename guide and update assets' }).click();
      await expect(page.getByRole('separator', { name: 'Resize commit details' })).toHaveAttribute('aria-valuenow', kept!);
    });
  });

  // Measured on the painted pixels, at the zooms CEF's page zoom renders like (the device scale):
  // the shield's ink centre against the hash digits'. Before J8 the icon was 1.5 device px low
  // at 150% and 200%; rounding leaves at most 1 device px, and never low.
  test('J8: the signature icon is centred on the hash digits\' ink at every zoom, never below it', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'the CEF runtime is Chromium');
    for (const dsf of [1, 1.25, 1.5, 2]) {
      const context = await browser.newContext({ deviceScaleFactor: dsf, baseURL: test.info().project.use.baseURL });
      const page = await context.newPage();
      await page.goto(openUrl(fixtures.details));
      await page.getByRole('row').filter({ hasText: 'Rename guide and update assets' }).click();
      const panel = page.getByRole('complementary', { name: 'Commit details' });
      const [row, badge, sha] = await Promise.all([panel.locator('.commit-ids'), panel.getByTestId('signature-badge'), panel.getByTestId('details-sha')].map(async (l) => (await l.boundingBox())!));
      const png = (await page.screenshot({ clip: row })).toString('base64');
      // Ink rows (device px) of the badge's columns (anything off the background) and the hash's
      // (bright text), decoded in the page.
      const ink = await page.evaluate(async ({ png, cols }) => {
        const img = await createImageBitmap(new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: 'image/png' }));
        const ctx = new OffscreenCanvas(img.width, img.height).getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height);
        const px = (x: number, y: number) => data.subarray((y * width + x) * 4, (y * width + x) * 4 + 3);
        const bg = px(Math.floor(width * 0.3), 1);
        const rows = (x0: number, x1: number, hit: (p: Uint8ClampedArray) => boolean) => {
          const ys: number[] = [];
          for (let y = 0; y < height; y++) for (let x = Math.floor(x0); x < Math.floor(x1); x++) if (hit(px(x, y))) { ys.push(y); break; }
          return (ys[0] + ys[ys.length - 1] + 1) / 2;
        };
        return {
          icon: rows(cols.badge[0], cols.badge[1], (p) => Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 60),
          hash: rows(cols.sha[0], cols.sha[1], (p) => p[0] + p[1] + p[2] > 500),
        };
      }, { png, cols: { badge: [(badge.x - row.x) * dsf, (badge.x - row.x + badge.width) * dsf], sha: [(sha.x - row.x) * dsf, (sha.x - row.x + sha.width) * dsf] } });
      // Device px: positive is the icon below the digits.
      const off = ink.icon - ink.hash;
      expect(Math.abs(off), `at ${dsf}x`).toBeLessThanOrEqual(1);
      expect(off, `at ${dsf}x`).toBeLessThanOrEqual(0.5);
      await context.close();
    }
  });
});

// Feedback F12: the panel swaps to the next commit in one render, once its details, message and
// file list are all in. A MutationObserver records the panel after every DOM change; each
// recorded state must be one commit's complete content: never empty, never a mix of two commits.
test('switching commits never renders an empty or partial panel', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(openUrl(fixtures.longHistory));
  await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
  await page.getByRole('row').filter({ hasText: 'Commit 59' }).click();
  await expect(page.getByTestId('details-summary')).toHaveText('Commit 59');
  await expect(page.getByRole('listbox', { name: 'Changed files' })).toBeVisible();
  await page.evaluate(() => {
    const aside = document.querySelector('aside.right-panel')!;
    const states: string[][] = [];
    (window as unknown as { panelStates: string[][] }).panelStates = states;
    const text = (id: string) => aside.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
    new MutationObserver(() => states.push([text('details-sha'), text('details-summary'), [...aside.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].map((o) => o.dataset.path).join(',')]))
      .observe(aside, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  // Arrow keys (the neighbours are prefetched) and clicks on far, uncached rows.
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('details-summary')).toHaveText('Commit 53');
  for (const target of ['Commit 42', 'Commit 57', 'Commit 45']) {
    await page.getByRole('row').filter({ hasText: target }).click();
    await expect(page.getByTestId('details-summary')).toHaveText(target);
  }
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('details-summary')).toHaveText('Commit 48');
  await expect(page.getByRole('complementary', { name: 'Commit details' })).toHaveAttribute('aria-busy', 'false');
  const states = await page.evaluate(() => (window as unknown as { panelStates: string[][] }).panelStates);
  // The graph's rows give each full SHA its summary. The panel shows a short SHA, so the one row
  // whose full SHA starts with it gives that commit's summary.
  const summaryBySha = await page.getByRole('row').evaluateAll((rows) => rows.map((r) => [r.querySelector('[data-testid="sha"]')?.textContent ?? '', r.querySelector('[data-col="message"]')?.textContent ?? ''] as const));
  const summaryOf = (sha: string) => {
    const matches = summaryBySha.filter(([full]) => full !== '' && full.startsWith(sha));
    expect(matches, `exactly one graph row has SHA ${sha}`).toHaveLength(1);
    return matches[0][1];
  };
  expect(states.length).toBeGreaterThan(0);
  const seen = new Set<string>();
  for (const [sha, summary, files] of states) {
    expect(sha, 'a SHA is always shown').not.toBe('');
    expect(summary, 'a summary is always shown').not.toBe('');
    expect(files, 'the file list is always shown').not.toBe('');
    expect(summaryOf(sha), `the summary belongs to ${sha}`).toContain(summary);
    // The fixture's "Commit NN" adds file_NN.txt: the list belongs to the same commit.
    expect(files, `the files belong to ${summary}`).toBe(`file_${Number(summary.replace('Commit ', ''))}.txt`);
    seen.add(summary);
  }
  expect(seen).toContain('Commit 42');
  expect(seen).toContain('Commit 48');
});
