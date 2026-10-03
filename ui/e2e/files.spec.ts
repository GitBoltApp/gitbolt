import { expect, test, type Page } from './test';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fixtures, harnessHttp, openUrl } from './fixtures';

// Diff prefs persist in localStorage (plan 1B amendment 3). Playwright gives every test a fresh
// browser context, so each test starts from the default (Inline).

async function selectRow(page: Page, text: string) {
  await page.getByRole('row').filter({ hasText: text }).click();
}
const fileRow = (page: Page, path: string) => page.locator(`[role="option"][data-path="${path}"], [role="treeitem"][data-path="${path}"]`);
/** The file list's own Path/Tree buttons: the sidebar's "Sort …: tree" buttons share the name. */
const listMode = (page: Page, mode: 'Path' | 'Tree') => page.getByRole('toolbar', { name: 'File list options' }).getByRole('button', { name: mode });

test.describe('file list and diff takeover', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(openUrl(fixtures.details));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
  });

  test('the header counts changes; a rename shows its new path, the old one on hover (H22)', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    await expect(page.getByTestId('file-counts')).toHaveAccessibleName('6 modified · 2 added · 1 deleted · 1 renamed');
    await expect(page.getByTestId('file-totals')).toContainText('+');
    await expect(fileRow(page, 'docs/manual.txt')).toContainText('docs/manual.txt');
    await expect(fileRow(page, 'docs/manual.txt')).not.toContainText('guide');
    await fileRow(page, 'logo.png').hover();
    await expect(fileRow(page, 'logo.png').locator('.file-stats')).toBeVisible();
    await expect(fileRow(page, 'logo.png').locator('.file-stats')).toHaveText('binary');
    await expect(page.getByRole('tooltip')).toHaveText('logo.png');
  });

  test('tree mode shows a rename by its new name; every row\'s tooltip has its full path, a rename old ↓ new (H22)', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    await listMode(page, 'Tree').click();
    const renamed = fileRow(page, 'docs/manual.txt');
    await expect(renamed.locator('.file-name')).toHaveText('manual.txt');
    await expect(renamed.locator('.file-dir')).toHaveCount(0);
    await renamed.hover();
    const tip = page.getByRole('tooltip');
    // Shown at once (no delay), three lines: old path, a centred arrow, new path; left-aligned.
    await expect(tip).toBeVisible({ timeout: 300 });
    const lines = tip.getByTestId('rename-paths').locator(':scope > *');
    await expect(lines).toHaveText(['docs/guide.txt', '↓', 'docs/manual.txt']);
    const [oldBox, arrowBox, newBox, boxBox] = await Promise.all([lines.nth(0).boundingBox(), lines.nth(1).boundingBox(), lines.nth(2).boundingBox(), tip.getByTestId('rename-paths').boundingBox()]);
    expect(Math.abs(oldBox!.x - newBox!.x)).toBeLessThan(0.5);
    expect(Math.abs(oldBox!.x - boxBox!.x)).toBeLessThan(0.5);
    expect(Math.abs(arrowBox!.x + arrowBox!.width / 2 - (boxBox!.x + boxBox!.width / 2))).toBeLessThan(1);
    expect(oldBox!.y).toBeLessThan(arrowBox!.y);
    expect(arrowBox!.y).toBeLessThan(newBox!.y);
    await fileRow(page, 'dir with space/ünï.txt').hover();
    await expect(tip).toHaveText('dir with space/ünï.txt');
  });

  test('J18: a row\'s tooltip opens left of the file list, centred on the row, clear of the rows around it', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    const list = (await page.locator('.file-list').boundingBox())!;
    for (const path of ['docs/manual.txt', 'logo.png']) {
      const row = fileRow(page, path);
      await row.hover();
      const tip = page.getByRole('tooltip');
      await expect(tip).toBeVisible({ timeout: 300 });
      const [t, r] = [(await tip.boundingBox())!, (await row.boundingBox())!];
      // Right edge a small gap before the list's left edge: it covers no row, above or below.
      expect(t.x + t.width).toBeLessThanOrEqual(list.x - 4);
      expect(list.x - (t.x + t.width)).toBeLessThan(10);
      expect(Math.abs(t.y + t.height / 2 - (r.y + r.height / 2))).toBeLessThan(1);
      await expect(tip).toHaveCSS('pointer-events', 'none');
    }
  });

  test('J18: in a window too narrow for it on the left, a row\'s tooltip goes below the row', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    // The details panel keeps its 280 px minimum: 80 px are left of it, too few for the tooltip.
    // The sidebar goes to its 40 px icon strip (Ctrl+B) so that's the center's room, not its own.
    await page.keyboard.press('Control+b');
    await expect(page.getByRole('complementary', { name: 'Sidebar (collapsed)' })).toBeVisible();
    await page.setViewportSize({ width: 360, height: 700 });
    const list = (await page.locator('.file-list').boundingBox())!;
    expect(list.x).toBeLessThan(90);
    const row = fileRow(page, 'docs/manual.txt');
    const r = (await row.boundingBox())!;
    await row.hover();
    const t = (await page.getByRole('tooltip').boundingBox())!;
    expect(t.width).toBeGreaterThan(list.x);
    expect(t.y).toBeGreaterThanOrEqual(r.y + r.height);
  });

  test('J9: a double-click or a drag in the file panel selects no text; tooltips still show', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    await listMode(page, 'Tree').click();
    const selection = () => page.evaluate(() => window.getSelection()?.toString() ?? '');
    for (const el of [fileRow(page, 'src/app.php').locator('.file-name'), fileRow(page, 'docs').locator('.file-name'), page.getByTestId('file-totals')]) {
      await el.dblclick();
      expect(await selection()).toBe('');
    }
    // A drag from one row's name across the header.
    const from = (await fileRow(page, 'logo.png').locator('.file-name').boundingBox())!;
    const to = (await page.getByTestId('file-counts').boundingBox())!;
    await page.mouse.move(from.x + 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
    expect(await selection()).toBe('');
    await fileRow(page, 'src/app.php').hover();
    await expect(page.getByRole('tooltip')).toHaveText('src/app.php');
  });

  test('J15: a rename\'s tooltip dims the parts both paths share', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    await fileRow(page, 'docs/manual.txt').hover();
    const lines = page.getByRole('tooltip').getByTestId('rename-paths').locator(':scope > *');
    await expect(lines).toHaveText(['docs/guide.txt', '↓', 'docs/manual.txt']);
    for (const [i, changed] of [[0, 'guide'], [2, 'manual']] as const) {
      await expect(lines.nth(i).locator('.rename-changed')).toHaveText(changed);
      await expect(lines.nth(i).locator('.rename-changed')).toHaveCSS('color', 'rgb(255, 255, 255)');
      await expect(lines.nth(i).locator('.rename-common')).toHaveText(['docs/', '.txt']);
      await expect(lines.nth(i).locator('.rename-common').first()).toHaveCSS('color', 'rgba(255, 255, 255, 0.6)');
    }
  });

  test('rows and folders show a pointer cursor; clicking the open file closes it (H5, H5b)', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    await expect(fileRow(page, 'src/app.php')).toHaveCSS('cursor', 'pointer');
    await listMode(page, 'Tree').click();
    await expect(fileRow(page, 'docs')).toHaveCSS('cursor', 'pointer');
    await fileRow(page, 'src/app.php').click();
    await expect(page.getByRole('region', { name: 'Diff' })).toBeVisible();
    await fileRow(page, 'src/app.php').click();
    await expect(page.getByRole('region', { name: 'Diff' })).toHaveCount(0);
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    // The keyboard stays on the file: Enter opens it again, Space closes it.
    const list = page.getByRole('tree', { name: 'Changed files' });
    await expect(list).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('diff-path')).toContainText('app.php');
    await expect(list).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByRole('region', { name: 'Diff' })).toHaveCount(0);
  });

  test('K2, K3: quick clicks each count, the second of a double-click too (a file opens and closes, a folder toggles back)', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    const diff = page.getByRole('region', { name: 'Diff' });
    // Two presses within the double-click time: open, then close.
    await fileRow(page, 'crlf.txt').dblclick();
    await expect(diff).toHaveCount(0);
    // Three: open, close, open.
    await fileRow(page, 'crlf.txt').click({ clickCount: 3 });
    await expect(page.getByTestId('diff-path')).toContainText('crlf.txt');
    await listMode(page, 'Tree').click();
    const docs = fileRow(page, 'docs');
    await expect(docs).toHaveAttribute('aria-expanded', 'true');
    await docs.dblclick();
    await expect(docs).toHaveAttribute('aria-expanded', 'true');
    await expect(fileRow(page, 'docs/manual.txt')).toBeVisible();
    await docs.click({ clickCount: 3 });
    await expect(docs).toHaveAttribute('aria-expanded', 'false');
    await expect(fileRow(page, 'docs/manual.txt')).toHaveCount(0);
  });

  test('a collapsed folder\'s counts follow its name; Expand/Collapse\'s icon ink sits 8 px in (H16, H17)', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    await listMode(page, 'Tree').click();
    await fileRow(page, 'docs').click();
    const [name, counts, row] = await Promise.all([
      fileRow(page, 'docs').locator('.file-name').boundingBox(),
      fileRow(page, 'docs').getByTestId('folder-counts').boundingBox(),
      fileRow(page, 'docs').boundingBox(),
    ]);
    expect(counts!.x - (name!.x + name!.width)).toBeCloseTo(6, 0);
    expect(row!.x + row!.width - (counts!.x + counts!.width)).toBeGreaterThan(40);
    // H17: the chevrons' ink (not their box) is as far from the border as the text is from the
    // other side.
    const button = page.getByRole('toolbar', { name: 'File list options' }).getByRole('button', { name: 'Expand all' });
    const gaps = await button.evaluate((b) => {
      const box = b.getBoundingClientRect();
      const ink = [...b.querySelectorAll('svg path')].map((p) => p.getBoundingClientRect());
      const range = document.createRange();
      range.selectNodeContents([...b.childNodes].find((n) => n.nodeType === Node.TEXT_NODE)!);
      const text = range.getBoundingClientRect();
      const border = parseFloat(getComputedStyle(b).borderLeftWidth);
      return { left: Math.min(...ink.map((r) => r.left)) - box.left - border, right: box.right - border - text.right };
    });
    // The path boxes exclude the 1 px stroke's outer half.
    expect(Math.abs(gaps.left - 0.5 - gaps.right)).toBeLessThan(1);
  });

  test('right-click a file: the file menu copies its paths; Open in ▸ launches the picked opener (spec §7, H9)', async ({ page, request, browserName }) => {
    const launches = async () => (await (await request.get(`${harnessHttp}/launches`)).json()) as { program: string; args: string[] }[];
    const clip = () => page.evaluate(() => navigator.clipboard.readText());
    const before = (await launches()).length;
    await selectRow(page, 'Rename guide and update assets');
    const sha = execFileSync('git', ['-C', fixtures.details, 'rev-parse', 'HEAD^1'], { encoding: 'utf8' }).trim();
    const row = fileRow(page, 'src/app.php');
    const box = (await row.boundingBox())!;
    // Settled, as the page is by a user's first right-click: the selection's loads are done.
    await expect(page.getByTestId('commit-message')).toContainText('Rename guide');
    await page.evaluate(() => new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 200)));
    await row.click({ button: 'right', position: { x: 40, y: 10 } });
    const menu = page.getByTestId('context-menu');
    await expect(menu).toBeVisible();
    // At the pointer: its top-left there, or flipped up (spec §7) so its bottom-left is, when it
    // wouldn't fit below. 3A's rows make it too tall to fit under this row at 720 px.
    const m = (await menu.boundingBox())!;
    const vh = page.viewportSize()!.height;
    expect(Math.abs(m.x - (box.x + 40))).toBeLessThan(2);
    const fitsBelow = box.y + 10 + m.height + 4 <= vh;
    expect(Math.abs((fitsBelow ? m.y : m.y + m.height) - (box.y + 10))).toBeLessThan(2);
    // The latency budgets (cold tripwire, warm median) live in menu-perf.spec.ts, so a loaded
    // machine can't fail this functional test. Here: the opening was timed, and wasn't absurd.
    const opened = await page.evaluate(() => window.__gbMenuLatency!);
    expect(opened).toBeGreaterThanOrEqual(0);
    expect(opened).toBeLessThan(2000);
    // 3A (spec #3 §3.8, §4.2): Restore from <sha6> first, File history and Blame last.
    await expect(menu.locator('[data-depth="0"] > [role="menuitem"] .ctx-label')).toHaveText([`Restore from ${sha.slice(0, 6)}`, 'Copy path', 'Forge link', 'Open in', 'View', 'File history', 'Blame']);
    await expect(page.getByRole('region', { name: 'Diff' })).toHaveCount(0);
    // Every row's tooltip shows at once.
    await menu.getByRole('menuitem', { name: /^Copy path/ }).hover();
    await expect(page.getByRole('tooltip')).toHaveText('Copy "src/app.php"');
    // Copy path | Rel | Abs |.
    await menu.getByRole('button', { name: /absolute path/ }).click();
    await expect(menu).toBeHidden();
    if (browserName === 'chromium') await expect.poll(clip).toBe(`${fixtures.details}/src/app.php`);
    await row.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await menu.getByRole('button', { name: /repository-relative path/ }).click();
    if (browserName === 'chromium') await expect.poll(clip).toBe('src/app.php');
    // Forge link: no upstream is known (never fetched), so its label copies the permalink.
    await row.click({ button: 'right' });
    await expect(menu.getByRole('button', { name: /on its branch/ })).toHaveAttribute('aria-disabled', 'true');
    await menu.getByText('Forge link').click();
    if (browserName === 'chromium') await expect.poll(clip).toBe(`https://gitlab.example.com/group/project/-/blob/${sha}/src/app.php`);

    // Open in ▸: the detected openers, then Show in Files, then Other….
    await row.click({ button: 'right' });
    const openIn = menu.getByRole('menuitem', { name: 'Open in', exact: true });
    await openIn.hover();
    const sub = page.getByRole('menu', { name: 'Open in' });
    await expect(sub.getByRole('menuitem')).toHaveText(['Open in VS Code', 'Open in PhpStorm', 'Open in Text Editor', 'Show in Files', 'Other…']);
    await expect(sub.locator('[data-active="true"]')).toHaveAttribute('data-row-id', 'opener.vscode');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect.poll(async () => (await launches()).length).toBe(before + 1);
    // A commit's file opens as a read-only copy of that version (spec §14.5), under its path.
    const phpstorm = (await launches()).at(-1)!;
    expect(phpstorm.program).toBe('/fake/bin/phpstorm');
    const file = phpstorm.args[0];
    expect(file).toMatch(/\/[0-9a-f]{12}\/src\/app\.php$/);
    expect(statSync(file).mode & 0o777).toBe(0o444);
    expect(readFileSync(file, 'utf8')).toBe(execFileSync('git', ['-C', fixtures.details, 'show', 'HEAD^1:src/app.php'], { encoding: 'utf8' }));
    // The last used is remembered (the submenu starts on it); the file manager opens the folder.
    await row.click({ button: 'right' });
    await openIn.hover();
    await expect(sub.locator('[data-active="true"]')).toHaveAttribute('data-row-id', 'opener.jetbrains-phpstorm');
    await sub.getByRole('menuitem', { name: 'Show in Files' }).click();
    await expect.poll(async () => (await launches()).length).toBe(before + 2);
    expect((await launches()).at(-1)).toEqual({ program: '/fake/bin/nautilus', args: ['--new-window', `${fixtures.details}/src`] });
    expect(await page.evaluate(() => localStorage.getItem('gitbolt.openIn.v1'))).toBe(JSON.stringify({ last: 'file-manager' }));
    // H32: "Other…" hands the file to the system's Open With chooser (recorded by the harness).
    await row.click({ button: 'right' });
    await openIn.hover();
    await sub.getByRole('menuitem', { name: 'Other…' }).click();
    await expect.poll(async () => (await launches()).length).toBe(before + 3);
    expect((await launches()).at(-1)).toEqual({ program: 'open-with-chooser', args: [file] });
    // Escape closes the menu and gives the list its focus back.
    await row.click({ button: 'right' });
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(page.getByRole('listbox', { name: 'Changed files' })).toBeFocused();
    expect((await launches()).length).toBe(before + 3);
    // A WIP file opens the working-tree file itself.
    await page.getByRole('row').filter({ hasText: '// WIP' }).locator('[data-col="message"]').click({ position: { x: 3, y: 3 } });
    const unstaged = page.getByRole('listbox', { name: 'Unstaged' });
    await unstaged.getByRole('option').and(page.locator('[data-path="notes.txt"]')).click({ button: 'right' });
    await openIn.hover();
    await sub.getByRole('menuitem', { name: 'Open in VS Code' }).click();
    await expect.poll(async () => (await launches()).length).toBe(before + 4);
    expect((await launches()).at(-1)).toEqual({ program: '/fake/bin/code', args: [`${fixtures.details}/notes.txt`] });
    // A staged file opens the working-tree file too (fix round 2), not a copy of the index.
    const staged = page.getByRole('listbox', { name: 'Staged' });
    await staged.getByRole('option').and(page.locator('[data-path="src/app.php"]')).click({ button: 'right' });
    await openIn.hover();
    await sub.getByRole('menuitem', { name: 'Open in VS Code' }).click();
    await expect.poll(async () => (await launches()).length).toBe(before + 5);
    expect((await launches()).at(-1)).toEqual({ program: '/fake/bin/code', args: [`${fixtures.details}/src/app.php`] });
    // View (K58) opens the diff in the center; its File variant opens the whole file.
    await unstaged.getByRole('option').and(page.locator('[data-path="docs/manual.txt"]')).click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'View' }).click();
    await expect(page.getByRole('region', { name: 'Diff' }).getByTestId('diff-path')).toContainText('manual.txt');
    await expect(page.getByTestId('file-view')).toHaveCount(0);
    await unstaged.getByRole('option').and(page.locator('[data-path="docs/manual.txt"]')).click({ button: 'right' });
    await menu.locator('.ctx-variant[data-variant-id="file"]').click();
    await expect(page.getByTestId('file-view')).toBeVisible();
  });

  test('K1: a right-click always opens the file menu: just after a wheel scroll, again and again, on other rows, over a tooltip', async ({ page }) => {
    // Short enough, with every file listed, for the file list to scroll.
    await page.setViewportSize({ width: 1280, height: 440 });
    await selectRow(page, 'Rename guide and update assets');
    await page.getByRole('button', { name: 'View all files' }).click();
    const list = page.getByRole('listbox', { name: 'Changed files' });
    await expect(fileRow(page, 'ws.txt')).toHaveCount(1);
    expect(await list.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(60);
    const menu = page.getByTestId('context-menu');
    // A couple of frames and a task: long enough for any late scroll event to land.
    const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))));
    const rightClick = async () => {
      await page.mouse.down({ button: 'right' });
      await page.mouse.up({ button: 'right' });
    };
    const lb = (await list.boundingBox())!;
    // The wheel's scroll event is dispatched in the next frame, after the right-click that
    // follows it: it used to close the menu the right-click had just opened.
    for (const dy of [60, -60, 60]) {
      await page.mouse.move(lb.x + 60, lb.y + lb.height / 2);
      await page.mouse.wheel(0, dy);
      await rightClick();
      await settle();
      await expect(menu).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
    }
    // Open, the wheel over the list scrolls nothing behind it, and the menu stays.
    await page.mouse.move(lb.x + 60, lb.y + lb.height / 2);
    await rightClick();
    await expect(menu).toBeVisible();
    const top = await list.evaluate((el) => el.scrollTop);
    await page.mouse.move(lb.x + 20, lb.y + lb.height / 2);
    await page.mouse.wheel(0, 60);
    await settle();
    await expect(menu).toBeVisible();
    expect(await list.evaluate((el) => el.scrollTop)).toBe(top);
    await page.keyboard.press('Escape');
    // Off the list first: the checks above leave the pointer on whichever row sits mid-list (the
    // layout decides which; it can be src/app.php), and a row's tooltip opens only on entering it.
    // The status bar's empty middle: the window's corner is the hamburger, which has a tooltip.
    const off = (await page.locator('.sb-spacer').boundingBox())!;
    await page.mouse.move(off.x + off.width / 2, off.y + off.height / 2);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    // Again on the same row, then on others, each with the previous menu still open, and each
    // other row with its tooltip showing. Each step lands left of the menu before (which opened
    // at the pointer), on the row itself, and each menu opens at the pointer.
    const steps = [['src/app.php', 48], ['src/app.php', 40], ['src/app.php', 32], ['crlf.txt', 24], ['logo.png', 16], ['crlf.txt', 8]] as const;
    let last = '';
    for (const [path, x] of steps) {
      const row = fileRow(page, path);
      await row.scrollIntoViewIfNeeded();
      await row.hover({ position: { x, y: 5 } });
      if (path !== last) await expect(page.getByRole('tooltip')).toHaveText(path);
      last = path;
      await rightClick();
      await settle();
      await expect(menu).toBeVisible();
      const [m, r] = [(await menu.boundingBox())!, (await row.boundingBox())!];
      expect(Math.abs(m.x - (r.x + x))).toBeLessThan(2);
    }
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });

  test('the Open in submenu stays open on a diagonal move across the rows below its row (hover intent)', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    await fileRow(page, 'src/app.php').click({ button: 'right', position: { x: 40, y: 10 } });
    const menu = page.getByTestId('context-menu');
    const openIn = menu.getByRole('menuitem', { name: 'Open in', exact: true });
    const a = (await openIn.boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    const sub = page.getByRole('menu', { name: 'Open in' });
    await expect(sub).toBeVisible();
    // The row's own tooltip would cover the submenu: it's gone once the submenu is open.
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    // To the submenu's last row, in steps, diagonally: across the "Open in" and "View" rows.
    const last = sub.getByRole('menuitem').last();
    const b = (await last.boundingBox())!;
    const to = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const viewRow = (await menu.getByRole('menuitem', { name: 'View' }).boundingBox())!;
    expect(to.y).toBeGreaterThan(viewRow.y);
    await page.mouse.move(to.x, to.y, { steps: 12 });
    // Longer than the safe triangle's rest timer: it stayed open, on the row the pointer reached.
    await page.waitForTimeout(400);
    await expect(sub).toBeVisible();
    await expect(sub.locator('[data-active="true"]')).toHaveAttribute('data-row-id', 'opener.other');
    await expect(menu.locator('[data-depth="0"] > [data-active="true"]')).toHaveAttribute('data-row-id', 'file.openIn');
    // Onto a sibling from the submenu (no triangle): it closes.
    const view = menu.getByRole('menuitem', { name: 'View' });
    const v = (await view.boundingBox())!;
    await page.mouse.move(v.x + v.width - 10, v.y + v.height / 2);
    await expect(sub).toHaveCount(0);
  });

  test("file rows are the density preset's height (--file-row-h, H1)", async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    const rowH = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--file-row-h'));
    expect(rowH).toBe('26px');
    const rows = page.getByRole('listbox', { name: 'Changed files' }).getByRole('option');
    const [a, b] = await Promise.all([rows.nth(0).boundingBox(), rows.nth(1).boundingBox()]);
    expect(a!.height).toBe(26);
    expect(Math.abs(b!.y - a!.y)).toBe(26);
  });

  test("the diff toolbar's Open in…, at its far left, opens the working-tree file at the first change (H9, J1)", async ({ page, request }) => {
    const launches = async () => (await (await request.get(`${harnessHttp}/launches`)).json()) as { program: string; args: string[] }[];
    const before = (await launches()).length;
    await page.getByRole('row').filter({ hasText: '// WIP' }).locator('[data-col="message"]').click({ position: { x: 3, y: 3 } });
    await page.getByRole('listbox', { name: 'Unstaged' }).getByRole('option').and(page.locator('[data-path="docs/manual.txt"]')).click();
    const d = page.getByRole('region', { name: 'Diff' });
    const bar = d.getByRole('toolbar', { name: 'Diff options' });
    const group = bar.getByRole('group', { name: 'Open in' });
    await expect(group).toBeVisible();
    await expect(d.locator('.diff-header').getByRole('group', { name: 'Open in' })).toHaveCount(0);
    // The far left: only the toolbar's padding (8 px) before it, and before File/Diff View.
    const [b, g, views] = await Promise.all([bar.boundingBox(), group.boundingBox(), bar.getByRole('button', { name: 'File View' }).boundingBox()]);
    expect(g!.x - b!.x).toBeLessThanOrEqual(9);
    expect(g!.x + g!.width).toBeLessThan(views!.x);
    await expect(group.getByRole('button', { name: 'Open in VS Code' })).toBeVisible();
    await group.getByRole('button', { name: 'More ways to open' }).click();
    // The dropdown is the shared context menu (Amendment 11), not a bespoke popup.
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await page.getByRole('menu', { name: 'Open in' }).getByRole('menuitem', { name: 'Open in PhpStorm' }).click();
    await expect.poll(async () => (await launches()).length).toBe(before + 1);
    // The first change's line, as git counts it.
    const hunk = execFileSync('git', ['-C', fixtures.details, 'diff', '-U0', '--', 'docs/manual.txt'], { encoding: 'utf8' });
    const line = hunk.match(/^@@ -\S+ \+(\d+)/m)![1];
    expect((await launches()).at(-1)).toEqual({ program: '/fake/bin/phpstorm', args: ['--line', line, `${fixtures.details}/docs/manual.txt`] });
    // The pick is the header's default now; the diff stays open.
    await expect(group.getByRole('button', { name: 'Open in PhpStorm' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Diff' })).toBeVisible();
  });

  test('opening a file takes over the center with a Shiki-highlighted Inline diff (the default)', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    await fileRow(page, 'src/app.php').click();
    const diff = page.getByRole('region', { name: 'Diff' });
    await expect(diff).toBeVisible();
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeHidden();
    await expect(diff.getByTestId('diff-path')).toContainText('app.php');
    await expect(diff.getByTestId('diff-encoding')).toHaveText('UTF-8');
    // The page's first diff loads the editor's chunk (Monaco + Shiki, 3-5 s cold on the dev server
    // at idle, more on a loaded machine): allow for a cold start.
    await expect(diff.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15_000 });
    const keyword = diff.locator('.editor.modified .view-line span span').filter({ hasText: /^function$/ }).first();
    await expect(keyword).toHaveCSS('color', 'rgb(86, 156, 214)');
    // Inline: once the diff is computed (its inserted-line decorations are drawn), nothing is
    // folded away.
    await expect(diff.locator('.editor.modified .line-insert').first()).toBeVisible();
    await expect(diff.locator('.diff-hidden-lines')).toHaveCount(0);
  });

  test('× closes the diff; Enter in the graph opens the first file, and so does → (J2)', async ({ page }) => {
    await selectRow(page, "Merge branch 'feature/x'");
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('diff-path')).toContainText('feature.txt');
    await page.getByRole('button', { name: 'Close diff' }).click();
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('diff-path')).toContainText('feature.txt');
    await expect(page.getByRole('listbox', { name: 'Changed files' })).toBeFocused();
  });

  test('J2, J3: the arrows walk the files from the graph and back, skipping folder rows (Tree mode)', async ({ page }) => {
    const commit = page.getByRole('row').filter({ hasText: 'Rename guide and update assets' });
    await commit.click();
    await listMode(page, 'Tree').click();
    const grid = page.getByRole('grid', { name: 'Commit graph' });
    const list = page.getByRole('tree', { name: 'Changed files' });
    const path = page.getByTestId('diff-path');
    await grid.focus();
    // → in the graph: the first file as the tree displays it, and the keyboard in the list.
    await page.keyboard.press('ArrowRight');
    await expect(path).toContainText('ünï.txt');
    await expect(list).toBeFocused();
    // → on the open file: nothing.
    await page.keyboard.press('ArrowRight');
    await expect(list).toBeFocused();
    await expect(path).toContainText('ünï.txt');
    // Down/Up: every stop is a file, opened; folder rows are skipped.
    const files = await page.locator('.file-row[data-kind="file"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.path!));
    const folders = await page.locator('.file-row[data-kind="folder"]').count();
    expect(folders).toBeGreaterThan(1);
    for (const f of files.slice(1)) {
      await page.keyboard.press('ArrowDown');
      await expect(fileRow(page, f)).toHaveAttribute('aria-selected', 'true');
      // The header follows once the editor shows the file (F24): allow for a slow diff.
      await expect(path).toContainText(f.split('/').pop()!, { timeout: 15_000 });
    }
    await page.keyboard.press('Home');
    await expect(fileRow(page, files[0])).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(fileRow(page, files.at(-1)!)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowUp');
    await expect(fileRow(page, files.at(-2)!)).toHaveAttribute('aria-selected', 'true');
    // ← on a file: the diff closes, back to the graph with the commit still selected.
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('region', { name: 'Diff' })).toHaveCount(0);
    await expect(grid).toBeFocused();
    await expect(commit).toHaveAttribute('aria-selected', 'true');
  });

  test('after Esc, Enter opens the first file as displayed (Tree mode) and the list highlights it', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    await listMode(page, 'Tree').click();
    await fileRow(page, 'src/app.php').click();
    await expect(page.getByTestId('diff-path')).toContainText('app.php');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeFocused();
    await page.keyboard.press('Enter');
    // Folders first: "dir with space/ünï.txt" leads the tree (the backend's first is big.txt).
    await expect(page.getByTestId('diff-path')).toContainText('ünï.txt');
    await expect(fileRow(page, 'dir with space/ünï.txt')).toHaveAttribute('aria-selected', 'true');
    await expect(fileRow(page, 'src/app.php')).toHaveAttribute('aria-selected', 'false');
    await expect(page.getByRole('tree', { name: 'Changed files' })).toBeFocused();
  });

  test('the header shows coloured status icons; totals and counts sit on either side', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    const counts = page.getByTestId('file-counts');
    await expect(counts.locator('svg')).toHaveCount(4);
    expect(await counts.locator('svg').evaluateAll((els) => els.map((e) => e.getAttribute('data-status')))).toEqual(['modified', 'added', 'deleted', 'renamed']);
    await expect(counts.locator('svg[data-status="modified"]')).toHaveCSS('color', 'rgb(222, 155, 67)');
    await expect(page.getByTestId('file-totals').locator('.added')).toHaveCSS('color', 'rgb(92, 184, 92)');
    await expect(fileRow(page, 'src/app.php').getByRole('img', { name: 'Modified' })).toBeVisible();
  });

  test('tree mode: one smart Expand/Collapse button, file icons line up under their folder\'s name, a click or → toggles a folder', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    await listMode(page, 'Tree').click();
    const toolbar = page.getByRole('toolbar', { name: 'File list options' });
    // Justified: smart button left, Path/Tree centred, View all files right.
    const [smart, tree, all, bar] = await Promise.all([
      toolbar.getByRole('button', { name: 'Collapse all' }).boundingBox(),
      toolbar.locator('.segmented').boundingBox(),
      toolbar.getByRole('button', { name: 'View all files' }).boundingBox(),
      toolbar.boundingBox(),
    ]);
    expect(smart!.x).toBeLessThan(tree!.x);
    expect(Math.abs(tree!.x + tree!.width / 2 - (bar!.x + bar!.width / 2))).toBeLessThan(2);
    expect(all!.x + all!.width).toBeGreaterThan(bar!.x + bar!.width - 16);
    // Alignment (F17), measured: the file's icon starts where its folder's name starts.
    const folderName = await fileRow(page, 'docs').locator('.file-name').boundingBox();
    const icon = await fileRow(page, 'docs/manual.txt').locator('svg.status-icon').boundingBox();
    expect(Math.abs(icon!.x - folderName!.x)).toBeLessThan(0.5);
    await expect(fileRow(page, 'docs').locator('svg')).toHaveCount(1); // no folder icon
    // Everything expanded: collapse all; then the same button expands all.
    await toolbar.getByRole('button', { name: 'Collapse all' }).click();
    await expect(fileRow(page, 'docs')).toHaveAttribute('aria-expanded', 'false');
    await expect(fileRow(page, 'docs').getByTestId('folder-counts')).toHaveAccessibleName('1 renamed');
    await toolbar.getByRole('button', { name: 'Expand all' }).click();
    await expect(fileRow(page, 'docs')).toHaveAttribute('aria-expanded', 'true');
    await expect(fileRow(page, 'docs').getByTestId('folder-counts')).toHaveCount(0);
    // Partly collapsed: it expands.
    await fileRow(page, 'docs').click();
    await toolbar.getByRole('button', { name: 'Expand all' }).click();
    await expect(fileRow(page, 'docs')).toHaveAttribute('aria-expanded', 'true');
    // A folder row collapses on a click (its files go) and → expands it again.
    await fileRow(page, 'docs').click();
    await expect(fileRow(page, 'docs')).toHaveAttribute('aria-expanded', 'false');
    await expect(fileRow(page, 'docs/manual.txt')).toHaveCount(0);
    await page.keyboard.press('ArrowRight');
    await expect(fileRow(page, 'docs')).toHaveAttribute('aria-expanded', 'true');
    await expect(fileRow(page, 'docs/manual.txt')).toBeVisible();
  });

  test('Path/Tree and the sort are remembered across a reload; View all files is not (H31)', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    await page.getByRole('button', { name: 'Sort by status' }).click();
    await page.getByRole('button', { name: 'View all files' }).click();
    await listMode(page, 'Tree').click();
    await page.reload();
    await selectRow(page, 'Rename guide and update assets');
    await expect(listMode(page, 'Tree')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'View all files' })).toHaveAttribute('aria-pressed', 'false');
    await listMode(page, 'Path').click();
    await expect(page.getByRole('button', { name: 'Sort by status' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('a merge commit diffs against the parent picked', async ({ page }) => {
    await selectRow(page, "Merge branch 'feature/x'");
    await expect(page.getByRole('button', { name: 'vs 1st parent' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.getByRole('button', { name: 'vs 2nd parent' }).click();
    await expect(page.getByTestId('file-counts')).toHaveAccessibleName('6 modified · 2 added · 1 deleted · 1 renamed');
  });

  test('View all files opens unchanged files in File View with their encoding', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    await page.getByRole('button', { name: 'View all files' }).click();
    await expect(page.getByRole('option')).toHaveCount(12);
    await fileRow(page, 'latin1.txt').click();
    await expect(page.getByTestId('diff-encoding')).toHaveText('ISO-8859-1');
    // The page's first diff loads the editor's chunk (Monaco + Shiki, 3-5 s cold on the dev server
    // at idle, more on a loaded machine): allow for a cold start.
    await expect(page.getByTestId('file-view')).toContainText('café crème brûlée', { timeout: 15_000 });
    await fileRow(page, 'utf16.txt').click();
    await expect(page.getByTestId('diff-encoding')).toHaveText('UTF-16LE');
  });

  test('K4: ↓ on the last file wraps to the first, and ↑ on the first wraps to the last, in View all files', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    await page.getByRole('button', { name: 'View all files' }).click();
    await expect(page.getByRole('option')).toHaveCount(12);
    const list = page.getByRole('listbox', { name: 'Changed files' });
    await list.focus();
    // Path order: big.txt … ws.txt (last). The row's own selected state (not the diff panel's
    // breadcrumb, which a separate, pre-existing kept-panel bug — K7, Lane R's — can leave
    // showing a stale path when a file already open elsewhere in this sequence reopens) is what
    // this checks: the file list's own navigation and highlight.
    await page.keyboard.press('End');
    await expect(fileRow(page, 'ws.txt')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(fileRow(page, 'big.txt')).toHaveAttribute('aria-selected', 'true'); // wraps to the first row
    await page.keyboard.press('ArrowUp');
    await expect(fileRow(page, 'ws.txt')).toHaveAttribute('aria-selected', 'true'); // wraps back to the last
  });

  test('K18-K20: the View all files filter narrows and highlights, its X re-centres the selection, and Esc clears it first', async ({ page }) => {
    // Short enough that the 12 rows scroll, so re-centring has something to do.
    await page.setViewportSize({ width: 1280, height: 560 });
    await selectRow(page, 'Rename guide and update assets');
    await page.getByRole('button', { name: 'View all files' }).click();
    await expect(page.getByRole('option')).toHaveCount(12);
    const filter = page.getByLabel('Filter files');
    await expect(filter).toBeVisible();
    await filter.fill('svg');
    await expect(page.getByRole('option')).toHaveCount(1);
    const match = fileRow(page, 'icon.svg').locator('mark.filter-match');
    await expect(match).toHaveText('svg');
    // Esc: the input owns it while there's something to clear.
    await page.keyboard.press('Escape');
    await expect(filter).toHaveValue('');
    await expect(page.getByRole('option')).toHaveCount(12);
    // A narrow filter, then the X: the selected row (still open) re-centres in the list.
    await fileRow(page, 'old.txt').click();
    await filter.fill('old');
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.getByRole('button', { name: 'Clear filter' }).click();
    await expect(filter).toHaveValue('');
    await expect(page.getByRole('option')).toHaveCount(12);
    // Centred as far as the list can scroll: the target is the row's centre at the box's centre,
    // clamped to the scroll range (the list's height depends on the shell around it: toolbar,
    // status bar).
    const centring = await page.locator('.file-list-scroll').evaluate((s) => {
      const row = s.querySelector('[data-path="old.txt"]')!.getBoundingClientRect();
      const offset = row.top - s.getBoundingClientRect().top + s.scrollTop;
      const target = Math.max(0, Math.min(offset + row.height / 2 - s.clientHeight / 2, s.scrollHeight - s.clientHeight));
      return { target, off: Math.abs(s.scrollTop - target), rowH: row.height };
    });
    expect(centring.target).toBeGreaterThan(0);
    expect(centring.off).toBeLessThan(centring.rowH);
    // Esc with nothing to clear, focus still in the (empty) filter: the app's Esc as usual
    // (K18-K20's text-input rule), closing the open file — not a no-op, as a plain text input's
    // Esc otherwise would be.
    await expect(page.getByRole('region', { name: 'Diff' })).toBeVisible();
    await filter.focus();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('region', { name: 'Diff' })).toHaveCount(0);
  });

  test('K19: Previous/Next changed file jump to the nearest changed file, skipping unchanged rows, and wrap', async ({ page }) => {
    await selectRow(page, 'Rename guide and update assets');
    await page.getByRole('button', { name: 'View all files' }).click();
    await expect(page.getByRole('option')).toHaveCount(12);
    const next = page.getByRole('button', { name: 'Next changed file' });
    const prev = page.getByRole('button', { name: 'Previous changed file' });
    const selected = () => page.getByRole('option', { selected: true });
    // Path order: … icon.svg, latin1.txt (unchanged), logo.png, … : Next from icon.svg skips it.
    // Checked via the row's own selected state, not the diff panel's breadcrumb: a separate,
    // pre-existing kept-panel bug (K7, Lane R's) can leave that showing a stale path when a file
    // already open earlier in this sequence reopens; the file list's own state is unaffected.
    await fileRow(page, 'icon.svg').click();
    await next.click();
    await expect(selected()).toHaveAttribute('data-path', 'logo.png');
    await prev.click();
    await expect(selected()).toHaveAttribute('data-path', 'icon.svg');
    // Wraps at the ends too (both big.txt, the first row, and ws.txt, the last, are changed).
    await fileRow(page, 'ws.txt').click();
    await next.click();
    await expect(selected()).toHaveAttribute('data-path', 'big.txt');
    await prev.click();
    await expect(selected()).toHaveAttribute('data-path', 'ws.txt');
  });
});

test('Esc returns to the graph with its selection and scroll position unchanged', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 500 });
  await page.goto(openUrl(fixtures.longHistory));
  const grid = page.getByRole('grid', { name: 'Commit graph' });
  await expect(grid).toBeVisible();
  await grid.evaluate((el) => { el.scrollTop = 600; });
  await page.getByRole('row').filter({ hasText: 'Commit 30' }).click();
  const top = await grid.evaluate((el) => el.scrollTop);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Diff' })).toBeVisible();
  // The hidden graph hands focus to the file list, so Escape has somewhere to land.
  await expect(page.getByRole('listbox', { name: 'Changed files' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(grid).toBeVisible();
  await expect(grid).toBeFocused();
  expect(await grid.evaluate((el) => el.scrollTop)).toBe(top);
  await expect(page.getByRole('row').filter({ hasText: 'Commit 30' })).toHaveAttribute('aria-selected', 'true');
});
