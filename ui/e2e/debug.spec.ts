import { expect, test, type Page } from './test';
import { fixtures, openUrl } from './fixtures';

// Plan 1D lane W2-B (T8, T9 UI, R9-R11): the Activity modal is the one Debug modal, with
// Activity | Commands | Actions tabs and the diagnostics / logs folder / perf overlay header.

const debugDialog = (page: Page) => page.getByRole('dialog', { name: 'Activity' });

async function runFromPalette(page: Page, query: string) {
  await page.keyboard.press('Control+p');
  await page.keyboard.type(`>${query}`);
  // Enter runs the highlighted row: wait until the list has caught up with the query. (Pressed
  // straight after it paints: the highlight is the new list's top row from that frame on.)
  await expect(page.getByRole('dialog', { name: 'Command palette' }).getByRole('option').first()).toContainText(query);
  await page.keyboard.press('Enter');
}

/** How many `commandLog` requests (the Commands tab's load and poll) the backend has answered in
 * this test. Counted from the page's socket, watched from before the page opens it. */
const commandLogReplies = { n: 0 };

test.describe('the Debug modal', () => {
  test.beforeEach(async ({ page }) => {
    commandLogReplies.n = 0;
    const asked = new Set<number>();
    const frame = (payload: string | Buffer) => { try { return JSON.parse(String(payload)) as { id?: number; req?: { method?: string } }; } catch { return {}; } };
    page.on('websocket', (ws) => {
      ws.on('framesent', ({ payload }) => {
        const m = frame(payload);
        if (m.req?.method === 'commandLog' && m.id !== undefined) asked.add(m.id);
      });
      ws.on('framereceived', ({ payload }) => {
        const m = frame(payload);
        if (m.id !== undefined && asked.has(m.id)) commandLogReplies.n++;
      });
    });
    await page.goto(openUrl(fixtures.basic));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
  });

  // One page for these (each was a test of its own, paying for a page load), each closing the
  // modal it opened.
  test('the Debug modal: the Commands tab, filterable; the Actions tab records actions; the header\'s diagnostics, logs folder and perf overlay', async ({ page }) => {
    await test.step('Help → Debug… opens the Commands tab: the git commands that opened the repo, filterable', async () => {
      await runFromPalette(page, 'Debug');
      const dialog = debugDialog(page);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('tab', { name: 'Commands' })).toHaveAttribute('aria-selected', 'true');
      const entries = dialog.locator('li.debug-entry');
      await expect(entries.first()).toContainText('$ git ');
      // Filter by the newest command's own subcommand (its first word that isn't an option).
      const newest = (await entries.first().locator('.activity-cmd').textContent()) ?? '';
      const sub = newest.replace(/^\$ git /, '').split(' ').find((w, i, ws) => !w.startsWith('-') && ws[i - 1] !== '-c')!;
      await dialog.getByRole('searchbox', { name: 'Filter commands' }).fill(sub);
      await expect(entries).not.toHaveCount(0);
      for (const text of await entries.locator('.activity-cmd').allTextContents()) expect(text).toContain(sub);
      // Typed key by key: the modal owns the keys (useModalKeys), and typing in its fields still works.
      await dialog.getByRole('searchbox', { name: 'Filter commands' }).clear();
      await dialog.getByRole('searchbox', { name: 'Filter commands' }).pressSequentially('no-such-command');
      await expect(dialog).toContainText('No command matches');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    });
    await test.step('the Actions tab records palette actions and context-menu rows', async () => {
      await page.getByRole('row').filter({ hasText: 'Fix typo' }).locator('[data-col="message"]').click({ button: 'right' });
      const menu = page.getByTestId('context-menu');
      await menu.locator('.ctx-label').getByText('Copy SHA', { exact: true }).click();
      await expect(menu).toBeHidden();
      await runFromPalette(page, 'Debug');
      const dialog = debugDialog(page);
      await dialog.getByRole('tab', { name: 'Actions' }).click();
      const entries = dialog.locator('li.debug-entry');
      await expect(entries.first()).toContainText('help.debug');
      await expect(entries.filter({ hasText: 'Copy SHA' })).toContainText('menu');
      await page.keyboard.press('Escape');
      await expect(debugDialog(page)).toHaveCount(0);
    });
    await test.step('header: Copy diagnostics copies the report, Open logs directory is off in the harness, the perf overlay toggles', async () => {
      await runFromPalette(page, 'Activity log');
      const dialog = debugDialog(page);
      await expect(dialog.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
      // The filter bar: inline checkboxes, quiet background ops hidden by default.
      await expect(dialog.getByLabel('Errors only')).not.toBeChecked();
      await expect(dialog.getByLabel('Hide background')).toBeChecked();
      await expect(dialog.getByRole('button', { name: 'Open logs directory' })).toBeDisabled();
      await dialog.getByRole('button', { name: 'Copy diagnostics' }).click();
      await expect(page.getByRole('status')).toHaveText('Diagnostics copied');
      if (test.info().project.name === 'chromium') {
        const text = await page.evaluate(() => navigator.clipboard.readText());
        expect(text).toMatch(/^GitBolt /);
        expect(text).toContain('Runtime: harness');
      }
      const perf = dialog.getByRole('button', { name: 'Perf overlay' });
      await perf.click();
      await expect(perf).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.press('Escape');
      const overlay = page.getByRole('region', { name: 'Performance' });
      await expect(overlay).toBeVisible();
      await expect(overlay).toContainText('fps');
      await expect(overlay.locator('tr').first()).toContainText(' ms');
      // The Debug tools' own traffic (the Commands tab's poll, the log file writes) isn't listed:
      // checked once the tab's first load and one interval poll have both been answered.
      const answered = commandLogReplies.n;
      await runFromPalette(page, 'Debug');
      await expect(debugDialog(page).locator('li.debug-entry').first()).toBeVisible();
      await expect.poll(() => commandLogReplies.n, { timeout: 10_000 }).toBeGreaterThanOrEqual(answered + 2);
      for (const m of ['commandLog', 'logFrontend', 'logsDir', 'diagnostics']) await expect(overlay).not.toContainText(m);
      await page.keyboard.press('Escape');
      await runFromPalette(page, 'Activity log');
      await debugDialog(page).getByRole('button', { name: 'Perf overlay' }).click();
      await expect(overlay).toHaveCount(0);
    });
  });
});
