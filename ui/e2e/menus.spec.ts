import { expect, test, type Locator, type Page } from './test';
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

  // Each `test.step` below was a test of its own, paying for a page load; each closes its menu.
  test('the WIP row, a plain commit, a branch label chip and a tag label chip each get their own menu', async ({ page }) => {
    await test.step('the WIP row gets its own menu, not the commit menu', async () => {
      // Two worktrees are dirty (the main one and wt-hotfix, fixtures.rs); the first WIP row is the
      // active one's. Spec #2 §14: a WIP row's menu is Switch to this worktree and Open in a new tab
      // (2C), neither on the active one's, then Stash; none of the commit menu's rows.
      await page.getByRole('row').filter({ hasText: '// WIP' }).first().locator('[data-col="message"]').click({ button: 'right' });
      const menu = page.getByTestId('context-menu');
      await expect(menu).toBeVisible();
      const labels = await rowLabels(menu);
      expect(labels).not.toContain('Open in a new tab');
      expect(labels).toContain('Stash changes');
      expect(labels).not.toContain('Copy SHA');
      expect(labels).not.toContain('Checkout');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('context-menu')).toBeHidden();
    });
    await test.step('a plain commit: Reset early, the 2C Branch rows, then Copy SHA, Copy message, Compare with working tree; no forge rows; under budget', async () => {
      const menu = await commitMenu(page, 'Fix typo');
      // Spec #2 §14: 2C's Commit-group Reset row (placed early, right after the sync rows) and its
      // Branch group (Checkout ▸, Create worktree from ▸, Create branch here) sit above 1C's rows.
      // Spec #3 §4.3: the Commit group gains Revert, Create tag here and Interactive rebase after this commit
      // (no Cherry-pick: Fix typo is already on main).
      await expect(menu.locator('[data-depth="0"] > [role="menuitem"] .ctx-label')).toHaveText(['Reset main to this commit', 'Checkout', 'Create worktree from', 'Create branch here', 'Revert this commit', 'Create tag here', 'Interactive rebase after this commit', 'Copy SHA', 'Copy message', 'Compare with working tree']);
      // The latency budgets (cold tripwire, warm median) live in menu-perf.spec.ts, so a loaded
      // machine can't fail this functional test. Here: the opening was timed, and wasn't absurd.
      const opened = await page.evaluate(() => window.__gbMenuLatency!);
      expect(opened).toBeGreaterThanOrEqual(0);
      expect(opened).toBeLessThan(2000);
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();

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
    await test.step("a branch label chip: Copy branch name (Local, Remote), Compare with HEAD names both branches; main's own chip compares with the working tree; a local-only branch has no Remote", async () => {
      const menu = await labelMenu(page, 'Login validation');
      // Spec #2 §14: 2D's Sync and Integrate groups, 2C's Reset, Branch and Manage rows, then 1C's.
      // UX round 1: only what can apply. feature/login is merged into main (behind it): only the
      // fast-forward, no merge or rebase; nothing to push. Spec #3 §4.3: the interactive rebase
      // still applies (main's commits above feature/login), and the Commit group gains Revert,
      // Create tag here and Interactive rebase after this commit (no Cherry-pick: it's on main).
      const expected = [
        'Pull', 'Set upstream', 'Reset main to this commit',
        'Fast-forward feature/login to main', 'Interactive rebase main onto feature/login',
        'Checkout', 'Create worktree from', 'Create branch here',
        'Revert this commit', 'Create tag here', 'Interactive rebase after this commit',
        'Rename feature/login', 'Delete',
        'Copy branch name', 'Copy SHA', 'Copy message', 'Compare with HEAD',
      ];
      await expect(rowLabels(menu)).resolves.toEqual(expected);
      await page.keyboard.press('Escape');
      // The commit row's own menu is its primary chip's.
      const rowMenu = await commitMenu(page, 'Login validation');
      await expect(rowLabels(rowMenu)).resolves.toEqual(expected);
      await page.keyboard.press('Escape');
      await labelMenu(page, 'Login validation');
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

      // main's own chip, on its tip commit: no Compare with HEAD (already there), Compare with
      // working tree instead.
      const labels = await rowLabels(await labelMenu(page, "Merge branch 'feature/login'"));
      expect(labels).not.toContain('Compare with HEAD');
      expect(labels).toContain('Compare with working tree');
      await page.keyboard.press('Escape');

      // A local-only branch: Copy branch name has no Remote.
      const branchRow = action(await labelMenu(page, 'Hotfix: null check'), 'Copy branch name');
      await expect(variant(branchRow, 'Copy the local branch name')).toBeVisible();
      await expect(branchRow.getByRole('button', { name: /^Copy "/ })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('context-menu')).toBeHidden();
    });
    await test.step('a tag label chip: Push (v1.0 is local only), Delete, Copy tag name; no forge on a generic remote', async () => {
      const menu = await labelMenu(page, 'Add readme');
      // Spec #3 §3.9: a tag's menu gains Push <t> to <remote> and Delete.
      await expect(rowLabels(menu)).resolves.toEqual(['Push v1.0 to origin', 'Delete', 'Copy tag name']);
      await action(menu, 'Copy tag name').click();
      await copied(page, 'v1.0');
    });
  });
});

test.describe('forge rows (a GitLab remote, fixtures.details) and the Monaco context menu', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(openUrl(fixtures.details));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
  });

  // One page for both (each was a test of its own, paying for a page load).
  test("a commit's forge rows; the Monaco context menu replaces Monaco's own, with Copy, Copy location, Forge link and Open in", async ({ page }) => {
    await test.step("MR references in the message get one Open row each, the issue reference none; Forge link on a plain commit: no known branch, so the label copies the permalink and there's no ⎇", async () => {
      const menu = await commitMenu(page, 'Rename guide and update assets');
      // Spec #3 §4.3's Commit group (Revert, Create tag here, Interactive rebase after this commit) sits above the Forge rows.
      await expect(rowLabels(menu)).resolves.toEqual(['Reset main to this commit', 'Checkout', 'Create worktree from', 'Create branch here', 'Revert this commit', 'Create tag here', 'Interactive rebase after this commit', 'Open !42', 'Open group/sub/project!7', 'Copy SHA', 'Copy message', 'Forge link', 'Compare with working tree']);
      await expect(menu.getByRole('menuitem', { name: 'Open #12' })).toHaveCount(0);
      const forge = action(menu, 'Forge link');
      const sha = await row(page, 'Rename guide and update assets').getByTestId('sha').textContent();
      await expect(forge.getByRole('button', { name: "Copy the branch's link" })).toHaveCount(0);
      await forge.click();
      await copied(page, `https://gitlab.example.com/group/project/-/commit/${sha}`);
    });
    await test.step("replaces Monaco's own once a diff is open, and offers Copy, Copy location, Forge link and Open in; a selection makes Copy and Copy location active; a multi-line selection's location is its range (fix round 1, item 7)", async () => {
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

      // A selection makes Copy and Copy location active, and Copy copies it.
      const word = line.getByText('Suit', { exact: true });
      await word.dblclick();
      await word.click({ button: 'right' });
      await expect(menu).toBeVisible();
      await action(menu, 'Copy').click();
      await copied(page, 'Suit');

      // A multi-line selection: php_source's v2 (fixtures.rs): line 5 is "enum Suit: string …";
      // two lines down is line 7 ("#[Attribute]"), giving a 5-7 range. Copy location shows and
      // copies it; its Abs variant the absolute path.
      await line.click();
      await page.keyboard.press('Shift+ArrowDown');
      await page.keyboard.press('Shift+ArrowDown');
      await line.click({ button: 'right' });
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
});
