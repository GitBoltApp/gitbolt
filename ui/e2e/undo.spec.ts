import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshFixture, git, openUrl, testWrite } from './fixtures';
import { expect, test, type Page, confirmArmed, armedOverlay } from './test';
import { fileRow, selectWip, timedClick } from './wip';

const undoButton = (page: Page) => page.getByRole('toolbar', { name: 'Repository toolbar' }).getByRole('button', { name: 'Undo', exact: true });
const graph = (page: Page) => page.getByRole('grid', { name: 'Commit graph' });
const commit = (message: string) => ({ op: 'commit' as const, message, allowEmpty: true });

async function open(page: Page, repo: string) {
  await page.goto(openUrl(repo));
  await expect(graph(page)).toBeVisible();
}

test.describe('undo of a real commit (spec #2 §5.3, 2B)', () => {
  test('the toolbar undoes a commit from the commit box; its changes come back staged (< 150 ms)', { tag: '@budget' }, async ({ page }) => {
    const repo = freshFixture('wip_staging');
    await open(page, repo);
    await selectWip(page);
    await page.getByTestId('commit-box').getByRole('textbox', { name: 'Commit summary' }).fill('To undo');
    await page.getByTestId('commit-box').getByRole('textbox', { name: 'Commit summary' }).press('Control+Enter');
    await expect(graph(page).getByText('To undo')).toBeVisible();
    await expect(undoButton(page)).not.toHaveAttribute('aria-disabled', 'true');
    const ms = await timedClick(page, undoButton(page), { sel: '[role="grid"] [role="row"]', text: 'To undo', gone: true });
    await expect(graph(page).getByText('To undo')).toHaveCount(0);
    expect(ms, 'undo of a commit').toBeLessThan(150);
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('notes.txt');
  });
});

test.describe('undo (spec #2 §5.5)', () => {
  test('the toolbar undoes and redoes a commit; the toast offers Redo', async ({ page, request }) => {
    const repo = freshFixture('basic');
    await open(page, repo);
    await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
    await undoButton(page).hover();
    await expect(page.getByRole('tooltip')).toHaveText('Nothing to undo');
    expect((await testWrite(request, repo, commit('From the test'))).ok).toBeDefined();
    await expect(graph(page).getByText('From the test')).toBeVisible();
    await undoButton(page).hover();
    await expect(page.getByRole('tooltip')).toHaveText('Undo commit "From the test" (Ctrl+Z)');
    await undoButton(page).click();
    await expect(page.getByRole('status').filter({ hasText: 'Undid commit "From the test"' })).toBeVisible();
    await expect(graph(page).getByText('From the test')).toHaveCount(0);
    await page.getByRole('status').getByRole('button', { name: 'Redo' }).click();
    await expect(graph(page).getByText('From the test')).toBeVisible();
  });

  test('Ctrl+Z undoes outside text fields, and leaves a text box its own undo', async ({ page, request }) => {
    const repo = freshFixture('basic');
    await open(page, repo);
    await testWrite(request, repo, commit('Keyboard undo'));
    await expect(graph(page).getByText('Keyboard undo')).toBeVisible();
    await page.keyboard.press('Control+f');
    await page.keyboard.type('x');
    await page.keyboard.press('Control+z');
    await expect(graph(page).getByText('Keyboard undo')).toBeVisible();
    await page.keyboard.press('Escape');
    await graph(page).focus();
    await page.keyboard.press('Control+z');
    await expect(graph(page).getByText('Keyboard undo')).toHaveCount(0);
  });

  test('a push is a barrier: Undo says why; a newer entry is still undoable', async ({ page, request }) => {
    const repo = freshFixture('basic');
    await open(page, repo);
    await testWrite(request, repo, { op: 'barrier', label: 'push main to origin/main' });
    await undoButton(page).hover();
    await expect(page.getByRole('tooltip')).toHaveText("Push can't be undone");
    await testWrite(request, repo, commit('After the push'));
    // Enabled: no aria-disabled at all (the button sets it only when off).
    await expect(undoButton(page)).not.toHaveAttribute('aria-disabled', 'true');
    await undoButton(page).click();
    await expect(graph(page).getByText('After the push')).toHaveCount(0);
    // The pointer is still on the button after the click: leave and come back for a fresh hover.
    await page.mouse.move(0, 0);
    await undoButton(page).hover();
    await expect(page.getByRole('tooltip')).toHaveText("Push can't be undone");
  });

  test('undo of a commit lands within its budget (< 150 ms, best of 3, spec #2 §16)', { tag: '@budget' }, async ({ page, request }) => {
    const repo = freshFixture('basic');
    await open(page, repo);
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const message = `Budget ${i}`;
      await testWrite(request, repo, commit(message));
      await expect(graph(page).getByText(message)).toBeVisible();
      await expect(page.locator('[role="toolbar"] button[aria-label="Undo"]')).toBeEnabled();
      const ms = await page.evaluate(async (m) => {
        const t0 = performance.now();
        document.querySelector<HTMLButtonElement>('[role="toolbar"] button[aria-label="Undo"]')!.click();
        await new Promise<void>((done) => {
          const tick = () => ([...document.querySelectorAll('[role="grid"] *')].some((n) => n.textContent === m) ? requestAnimationFrame(tick) : done());
          tick();
        });
        return performance.now() - t0;
      }, message);
      times.push(ms);
    }
    console.log(`[budget] undo of a commit: ${times.map((t) => t.toFixed(1)).join(', ')} ms`);
    expect(Math.min(...times)).toBeLessThan(150);
  });

  test('a click while another op runs shows in the chip within a frame (spec #2 §16)', { tag: '@budget' }, async ({ page, request }) => {
    const repo = freshFixture('basic');
    await open(page, repo);
    await testWrite(request, repo, commit('Queued undo'));
    await expect(graph(page).getByText('Queued undo')).toBeVisible();
    const running = testWrite(request, repo, { op: 'sleep', label: 'push dev', ms: 1500, fail: false });
    await expect(page.locator('.status-bar .sb-queue')).toHaveText('Running: push dev');
    // The journal state may land after the commit: click only once Undo is live (T14 review).
    await expect(page.locator('[role="toolbar"] button[aria-label="Undo"]')).toBeEnabled();
    const ms = await page.evaluate(async () => {
      const t0 = performance.now();
      document.querySelector<HTMLButtonElement>('[role="toolbar"] button[aria-label="Undo"]')!.click();
      await new Promise<void>((done) => {
        const tick = () => (document.querySelector('.status-bar .sb-queue')?.textContent?.includes('1 queued') ? done() : requestAnimationFrame(tick));
        tick();
      });
      return performance.now() - t0;
    });
    console.log(`[budget] queued click to chip: ${ms.toFixed(1)} ms`);
    // One frame after the queueChanged event; the harness round trip is a few ms (Deviation 13).
    expect(ms).toBeLessThan(50);
    await running;
  });

  test('a restore that conflicts keeps the stash and shows the banner; × keeps the stash', async ({ page, request }) => {
    const repo = freshFixture('basic');
    git(repo, 'stash', 'push', '-q', '-m', 'park');
    git(repo, 'switch', '-q', '-c', 'side');
    writeFileSync(join(repo, 'file_1.txt'), 'side change\n');
    git(repo, 'commit', '-q', '-am', 'Side edit');
    git(repo, 'switch', '-q', 'main');
    git(repo, 'stash', 'pop', '-q');
    await open(page, repo);
    const res = await testWrite(request, repo, { op: 'switch', branch: 'side', confirm: { autostash: true } });
    expect(res.ok).toBeDefined();
    const notices = page.getByRole('region', { name: 'Notices' });
    await expect(notices).toContainText('Your restored changes conflict in 1 file; resolve them in Conflicted. The stash is kept until you drop it.');
    await notices.getByRole('button', { name: 'Dismiss' }).click();
    await expect(notices).toBeHidden();
    expect(git(repo, 'stash', 'list', '--format=%gs')).toContain('autostash before checkout side');
  });
});

test.describe('undo of a discard (spec #2 §5.3, 2B)', () => {
  test('the toolbar restores a discarded file and a Discard all', async ({ page }) => {
    const repo = freshFixture('wip_staging');
    await open(page, repo);
    const before = git(repo, 'status', '--porcelain');
    await graph(page).getByRole('row').filter({ hasText: '// WIP' }).locator('[data-col="message"]').click({ position: { x: 3, y: 3 } });
    await page.getByTestId('wip-header').getByRole('button', { name: 'Discard all' }).click();
    await confirmArmed(armedOverlay(page, /^Click again to discard/));
    await expect.poll(() => git(repo, 'status', '--porcelain')).toBe('');
    await undoButton(page).hover();
    await expect(page.getByRole('tooltip')).toHaveText('Undo discard all changes (Ctrl+Z)');
    await undoButton(page).click();
    await expect.poll(() => git(repo, 'status', '--porcelain')).toBe(before);
  });
});

// --- UX Y: out-of-order undo from the Undo dropdown ---
test.describe('the Undo dropdown (UX Y)', () => {
  test("Y.3: discard A, edit B, undo the discard from the dropdown: A is back, B stays, Undo is B's", async ({ page, request }) => {
    const repo = freshFixture('wip_staging');
    const a = join(repo, 'space name.txt');
    const b = join(repo, 'notes.txt');
    const aBefore = readFileSync(a, 'utf8');
    const bBefore = readFileSync(b, 'utf8');
    expect((await testWrite(request, repo, { op: 'discard', paths: ['space name.txt'] })).ok).toBeDefined();
    expect(readFileSync(a, 'utf8')).toBe('one\n');
    await open(page, repo);
    await selectWip(page);
    // B: edited in File View and saved (journaled).
    await fileRow(page, 'staged', 'notes.txt').click();
    await page.getByRole('button', { name: 'File View' }).click();
    const view = page.getByTestId('file-view').locator('.view-lines');
    await expect(view).toContainText('note 01', { timeout: 15_000 });
    await view.click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.type('X');
    await page.keyboard.press('Control+s');
    await expect(page.getByLabel('Unsaved changes')).toHaveCount(0);
    await expect.poll(() => readFileSync(b, 'utf8')).toBe(`X${bBefore}`);
    // The ▾ under Undo: the save (Undo's own), then the discard, independent of it.
    await page.getByRole('toolbar', { name: 'Repository toolbar' }).getByRole('button', { name: 'Undo options' }).click();
    const rows = page.locator('.ctx-menu [role="menuitem"]');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('save notes.txt');
    const discardRow = page.getByRole('menuitem', { name: /discard space name\.txt/ });
    await expect(discardRow).not.toHaveAttribute('aria-disabled', 'true');
    await discardRow.click();
    await expect(page.getByRole('status').filter({ hasText: 'Undid discard space name.txt' })).toBeVisible();
    await expect.poll(() => readFileSync(a, 'utf8')).toBe(aBefore);
    expect(readFileSync(b, 'utf8')).toBe(`X${bBefore}`);
    // The normal Undo now undoes B's save.
    await page.mouse.move(0, 0);
    await undoButton(page).hover();
    await expect(page.getByRole('tooltip')).toHaveText('Undo save notes.txt (Ctrl+Z)');
    await undoButton(page).click();
    await expect.poll(() => readFileSync(b, 'utf8')).toBe(bBefore);
    expect(readFileSync(a, 'utf8')).toBe(aBefore);
  });
});
// --- end UX Y ---
