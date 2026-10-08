import { forgeSeed, freshFixture, harnessHttp, setForgeSeed } from './fixtures';
import { expect, test } from './test';

const openBoth = (a: string, b: string) => `/?repo=${encodeURIComponent(a)}&repo=${encodeURIComponent(b)}`;

test.describe('tabs', () => {
  // Each `test.step` below was a test of its own, paying for a page load; they run in an order
  // where each starts from what it needs.
  test('one tab: the hamburger, About, an update, the profile picker, renaming a tab (kept across a reload), profiles swap the tab set', async ({ page, request }) => {
    await test.step('the hamburger lists only working actions, with shortcuts', async () => {
      const a = freshFixture('basic');
      await page.goto(`/?repo=${encodeURIComponent(a)}`);
      await page.getByRole('button', { name: 'Menu' }).click();
      await page.getByRole('menuitem', { name: 'File' }).hover();
      await expect(page.getByRole('menuitem', { name: /Open repository…/ })).toContainText('Ctrl+O');
      // Quit isn't offered in the e2e harness (not running in Tauri): no placeholder UI.
      await expect(page.getByRole('menuitem', { name: 'Quit' })).toHaveCount(0);
      // Esc closes the open submenu first, then the root menu (spec §7).
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('context-menu')).toBeHidden();
    });
    await test.step('the About dialog shows the app and git version', async () => {
      await page.getByRole('button', { name: 'Menu' }).click();
      await page.getByRole('menuitem', { name: 'Help' }).hover();
      await page.getByRole('menuitem', { name: 'About GitBolt' }).click();
      const dialog = page.getByRole('dialog', { name: 'About GitBolt' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('git');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });
    await test.step('an update: Check for updates finds it, the pill downloads it, then the dialog offers the install', async () => {
      const bar = page.locator('.status-bar');
      await expect(bar).toContainText(/git [\d.]+GitBolt \d+\.\d+\.\d+/);
      // The fake GitHub's release (never the real one), served slowly enough to see the download.
      const seed = await forgeSeed(request);
      const github = seed.github as Record<string, unknown>;
      github.releases = [{ tagName: 'v0.99.0', name: 'GitBolt 0.99.0', body: '## Added\n\n- Updates from GitHub', assets: [{ name: 'GitBolt_0.99.0_amd64.deb', size: 2 * 1024 * 1024 }, { name: 'SHA256SUMS', size: 0 }] }];
      github.downloadChunkDelayMs = 60;
      await setForgeSeed(request, seed);
      await page.getByRole('button', { name: 'Menu' }).click();
      await page.getByRole('menuitem', { name: 'Help' }).hover();
      await page.getByRole('menuitem', { name: 'Check for updates' }).click();
      const about = page.getByRole('dialog', { name: 'About GitBolt' });
      await expect(about.getByRole('status')).toHaveText('GitBolt 0.99.0 is available.');
      await page.keyboard.press('Escape');
      const pill = bar.locator('.sb-update');
      await expect(pill).toHaveText('Update to 0.99.0');
      await pill.click();
      await expect(pill.getByRole('progressbar')).toBeVisible();
      await expect(pill).toHaveText('Install 0.99.0', { timeout: 15_000 });
      await pill.click();
      const dialog = page.getByRole('dialog', { name: 'Update to GitBolt 0.99.0' });
      await expect(dialog.getByRole('heading', { name: 'Added' })).toBeVisible();
      await expect(dialog).toContainText('GitBolt_0.99.0_amd64.deb · 2.0 MB');
      await expect(dialog.getByRole('button', { name: 'Install 0.99.0' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'View on GitHub' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });
    await test.step('the profile picker toggles on a second click; Edit profile is offered', async () => {
      const picker = page.getByRole('button', { name: /Profile: Default/ });
      const menu = page.getByTestId('context-menu');
      await picker.click();
      await expect(page.getByRole('menuitem', { name: 'Edit profile…' })).toBeVisible();
      await picker.click();
      await expect(menu).toBeHidden();
      await picker.click();
      await expect(page.getByRole('menuitem', { name: 'Edit profile…' })).toBeVisible();
      await page.getByRole('menuitem', { name: 'Edit profile…' }).click();
      await expect(page.getByRole('dialog', { name: 'Edit profile' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Edit profile' })).toBeHidden();
    });
    await test.step('rename field: click inside, Shift+arrows, type, Enter', async () => {
      const tab = page.getByRole('tab').first();
      await tab.click({ button: 'right' });
      await page.getByRole('menuitem', { name: /Rename/ }).click();
      const input = page.getByLabel('Tab name');
      await input.fill('Backend');
      await input.click(); // a click inside keeps editing
      await expect(input).toBeFocused();
      await input.dblclick(); // selects a word, still editing
      await expect(input).toBeFocused();
      await input.press('End');
      await page.keyboard.press('Shift+ArrowLeft');
      await page.keyboard.press('Shift+ArrowLeft');
      await expect(input).toBeFocused();
      expect(await input.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart!, el.selectionEnd!))).toBe('nd');
      await page.keyboard.type('X');
      await expect(input).toHaveValue('BackeX');
      await page.keyboard.press('Enter');
      await expect(tab).toContainText('BackeX');
      await expect(page.getByLabel('Tab name')).toHaveCount(0);
    });
    await test.step('rename via the tab menu persists across reload', async () => {
      const tab = page.getByRole('tab').first();
      await tab.click({ button: 'right' });
      await page.getByRole('menuitem', { name: /Rename/ }).click();
      await page.getByLabel('Tab name').fill('Backend');
      await page.keyboard.press('Enter');
      await expect(tab).toContainText('Backend');
      await page.evaluate(() => window.__gb!.flush());
      await page.goto('/');
      await expect(page.getByRole('tab').first()).toContainText('Backend');
    });
    await test.step('profiles swap the tab set', async () => {
      await expect(page.getByRole('tab')).toHaveCount(1);
      await page.getByRole('button', { name: /Profile: Default/ }).click();
      await page.getByRole('menuitem', { name: 'New profile…' }).click();
      await page.getByLabel('Profile name').fill('Work');
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(page.getByRole('button', { name: /Profile: Work/ })).toBeVisible();
      // The new profile has no tabs, so it shows its automatic Open tab.
      await expect(page.getByRole('tab')).toHaveCount(1);
      await expect(page.getByRole('tab').first()).toHaveText('Open repository');
      await page.getByRole('button', { name: /Profile: Work/ }).click();
      await page.getByRole('menuitem', { name: 'Default' }).click();
      await expect(page.getByRole('tab')).toHaveCount(1);
    });
  });

  test('two tabs: only the active one is watched; a drag reorders them; middle-click closes, Ctrl+Shift+T reopens, Ctrl+W closes', async ({ page, request }) => {
    await test.step('only the active tab\'s repo is watched', async () => {
      const a = freshFixture('basic');
      const b = freshFixture('long_labels');
      await page.goto(openBoth(a, b));
      const tabs = page.getByRole('tab');
      await expect(tabs).toHaveCount(2);
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
      const watched = async () => (await (await request.get(`${harnessHttp}/test/watched`)).json()) as number[];
      await expect.poll(watched).toHaveLength(1);
      const first = (await watched())[0];
      await page.keyboard.press('Control+Tab');
      await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
      await expect.poll(async () => { const w = await watched(); return w.length === 1 && w[0] !== first; }).toBe(true);
    });
    await test.step('drag reorders tabs', async () => {
      const tabs = page.getByRole('tab');
      await expect(tabs).toHaveCount(2);
      const [l0, l1] = [await tabs.nth(0).innerText(), await tabs.nth(1).innerText()];
      const box0 = (await tabs.nth(0).boundingBox())!;
      const box1 = (await tabs.nth(1).boundingBox())!;
      await page.mouse.move(box0.x + box0.width / 2, box0.y + box0.height / 2);
      await page.mouse.down();
      await page.mouse.move(box0.x + box0.width / 2 + 10, box0.y + 5, { steps: 3 });
      await page.mouse.move(box1.x + box1.width - 4, box1.y + 5, { steps: 5 });
      // Mid-drag the other tab has slid left into the dragged tab's old slot; the order is unchanged.
      await expect(tabs.nth(1)).toHaveCSS('transform', /^matrix\(1, 0, 0, 1, -\d/);
      await expect(tabs.nth(0)).toHaveText(l0);
      await page.mouse.up();
      await expect(tabs.nth(0)).toHaveText(l1);
      await expect(tabs.nth(1)).toHaveText(l0);
    });
    await test.step('middle-click closes, Ctrl+Shift+T reopens at the same place, Ctrl+W closes', async () => {
      const tabs = page.getByRole('tab');
      await expect(tabs).toHaveCount(2);
      const firstLabel = await tabs.nth(0).innerText();
      await tabs.nth(0).click({ button: 'middle' });
      await expect(tabs).toHaveCount(1);
      await page.keyboard.press('Control+Shift+T');
      await expect(tabs).toHaveCount(2);
      await expect(tabs.nth(0)).toHaveText(firstLabel);
      await page.keyboard.press('Control+w');
      await expect(tabs).toHaveCount(1);
    });
    await test.step('right-click on empty tab-bar space: Reopen brings the closed tab back; Ctrl+Shift+T after closing again', async () => {
      const tabs = page.getByRole('tab');
      await tabs.nth(0).click({ button: 'middle' });
      await expect(tabs).toHaveCount(1);
      const bar = (await page.getByRole('tablist', { name: 'Repositories' }).boundingBox())!;
      await page.mouse.click(bar.x + bar.width - 10, bar.y + bar.height / 2, { button: 'right' });
      await page.getByRole('menuitem', { name: /^Reopen/ }).click();
      await expect(tabs).toHaveCount(2);
      await tabs.nth(0).click({ button: 'middle' });
      await expect(tabs).toHaveCount(1);
      await page.keyboard.press('Control+Shift+T');
      await expect(tabs).toHaveCount(2);
    });
    await test.step('tab groups: a drop onto a tab groups them, the chip collapses them and lists them, Save and close then Saved groups brings them back; a double-click on the empty space opens Open repository', async () => {
      const tabs = page.getByRole('tab');
      const strip = page.getByRole('tablist', { name: 'Repositories' });
      // Two repo tabs: the steps above leave a repo and an Open tab (which a saved group skips).
      await expect(tabs).toHaveCount(2);
      await tabs.filter({ hasText: 'Open repository' }).getByRole('button', { name: /^Close/ }).click();
      await expect(tabs).toHaveCount(1);
      expect((await page.request.post(`${harnessHttp}/test/emit`, { data: { type: 'openRequested', path: freshFixture('basic') } })).ok()).toBe(true);
      await expect(tabs).toHaveCount(2);
      const [l0, l1] = [await tabs.nth(0).innerText(), await tabs.nth(1).innerText()];
      const [id0, id1] = [await tabs.nth(0).getAttribute('data-tab-id'), await tabs.nth(1).getAttribute('data-tab-id')];
      // Drag the first tab until its right edge is in the middle of the second: a drop onto it.
      const box0 = (await tabs.nth(0).boundingBox())!;
      const box1 = (await tabs.nth(1).boundingBox())!;
      const x0 = box0.x + box0.width / 2;
      const y = box0.y + box0.height / 2;
      await page.mouse.move(x0, y);
      await page.mouse.down();
      await page.mouse.move(x0 + 10, y, { steps: 3 });
      await page.mouse.move(x0 + (box1.x + box1.width / 2) - (box0.x + box0.width), y, { steps: 5 });
      await expect(tabs.nth(1)).toHaveClass(/drop-onto/);
      await page.mouse.up();
      const chip = page.getByRole('button', { name: 'Tab group: Blue' });
      await expect(chip).toBeVisible();
      await expect(strip.locator('.tab.grouped')).toHaveCount(2);

      // A click collapses the group to its chip and the active tab; hovering lists both tabs, and
      // a row switches tab without expanding.
      await tabs.nth(0).click();
      await chip.click();
      await expect(chip).toHaveAttribute('aria-expanded', 'false');
      await expect(tabs).toHaveCount(1);
      await expect(tabs.nth(0)).toHaveAttribute('data-tab-id', id0!);
      await page.mouse.move(box1.x + box1.width / 2, y + 200);
      await chip.hover();
      const list = page.getByRole('menu', { name: 'Tabs in Blue' });
      await expect(list.getByRole('menuitemradio')).toHaveText([l0, l1]);
      await list.getByRole('menuitemradio').nth(1).click();
      await expect(tabs).toHaveCount(1);
      await expect(tabs.nth(0)).toHaveAttribute('data-tab-id', id1!);
      await chip.click();
      await expect(tabs).toHaveCount(2);

      // The group menu: a name, then Save and close; the empty space's Saved groups reopens it.
      await chip.click({ button: 'right' });
      const menu = page.getByRole('dialog', { name: 'Tab group' });
      await menu.getByLabel('Group name').fill('Work');
      await menu.getByRole('button', { name: 'Save and close group' }).click();
      await expect(strip.locator('.tab.grouped')).toHaveCount(0);
      const bar = (await strip.boundingBox())!;
      await page.mouse.click(bar.x + bar.width - 10, bar.y + bar.height / 2, { button: 'right' });
      await page.getByRole('menuitem', { name: 'Saved groups' }).hover();
      await page.getByRole('menuitem', { name: 'Work (2 tabs)' }).click();
      const work = page.getByRole('button', { name: 'Tab group: Work' });
      await expect(work).toBeVisible();
      await expect(strip.locator('.tab.grouped')).toHaveText([l0, l1]);

      // The last group in the strip: its last tab leaves it to the right, into the empty strip,
      // once its middle is past the group's end.
      const drag = async (tab: number, dx: number) => {
        const b = (await tabs.nth(tab).boundingBox())!;
        await page.mouse.move(b.x + b.width / 2, y);
        await page.mouse.down();
        await page.mouse.move(b.x + b.width / 2 + Math.sign(dx) * 10, y, { steps: 3 });
        await page.mouse.move(b.x + b.width / 2 + dx, y, { steps: 6 });
        await page.mouse.up();
        await expect(strip).not.toHaveClass(/reordering/); // settled and committed
      };
      // (The Open repository tab the steps above left comes first.)
      const last = (await tabs.count()) - 1;
      const [g0, g1] = [await tabs.nth(last - 1).getAttribute('data-tab-id'), await tabs.nth(last).getAttribute('data-tab-id')];
      const grouped = strip.locator('.tab.grouped');
      await drag(last, (await tabs.nth(last).boundingBox())!.width * 0.75);
      await expect(grouped).toHaveCount(1);
      await expect(grouped).toHaveAttribute('data-tab-id', g0!);
      await expect(tabs.nth(last)).toHaveAttribute('data-tab-id', g1!);

      // Back, as the first tab of that one-tab group: dragged left over its tab and onto the chip,
      // its left edge still right of the chip's left edge, it lands after the chip.
      const chipBox = (await work.boundingBox())!;
      await drag(last, chipBox.x + chipBox.width / 2 - (await tabs.nth(last).boundingBox())!.x);
      await expect(grouped).toHaveCount(2);
      await expect(tabs.nth(last - 1)).toHaveAttribute('data-tab-id', g1!);
      await expect(tabs.nth(last)).toHaveAttribute('data-tab-id', g0!);
      const keys = await strip.locator('[data-strip-key]').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.stripKey!.split(':')[0]));
      expect(keys).toEqual(['tab', 'chip', 'tab', 'tab']);

      // Between two groups, in neither: the Open tab in a group of its own, then Work's last tab
      // dragged left past Work's chip (its left edge just past it): the chip moves aside for it.
      await tabs.nth(0).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Add to new group' }).click();
      await expect(strip.locator('.tab-group-chip')).toHaveCount(2);
      const workBox = (await work.boundingBox())!;
      const b0 = (await tabs.nth(last).boundingBox())!;
      await page.mouse.move(b0.x + b0.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(b0.x + b0.width / 2 - 10, y, { steps: 3 });
      await page.mouse.move(b0.x + b0.width / 2 + workBox.x - 16 - b0.x, y, { steps: 8 });
      await expect(tabs.nth(last)).not.toHaveAttribute('data-group-color');
      await expect.poll(async () => (await work.boundingBox())!.x).toBeGreaterThan(workBox.x + b0.width / 2); // aside
      await page.mouse.up();
      await expect(strip).not.toHaveClass(/reordering/);
      await expect(tabs.nth(1)).toHaveAttribute('data-tab-id', g0!);
      await expect(tabs.nth(1)).not.toHaveClass(/grouped/);
      const keys2 = await strip.locator('[data-strip-key]').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.stripKey!.split(':')[0]));
      expect(keys2).toEqual(['chip', 'tab', 'tab', 'chip', 'tab']);

      // A double-click on the empty space: a new tab on the Open repository screen.
      const before = await tabs.count();
      await page.mouse.dblclick(bar.x + bar.width - 10, bar.y + bar.height / 2);
      await expect(tabs).toHaveCount(before + 1);
      await expect(page.getByRole('tab', { selected: true })).toHaveText('Open repository');
    });
  });

  test('a later launch\'s path (openRequested) opens in a new tab, or focuses the one showing it', async ({ page }) => {
    const a = freshFixture('basic');
    const b = freshFixture('long_labels');
    await page.goto(`/?repo=${encodeURIComponent(a)}`);
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveCount(1);
    await expect(page.locator('.tab-page:visible .graph-row').first()).toBeVisible();
    const emit = async (path: string) => expect((await page.request.post(`${harnessHttp}/test/emit`, { data: { type: 'openRequested', path } })).ok()).toBe(true);
    await emit(b);
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await emit(a);
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(tabs).toHaveCount(2);
    await page.waitForTimeout(300); // nothing left in the queue to open again
    await expect(tabs).toHaveCount(2);
  });

  test('a path forwarded before the page listened opens at boot, once', async ({ page }) => {
    const a = freshFixture('basic');
    const b = freshFixture('long_labels');
    // App startup: the backend queues the forward; no page is listening for the event yet.
    expect((await page.request.post(`${harnessHttp}/test/emit`, { data: { type: 'openRequested', path: b } })).ok()).toBe(true);
    await page.goto(`/?repo=${encodeURIComponent(a)}`);
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.evaluate(() => window.__gb!.flush());
    await page.reload();
    await expect(page.locator('.tab-page:visible .graph-row').first()).toBeVisible();
    await expect(tabs).toHaveCount(2);
  });


  // Spec §17.3: switching to a loaded tab paints its cached snapshot in < 50 ms. Measured from the
  // click to two animation frames later (the frame that paints it); a sample only counts if the
  // tab's graph rows are on screen by then. Load only ever slows a sample, so the bound is checked
  // against the best of several switches (as in menu-perf.spec.ts): a regression slows every one.
  test('switching to a loaded tab paints in under 50 ms (best of several switches)', { tag: '@budget' }, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'budget measured on the engine GitBolt ships (CEF = Chromium)');
    const a = freshFixture('basic');
    const b = freshFixture('long_labels');
    await page.goto(openBoth(a, b));
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveCount(2);
    const graphOf = (i: number) => page.locator('.tab-page').nth(i).getByRole('grid', { name: 'Commit graph' });
    // Load both tabs once (a tab loads on its first activation), ending on tab 1.
    await tabs.nth(0).click();
    await expect(graphOf(0)).toBeVisible();
    await tabs.nth(1).click();
    await expect(graphOf(1)).toBeVisible();
    await page.waitForTimeout(300);
    const samples: number[] = [];
    for (let i = 0; i < 6; i++) {
      const to = i % 2 === 0 ? 0 : 1;
      const ms = await page.evaluate((idx) => new Promise<number>((resolve, reject) => {
        const tab = document.querySelectorAll<HTMLElement>('[role="tab"]')[idx];
        const t0 = performance.now();
        tab.click();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const dt = performance.now() - t0;
          const grid = document.querySelectorAll<HTMLElement>('.tab-page')[idx].querySelector<HTMLElement>('[role="grid"]');
          if (!grid || grid.getClientRects().length === 0 || !grid.querySelector('[role="row"]')) reject(new Error(`tab ${idx} not painted after two frames`));
          else resolve(dt);
        }));
      }), to);
      await expect(tabs.nth(to)).toHaveAttribute('aria-selected', 'true');
      await expect(graphOf(to)).toBeVisible();
      samples.push(ms);
      await page.waitForTimeout(150);
    }
    test.info().annotations.push({ type: 'tab switch ms', description: samples.map((n) => n.toFixed(1)).join(', ') });
    expect(Math.min(...samples), `switch samples ${samples.map((n) => n.toFixed(1)).join(', ')} ms`).toBeLessThan(50);
  });
});
