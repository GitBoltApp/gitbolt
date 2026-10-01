import { expect, test, type Locator, type Page } from '@playwright/test';
import { fixtures, openUrl } from './fixtures';

// Plan 1C Task 15 (lane W2-D): the commit, branch/tag label and Monaco context menus, over 1B's
// menu system (ui/src/menu). The file and folder menus already have their own e2e coverage in
// files.spec.ts; this file covers the kinds 1C added.
//
// `api.openUrl` can't be observed here (the harness's is "a URL opener that only logs", plan 1B's
// convention: link buttons are checked by their own attribute instead, e2e/details.spec.ts's
// `data-url` on the message's "Open !N" buttons). The context menu's rows have no such attribute,
// so the forge tests below stick to what's independently verifiable: the row's presence, its
// tooltip, and what the label/variants that *copy* (not open) put on the clipboard.

const row = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text });
/** The copy succeeded (its "Copied" toast, on every browser) and put `text` on the clipboard:
 * that's read back on Chromium only, the one project granted clipboard-read (playwright.config.ts;
 * headless WebKit refuses `readText`), as the 1B specs do (e2e/diff.spec.ts, details.spec.ts). */
async function copied(page: Page, text: string) {
  await expect(page.getByRole('status')).toHaveText('Copied');
  if (test.info().project.name === 'chromium') await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(text);
}
const rowLabels = (menu: Locator) => menu.locator('[data-depth="0"] > [role="menuitem"] .ctx-label').allTextContents();
/** A row by its own label, matched on the `.ctx-label` span's exact text rather than the
 * menuitem's full accessible name: that name also picks up its variant buttons' labels/tooltips
 * (ARIA "name from content"), so "Copy branch name" (Local/Remote variants) never equals just
 * that text, and a plain substring match on "Copy" would also catch "Copy location". */
const action = (menu: Locator, label: string) => menu.locator('[data-depth="0"] > [role="menuitem"]').filter({ has: menu.page().locator('.ctx-label').getByText(label, { exact: true }) });
const variant = (row: Locator, name: RegExp | string) => row.getByRole('button', { name });

/** Opens the commit menu on `text`'s row, right-clicking its message cell (never a label chip). */
async function commitMenu(page: Page, text: string) {
  await row(page, text).locator('[data-col="message"]').click({ button: 'right' });
  const menu = page.getByTestId('context-menu');
  await expect(menu).toBeVisible();
  return menu;
}

/** Opens the label menu on `text`'s row's own (first) chip: a branch or a tag. */
async function labelMenu(page: Page, rowText: string) {
  await row(page, rowText).locator('.ref-labels > .ref-label:not(.ref-label-dim)').click({ button: 'right' });
  const menu = page.getByTestId('context-menu');
  await expect(menu).toBeVisible();
  return menu;
}

test.describe('the commit and label context menus (spec §7 target table)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(openUrl(fixtures.basic));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
  });

  test('a plain commit: Copy SHA, Copy message, Compare with working tree; no branch or forge rows; under budget', async ({ page }) => {
    const menu = await commitMenu(page, 'Fix typo');
    await expect(menu.locator('[data-depth="0"] > [role="menuitem"] .ctx-label')).toHaveText(['Copy SHA', 'Copy message', 'Compare with working tree']);
    // The cold first opening (plan 1C's e2e caveat, M report item 15): a tripwire, not the budget.
    expect(await page.evaluate(() => window.__gbMenuLatency!)).toBeLessThan(75);
    await page.keyboard.press('Escape');

    // Warm, the budget applies (spec §7, §17.3): the median of 5 (files.spec.ts's pattern), since
    // any one sample is at the mercy of a GC pause or a busy machine.
    const warm: number[] = [];
    for (let i = 0; i < 5; i++) {
      await row(page, 'Fix typo').locator('[data-col="message"]').click({ button: 'right' });
      await expect(menu).toBeVisible();
      warm.push(await page.evaluate(() => window.__gbMenuLatency!));
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
    }
    expect(warm.sort((a, b) => a - b)[2]).toBeLessThan(16);

    await row(page, 'Fix typo').locator('[data-col="message"]').click({ button: 'right' });
    await action(menu, 'Copy SHA').hover();
    await expect(page.getByRole('tooltip')).toHaveText('Copy the full commit id');
    await action(menu, 'Copy message').click();
    await expect(menu).toBeHidden();
    await copied(page, 'Fix typo');

    const sha = await row(page, 'Fix typo').getByTestId('sha').textContent();
    // Each pick (the row's own or a variant's) runs and closes the menu: reopen between them.
    await row(page, 'Fix typo').locator('[data-col="message"]').click({ button: 'right' });
    await variant(action(menu, 'Copy SHA'), 'Copy the short id').click();
    await copied(page, sha!.slice(0, 6)); // SHORT_SHA_LEN (format/sha.ts, H15)

    await row(page, 'Fix typo').locator('[data-col="message"]').click({ button: 'right' });
    await action(menu, 'Copy SHA').click();
    await copied(page, sha!);
  });

  test('the WIP row gets no commit menu', async ({ page }) => {
    // Two worktrees are dirty (the main one and wt-hotfix, fixtures.rs): either WIP row will do.
    await page.getByRole('row').filter({ hasText: '// WIP' }).first().locator('[data-col="message"]').click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).not.toBeVisible();
  });

  test("a branch label chip: Copy branch name (Local, Remote), Compare with HEAD names both branches", async ({ page }) => {
    const menu = await labelMenu(page, 'Login validation');
    await expect(rowLabels(menu)).resolves.toEqual(['Copy branch name', 'Copy SHA', 'Copy message', 'Compare with HEAD']);
    const compare = action(menu, 'Compare with HEAD');
    await expect(compare).not.toHaveAttribute('aria-disabled', 'true');
    await compare.hover();
    await expect(page.getByRole('tooltip')).toHaveText('Compare feature/login with HEAD (main)');
    await page.keyboard.press('Escape');

    // Each pick (the label or a variant) runs and closes the menu, as every context-menu pick
    // does (ContextMenu.tsx's `finish`): reopen it before each one.
    await labelMenu(page, 'Login validation');
    await action(menu, 'Copy branch name').click();
    await copied(page, 'feature/login');

    await labelMenu(page, 'Login validation');
    await variant(action(menu, 'Copy branch name'), 'Copy the local branch name').click();
    await copied(page, 'feature/login');

    await labelMenu(page, 'Login validation');
    await variant(action(menu, 'Copy branch name'), /^Copy "origin\/feature\/login"/).click();
    await copied(page, 'origin/feature/login');
  });

  test("main's own chip, on its tip commit: Compare with HEAD is disabled (already there)", async ({ page }) => {
    const menu = await labelMenu(page, "Merge branch 'feature/login'");
    await expect(action(menu, 'Compare with HEAD')).toHaveAttribute('aria-disabled', 'true');
    await action(menu, 'Compare with HEAD').hover();
    await expect(page.getByRole('tooltip')).toHaveText('Already at HEAD');
  });

  test('a local-only branch: Copy branch name Remote is disabled ("not on a remote")', async ({ page }) => {
    const menu = await labelMenu(page, 'Hotfix: null check');
    const branchRow = action(menu, 'Copy branch name');
    // The variant's aria-label is its tooltip ("This branch isn't on a remote"); the shown
    // tooltip, once hovered, prefers its shorter `disabledReason` ("Not on a remote").
    await variant(branchRow, /isn't on a remote/).hover();
    await expect(page.getByRole('tooltip')).toHaveText('Not on a remote');
  });

  test('a tag label chip: Copy tag name only (no forge on a generic remote)', async ({ page }) => {
    const menu = await labelMenu(page, 'Add readme');
    await expect(rowLabels(menu)).resolves.toEqual(['Copy tag name']);
    await action(menu, 'Copy tag name').click();
    await copied(page, 'v1.0');
  });
});

test.describe('forge rows (a GitLab remote, fixtures.details)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(openUrl(fixtures.details));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
  });

  test('MR references in the message get one Open row each; the issue reference gets none', async ({ page }) => {
    const menu = await commitMenu(page, 'Rename guide and update assets');
    await expect(rowLabels(menu)).resolves.toEqual(['Open !42', 'Open group/sub/project!7', 'Copy SHA', 'Copy message', 'Forge link', 'Compare with working tree']);
    await expect(menu.getByRole('menuitem', { name: 'Open #12' })).toHaveCount(0);
  });

  test("Forge link on a plain commit: no known branch, so the label copies the permalink and ⎇ is disabled", async ({ page }) => {
    const menu = await commitMenu(page, 'Rename guide and update assets');
    const forge = action(menu, 'Forge link');
    const sha = await row(page, 'Rename guide and update assets').getByTestId('sha').textContent();
    await variant(forge, "Copy the branch's link").hover();
    await expect(page.getByRole('tooltip')).toHaveText("Right-click a branch label for its page");
    await forge.click();
    await copied(page, `https://gitlab.example.com/group/project/-/commit/${sha}`);
  });
});

test.describe('the Monaco context menu', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(openUrl(fixtures.details));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
  });

  test("replaces Monaco's own once a diff is open, and offers Copy, Copy location, Forge link and Open in", async ({ page }) => {
    await row(page, 'Rename guide and update assets').click();
    await page.getByRole('listbox', { name: 'Changed files' }).getByRole('option').and(page.locator('[data-path="src/app.php"]')).click();
    const d = page.getByRole('region', { name: 'Diff' });
    await expect(d.locator('.editor.modified .line-insert').first()).toBeVisible({ timeout: 15_000 });
    // "Suit: string" is only in the new line (php_source's v2); "enum Suit" alone also matches
    // the deleted-line decoration Monaco draws inline for the old one.
    const line = d.locator('.editor.modified .view-line').filter({ hasText: 'Suit: string' });
    await line.click({ button: 'right' });
    const menu = page.getByTestId('context-menu');
    await expect(menu).toBeVisible();
    // Monaco's own menu (on by default, plan 1B deviation 1) is gone.
    await expect(page.locator('.context-view .monaco-menu')).toHaveCount(0);
    await expect(rowLabels(menu)).resolves.toEqual(['Copy', 'Copy location', 'Forge link', 'Open in']);
    await expect(action(menu, 'Copy')).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    // The editor, not the file, has focus and closes on its own Escape path (the file stays open).
    await expect(d).toBeVisible();
  });

  test('a selection makes Copy and Copy location active, and copies it', async ({ page }) => {
    await row(page, 'Rename guide and update assets').click();
    await page.getByRole('listbox', { name: 'Changed files' }).getByRole('option').and(page.locator('[data-path="src/app.php"]')).click();
    const d = page.getByRole('region', { name: 'Diff' });
    await expect(d.locator('.editor.modified .line-insert').first()).toBeVisible({ timeout: 15_000 });
    const line = d.locator('.editor.modified .view-line').filter({ hasText: 'Suit: string' }).getByText('Suit', { exact: true });
    await line.dblclick();
    await line.click({ button: 'right' });
    const menu = page.getByTestId('context-menu');
    await expect(menu).toBeVisible();
    await action(menu, 'Copy').click();
    await copied(page, 'Suit');
  });

  test('a multi-line selection: Copy location shows and copies the range, its Abs variant the absolute path (fix round 1, item 7)', async ({ page }) => {
    await row(page, 'Rename guide and update assets').click();
    await page.getByRole('listbox', { name: 'Changed files' }).getByRole('option').and(page.locator('[data-path="src/app.php"]')).click();
    const d = page.getByRole('region', { name: 'Diff' });
    await expect(d.locator('.editor.modified .line-insert').first()).toBeVisible({ timeout: 15_000 });
    // php_source's v2 (fixtures.rs): line 5 is "enum Suit: string …"; two lines down is line 7
    // ("#[Attribute]"), giving a 5-7 range.
    const line = d.locator('.editor.modified .view-line').filter({ hasText: 'Suit: string' });
    await line.click();
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await line.click({ button: 'right' });
    const menu = page.getByTestId('context-menu');
    await expect(menu).toBeVisible();
    const loc = action(menu, 'Copy location');
    const rel = loc.getByRole('button').first();
    await expect(rel).toHaveText('src/app.php:5-7');
    await rel.click();
    await copied(page, 'src/app.php:5-7');

    await line.click({ button: 'right' });
    await variant(action(menu, 'Copy location'), /absolute path/).click();
    await copied(page, `${fixtures.details}/src/app.php:5-7`);
  });
});

test.describe("the diff header's Open in dropdown (Amendment 11: the shared menu system)", () => {
  test('opens as the shared context menu, not a bespoke popup', async ({ page }) => {
    await page.goto(openUrl(fixtures.details));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    await row(page, 'Rename guide and update assets').click();
    await page.getByRole('listbox', { name: 'Changed files' }).getByRole('option').and(page.locator('[data-path="src/app.php"]')).click();
    const toggle = page.getByRole('button', { name: 'More ways to open' });
    await toggle.click();
    const menu = page.getByTestId('context-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).not.toHaveCount(0);
    // Focus restoration on Escape/Tab/a pick is the shared `ContextMenu`'s own behaviour, already
    // covered unit-side (OpenInMenu.test.tsx); here it's enough that this *is* that menu.
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });
});
