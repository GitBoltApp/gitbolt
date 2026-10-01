import { expect, test } from './test';
import { fixtures, openUrl } from './fixtures';

test('the WIP row shows read-only unstaged and staged files with their diffs', async ({ page }) => {
  // The staged tweak is the last line of a long file: Hunk mode shows it (with its context)
  // where the default Inline mode (amendment 3) would leave it below Monaco's rendered lines.
  await page.addInitScript(() => localStorage.setItem('gitbolt.diffPrefs.v1', JSON.stringify({ mode: 'hunk', ignoreWhitespace: false, wordWrap: false })));
  await page.goto(openUrl(fixtures.details));
  await page.getByRole('row').filter({ hasText: '// WIP' }).click();
  await expect(page.getByTestId('wip-header')).toContainText('// WIP');
  await expect(page.getByRole('heading', { name: 'Unstaged (2)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Staged (1)' })).toBeVisible();
  const unstaged = page.getByRole('listbox', { name: 'Unstaged' });
  await expect(unstaged.getByRole('option')).toHaveText([/manual\.txt/, /notes\.txt/]);
  await unstaged.getByRole('option').filter({ hasText: 'notes.txt' }).click();
  const diff = page.getByRole('region', { name: 'Diff' });
  // The page's first diff loads the editor's chunk (Monaco + Shiki, 3-5 s cold on the dev server
  // at idle, more on a loaded machine): allow for a cold start.
  await expect(diff.locator('.editor.modified')).toContainText('untracked notes', { timeout: 15_000 });
  await page.getByRole('listbox', { name: 'Staged', exact: true }).getByRole('option').click();
  await expect(diff.locator('.editor.modified')).toContainText('// staged tweak');
  await expect(page.getByRole('button', { name: /stage|discard/i })).toHaveCount(0);
});

test('re-selecting the WIP row re-reads its file lists: they are never cached (deviation 9)', async ({ page }) => {
  const wipReads: boolean[] = [];
  page.on('websocket', (ws) => ws.on('framesent', ({ payload }) => {
    const { req } = JSON.parse(String(payload)) as { req?: { method?: string; params?: { spec?: { kind?: string; staged?: boolean } } } };
    if (req?.method === 'fileList' && req.params?.spec?.kind === 'wip') wipReads.push(req.params.spec.staged!);
  }));
  await page.goto(openUrl(fixtures.details));
  const wip = page.getByRole('row').filter({ hasText: '// WIP' });
  await wip.click();
  await expect(page.getByRole('heading', { name: 'Staged (1)' })).toBeVisible();
  await expect.poll(() => wipReads).toEqual([false, true]);
  await page.getByRole('row').filter({ hasText: 'Initial commit' }).click();
  await expect(page.getByTestId('details-summary')).toHaveText('Initial commit');
  await wip.click();
  await expect(page.getByRole('heading', { name: 'Staged (1)' })).toBeVisible();
  await expect.poll(() => wipReads).toEqual([false, true, false, true]);
});
