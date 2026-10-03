import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { freshFixture, git, openUrl } from './fixtures';
import { confirmArmed, expect, test, type Locator, type Page } from './test';
import { fileRow, section } from './wip';

/** HEAD is feature/c; feature/a → b → c are stacked on main, which moved on (plan 3C T1). */
async function openEditor(page: Page): Promise<string> {
  const repo = freshFixture('irebase');
  await page.goto(openUrl(repo));
  await page.getByRole('grid', { name: 'Commit graph' }).getByText('main', { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Interactive rebase feature/c onto main' }).click();
  await expect(page.getByTestId('irebase')).toBeVisible();
  return repo;
}
const row = (page: Page, subject: string) => page.getByTestId('irebase').locator('[data-irebase-row]', { hasText: subject });
/** A control a real click at its centre reaches (not clipped, nothing over it). */
const reachable = (el: Locator) => el.evaluate((b) => {
  const r = b.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!hit && b.contains(hit);
});
const start = (page: Page) => page.getByTestId('irebase').getByRole('button', { name: 'Start Rebase' }).click();

test.describe('interactive rebase (spec #3 §7)', () => {
  test('flow 1: reorder, squash and Start', async ({ page }) => {
    const repo = await openEditor(page);
    await expect(page.getByTestId('irebase').getByRole('note')).toHaveText(/1 merge commit will be flattened into a straight line/);
    await row(page, 'C2 Polish').click();
    await page.keyboard.press('Control+ArrowDown');
    await row(page, 'A3 Add tests').click();
    await page.keyboard.press('s');
    await expect(row(page, 'A3 Add tests')).toHaveClass(/is-folded/);
    await start(page);
    await expect(page.getByTestId('irebase')).toBeHidden();
    await expect.poll(() => git(repo, 'log', '-1', '--format=%s', 'feature/c')).toBe('C1 Edit notes again');
    expect(git(repo, 'log', '-1', '--format=%B', 'feature/a')).toBe('A2 Edit notes\n\nA3 Add tests');
    expect(git(repo, 'rev-list', '--merges', 'main..feature/c')).toBe('');
  });

  // UX L: GitBolt's Edit stop is "about to commit": the commit's changes staged, its message in the
  // box. Splitting it is unstage some, Commit, commit the rest, Continue.
  test('flow 2: an Edit stop is about to commit: unstage part, Commit, commit the rest, Continue', async ({ page }) => {
    const repo = await openEditor(page);
    await row(page, 'B2 Refine lexer').click();
    await page.keyboard.press('e');
    await start(page);
    // The stop selects the WIP by itself and opens no file (H.1).
    await expect(page.getByTestId('wip-header')).toBeVisible({ timeout: 15_000 });
    const box = page.getByTestId('commit-box');
    await expect(box.getByRole('region', { name: 'Rebase in progress' })).toContainText(/Editing [0-9a-f]{7} B2 Refine lexer: its changes are staged\. Change them, commit in pieces, or just Continue\./);
    const summary = box.getByRole('textbox', { name: 'Commit summary' });
    await expect(summary).toHaveValue('B2 Refine lexer');
    await expect(fileRow(page, 'staged', 'lexer.txt')).toBeVisible();
    await expect(fileRow(page, 'staged', 'lexer_test.txt')).toBeVisible();
    await expect(section(page, 'staged').locator('.file-row[aria-selected="true"]')).toHaveCount(0);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('S1 Side work');
    // The first piece: lexer.txt alone. Each step waits for what the user would see, not for git:
    // the button commits what the panel shows at the click, and a commit clears the box when its
    // write returns, which is after git has the commit.
    await fileRow(page, 'staged', 'lexer_test.txt').hover();
    await page.getByRole('button', { name: 'Unstage lexer_test.txt' }).click();
    await expect(fileRow(page, 'unstaged', 'lexer_test.txt')).toBeVisible();
    await expect(box.locator('.commit-button')).toHaveText('Commit changes to 1 file');
    const idle = async () => {
      await expect(box.locator('.commit-button')).toHaveAttribute('aria-busy', 'false');
      await expect(summary).toHaveValue('');
    };
    await summary.fill('Lexer');
    await box.locator('.commit-button').click();
    await expect.poll(() => git(repo, 'log', '-1', '--format=%s')).toBe('Lexer');
    await idle();
    // The rest is unstaged: Continue waits for it.
    await expect(box.getByRole('button', { name: 'Continue rebase' })).toHaveAttribute('aria-disabled', 'true');
    await summary.fill('Lexer tests');
    await expect(box.locator('.commit-button')).toHaveText('Stage all & commit');
    await box.locator('.commit-button').click();
    await expect.poll(() => git(repo, 'log', '-1', '--format=%s')).toBe('Lexer tests');
    await idle();
    await box.getByRole('button', { name: 'Continue rebase' }).click();
    await expect.poll(() => git(repo, 'log', '-1', '--format=%s', 'feature/b')).toBe('Lexer tests');
    expect(git(repo, 'log', '--format=%s', 'main..feature/c')).not.toContain('B2 Refine lexer');
    // One Undo restores the original history (spec #3 §3.4), once the app has the rebase done:
    // git moves the branches before the write returns, and until it has, Undo is blocked ("Finish
    // or abort the rebase first") or names an older entry.
    const undo = page.getByRole('toolbar', { name: 'Repository toolbar' }).getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeEnabled();
    await undo.hover();
    await expect(page.getByRole('tooltip')).toContainText('Undo interactive rebase feature/c onto main');
    const tip = git(repo, 'rev-parse', 'feature/c');
    await page.keyboard.press('Control+z');
    await expect.poll(() => git(repo, 'log', '--format=%s', '-3', 'feature/c')).toContain('B2 Refine lexer');
    expect(git(repo, 'rev-parse', 'feature/c')).not.toBe(tip);
  });

  test('flow 2b: a plain Edit, then Continue, keeps the commit as it was but for its committer (UX L)', async ({ page }) => {
    const repo = await openEditor(page);
    const written = () => git(repo, 'show', '--format=%an <%ae> %ad%n%B', '--date=raw', 'feature/b');
    const before = written();
    await row(page, 'B2 Refine lexer').click();
    await page.keyboard.press('e');
    await start(page);
    const box = page.getByTestId('commit-box');
    await expect(box.getByRole('region', { name: 'Rebase in progress' })).toContainText('its changes are staged');
    await expect(box.getByRole('textbox', { name: 'Commit summary' })).toHaveValue('B2 Refine lexer');
    await expect(fileRow(page, 'staged', 'lexer.txt')).toBeVisible();
    await box.getByRole('button', { name: 'Continue rebase' }).click();
    await expect.poll(() => existsSync(join(repo, '.git', 'rebase-merge'))).toBe(false);
    expect(written()).toBe(before);
    expect(git(repo, 'merge-base', 'main', 'feature/c')).toBe(git(repo, 'rev-parse', 'main'));
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  test('flow 3: a stack chip dragged down a row moves its branch', async ({ page }) => {
    const repo = await openEditor(page);
    const b = git(repo, 'log', '-1', '--format=%s', 'feature/b');
    // Pointer events only (UX R1.1): the packaged app's CEF delivers no HTML5 drag events.
    await page.evaluate(() => { (window as unknown as { dragStarts: number }).dragStarts = 0; window.addEventListener('dragstart', () => { (window as unknown as { dragStarts: number }).dragStarts++; }, true); });
    const from = (await row(page, 'A3 Add tests').locator('.irebase-chip', { hasText: 'feature/a' }).boundingBox())!;
    const to = (await row(page, 'A2 Edit notes').locator('.irebase-summary').boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 8, { steps: 2 });
    await page.mouse.move(to.x + 20, to.y + to.height / 2, { steps: 5 });
    await expect(row(page, 'A2 Edit notes')).toHaveClass(/chip-over/);
    await page.mouse.up();
    await expect(row(page, 'A2 Edit notes').locator('.irebase-chip', { hasText: 'feature/a' })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { dragStarts: number }).dragStarts)).toBe(0);
    await start(page);
    await expect.poll(() => git(repo, 'log', '-1', '--format=%s', 'feature/a')).toBe('A2 Edit notes');
    expect(git(repo, 'merge-base', '--is-ancestor', 'main', 'feature/a') === '').toBe(true);
    expect(git(repo, 'log', '-1', '--format=%s', 'feature/b')).toBe(b);
  });

  test('a selection dragged as a group lands together, in its order, closed up (UX2 E.3)', async ({ page }) => {
    const repo = await openEditor(page);
    await page.evaluate(() => { (window as unknown as { dragStarts: number }).dragStarts = 0; window.addEventListener('dragstart', () => { (window as unknown as { dragStarts: number }).dragStarts++; }, true); });
    const order = () => page.getByTestId('irebase').locator('[data-irebase-row] .irebase-summary').allTextContents();
    const before = await order();
    expect(before.slice(0, 3)).toEqual(['C2 Polish', 'C1 Edit notes again', 'B2 Refine lexer']);
    // C2 and B2: a scattered selection (C1 between).
    await row(page, 'C2 Polish').click();
    await row(page, 'B2 Refine lexer').click({ modifiers: ['ControlOrMeta'] });
    const c2 = (await row(page, 'C2 Polish').boundingBox())!;
    const a3 = (await row(page, 'A3 Add tests').boundingBox())!;
    // The block's top at A2's place among the others: right below A3.
    const dy = a3.y + a3.height - c2.y - c2.height - (await row(page, 'B2 Refine lexer').boundingBox())!.height;
    const x = c2.x + c2.width / 2;
    const y = c2.y + c2.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 8, { steps: 2 });
    await page.mouse.move(x, y + dy, { steps: 8 });
    await expect(row(page, 'C2 Polish').locator('.irebase-drag-count')).toHaveText('2 commits');
    await page.mouse.up();
    await expect(page.locator('.irebase-drag-count')).toHaveCount(0);
    const rest = before.filter((s) => s !== 'C2 Polish' && s !== 'B2 Refine lexer');
    const at = rest.indexOf('A3 Add tests') + 1;
    const want = [...rest.slice(0, at), 'C2 Polish', 'B2 Refine lexer', ...rest.slice(at)];
    await expect.poll(order).toEqual(want);
    expect(await page.evaluate(() => (window as unknown as { dragStarts: number }).dragStarts)).toBe(0);
    // One Undo puts the whole group back.
    await page.keyboard.press('Control+z');
    await expect.poll(order).toEqual(before);
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(order).toEqual(want);
    await start(page);
    await expect(page.getByTestId('irebase')).toBeHidden();
    await expect.poll(() => git(repo, 'log', '--format=%s', 'main..feature/c').split('\n').filter((s) => !s.startsWith('Merge'))).toEqual(want);
  });

  test('a chip\'s hover shows its full name in place, shifting nothing; chips that don\'t fit go behind +N (UX2 E.1, E.2)', async ({ page }) => {
    await openEditor(page);
    const a3 = row(page, 'A3 Add tests');
    const add = async (name: string) => {
      await a3.hover();
      await a3.getByRole('button', { name: 'Add a branch here' }).click();
      await page.getByRole('textbox', { name: 'New branch name' }).fill(name);
      await page.keyboard.press('Enter');
    };
    await add('feature/a-with-a-long-name');
    const long = a3.locator('.irebase-chip-wrap[data-branch="feature/a-with-a-long-name"]');
    const name = long.locator('.irebase-chip');
    const full = long.locator('.irebase-chip-expand');
    // Truncated in the column; its name hovered, the full name over its neighbours.
    expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await page.mouse.move(0, 0);
    await expect(full).toBeHidden();
    const cells = () => a3.evaluate((r) => [r.getBoundingClientRect().height, ...[...r.children].filter((c) => !c.classList.contains('irebase-drag-count')).map((c) => { const b = c.getBoundingClientRect(); return `${b.x},${b.y},${b.width}`; })]);
    const chipBox = () => name.evaluate((el) => { const b = el.getBoundingClientRect(); return [b.x, b.width]; });
    const was = await cells();
    const chipWas = await chipBox();
    await name.hover();
    await expect(full).toBeVisible();
    await expect(full).toHaveText('feature/a-with-a-long-name');
    expect(await full.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(chipWas[1]);
    expect(await full.evaluate((el) => Math.round(el.getBoundingClientRect().x))).toBe(Math.round(chipWas[0]));
    expect(await cells()).toEqual(was);
    expect(await chipBox()).toEqual(chipWas);
    // The tooltip keeps the hint.
    await expect(page.getByRole('tooltip')).toHaveText('Drag it to another commit to move it');
    await page.mouse.move(0, 0);
    await expect(full).toBeHidden();
    // Its own × is the chip's (an added chip: × drops it).
    await name.hover();
    await full.locator('.irebase-chip-full-x').click();
    await expect(long).toHaveCount(0);
    await add('feature/a-with-a-long-name');
    // Four chips: the ones that don't fit at a readable width go behind +N.
    await add('stack/one');
    await add('stack/two');
    const shown = a3.locator('.irebase-chip-list > .irebase-chip-wrap');
    await expect(shown).toHaveCount(2);
    for (const el of await shown.locator('.irebase-chip').all()) expect(await el.evaluate((e) => e.getBoundingClientRect().width)).toBeGreaterThanOrEqual(40);
    const more = a3.getByRole('button', { name: '2 more: stack/one, stack/two' });
    await expect(more).toHaveText('+2');
    await more.hover();
    const all = a3.locator('.irebase-chips-all');
    await expect(all).toBeVisible();
    await expect(all.locator('.irebase-chip-full-name')).toHaveText(['feature/a', 'feature/a-with-a-long-name', 'stack/one', 'stack/two']);
    // From the list: a hidden chip's × is reachable and its own.
    const two = all.locator('[data-branch="stack/two"]');
    await two.locator('.irebase-chip-full-x').click();
    await expect(a3.getByRole('button', { name: '1 more: stack/one' })).toBeVisible();
    // The pill's click: each hidden chip's menu.
    await a3.getByRole('button', { name: '1 more: stack/one' }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'stack/one' }).click();
    await page.getByRole('menuitem', { name: 'Delete branch' }).click();
    await confirmArmed(page.getByRole('menuitem', { name: /^Click again to drop stack\/one/ }));
    await expect(a3.locator('.irebase-chip-more')).toHaveCount(0);
    await expect(shown).toHaveCount(2);
  });

  test('chips sharing a row: each × is reachable and its own; the chip menu deletes (armed) and restores (UX R1.3, R1.5)', async ({ page }) => {
    await openEditor(page);
    const a3 = row(page, 'A3 Add tests');
    const x = (name: string) => a3.locator(`.irebase-chip-wrap[data-branch="${name}"] .irebase-chip-x`);
    const deleted = (name: string) => a3.locator(`.irebase-chip-wrap[data-branch="${name}"]`);
    // Two chips on a row, one with a long name.
    await a3.hover();
    await a3.getByRole('button', { name: 'Add a branch here' }).click();
    await page.getByRole('textbox', { name: 'New branch name' }).fill('feature/a-with-a-long-name');
    await page.keyboard.press('Enter');
    await a3.hover();
    for (const name of ['feature/a', 'feature/a-with-a-long-name']) expect(await reachable(x(name)), name).toBe(true);
    await x('feature/a').click();
    await expect(deleted('feature/a')).toHaveClass(/is-deleted/);
    await x('feature/a-with-a-long-name').click();
    await expect(deleted('feature/a-with-a-long-name')).toHaveCount(0);
    await x('feature/a').click();
    // A deleted chip folded onto another's row (its rows squashed into it): both still reachable.
    await row(page, 'B2 Refine lexer').hover();
    await row(page, 'B2 Refine lexer').getByRole('button', { name: 'Delete feature/b when the rebase completes' }).click();
    for (const s of ['B2 Refine lexer', 'S1 Side work', 'B1 Add lexer']) {
      await row(page, s).click();
      await page.keyboard.press('s');
    }
    await expect(deleted('feature/b')).toHaveClass(/is-deleted/);
    await a3.hover();
    for (const name of ['feature/a', 'feature/b']) expect(await reachable(x(name)), name).toBe(true);
    await x('feature/b').click();
    await expect(deleted('feature/b')).not.toHaveClass(/is-deleted/);
    await x('feature/a').click();
    await expect(deleted('feature/a')).toHaveClass(/is-deleted/);
    await expect(deleted('feature/b')).not.toHaveClass(/is-deleted/);
    // The chip menu: Delete branch arms in place; Restore.
    await deleted('feature/b').locator('.irebase-chip').click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: 'Delete branch' }).click();
    await confirmArmed(page.getByRole('menu').getByRole('menuitem', { name: /^Click again to delete feature\/b/ }));
    await expect(deleted('feature/b')).toHaveClass(/is-deleted/);
    await deleted('feature/b').locator('.irebase-chip').click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: 'Restore' }).click();
    await expect(deleted('feature/b')).not.toHaveClass(/is-deleted/);
  });

  // UX F (P0): the playground repos inherited `commit.gpgsign=true`. A signer that fails (here a
  // stand-in, in the fixture's own config) stops the rebase at its first pick: the stop says why,
  // a Continue while it still fails says it again, and once signing is off Continue goes on to
  // the Edit stop and then finishes.
  test('flow 4: a failing signer: the stop says why; signing off, Continue reaches the Edit stop and finishes', async ({ page }) => {
    const repo = await openEditor(page);
    const signer = join(dirname(repo), 'failing-gpg');
    const calls = join(dirname(repo), 'gpg-calls');
    writeFileSync(signer, `#!/bin/sh\ncat >/dev/null\necho x >> '${calls}'\necho 'gpg: signing failed: No pinentry' >&2\nexit 2\n`);
    const signed = () => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').length - 1 : 0);
    chmodSync(signer, 0o755);
    git(repo, 'config', 'commit.gpgsign', 'true');
    git(repo, 'config', 'gpg.program', signer);
    const tip = git(repo, 'rev-parse', 'feature/c');
    await row(page, 'B2 Refine lexer').click();
    await page.keyboard.press('e');
    await start(page);
    const why = 'The rebase stopped: gpg failed to sign the data: gpg: signing failed: No pinentry';
    await expect(page.getByText(why)).toBeVisible();
    // The stop selects the WIP (its commit box) by itself.
    const box = page.getByTestId('commit-box');
    const cont = box.locator('.commit-button');
    await expect(cont).toHaveText('Continue rebase');
    // Still failing: the stop stands (the core tests pin that it says why again).
    const head = git(repo, 'rev-parse', 'HEAD');
    const before = signed();
    await cont.click();
    await expect.poll(signed).toBeGreaterThan(before);
    await expect(cont).not.toHaveAttribute('aria-busy', 'true');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(existsSync(join(repo, '.git', 'rebase-merge'))).toBe(true);
    git(repo, 'config', 'commit.gpgsign', 'false');
    await cont.click();
    // UX L: the Edit stop is "about to commit" (HEAD on B2's parent, its changes staged); the box
    // commits there, and Continue is under it.
    await expect(box.getByRole('region', { name: 'Rebase in progress' })).toContainText('its changes are staged');
    await expect.poll(() => git(repo, 'log', '-1', '--format=%s')).toBe('S1 Side work');
    await box.getByRole('button', { name: 'Continue rebase' }).click();
    await expect.poll(() => git(repo, 'rev-parse', 'feature/c')).not.toBe(tip);
    expect(existsSync(join(repo, '.git', 'rebase-merge'))).toBe(false);
    expect(git(repo, 'log', '-1', '--format=%s', 'feature/c')).toBe('C2 Polish');
    expect(git(repo, 'merge-base', 'main', 'feature/c')).toBe(git(repo, 'rev-parse', 'main'));
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});
