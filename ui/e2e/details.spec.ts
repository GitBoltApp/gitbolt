import { expect, test } from '@playwright/test';
import { fixtures, openUrl } from './fixtures';

test.describe('commit details', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(openUrl(fixtures.details));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
  });

  test('the panel appears when a commit is selected and shows its header and message', async ({ page }) => {
    await expect(page.getByRole('complementary', { name: 'Commit details' })).toHaveCount(0);
    await page.getByRole('row').filter({ hasText: 'Rename guide and update assets' }).click();
    const panel = page.getByRole('complementary', { name: 'Commit details' });
    await expect(panel.getByTestId('details-summary')).toHaveText('Rename guide and update assets');
    await expect(panel.getByTestId('author')).toContainText('Grace Hopper');
    await expect(panel.getByTestId('committer')).toContainText('Ada Lovelace');
    await expect(panel.getByTestId('details-body')).toContainText('Refs !42');
    await expect(panel.getByTestId('parent-sha')).toHaveCount(1);
  });

  test('arrow keys update the details immediately', async ({ page }) => {
    await page.getByRole('row').filter({ hasText: "Merge branch 'feature/x'" }).click();
    const summary = page.getByTestId('details-summary');
    await expect(summary).toHaveText("Merge branch 'feature/x'");
    await page.keyboard.press('ArrowDown');
    await expect(summary).toHaveText('Rename guide and update assets');
  });

  test('a merge lists both parents and a parent SHA selects that commit', async ({ page }) => {
    await page.getByRole('row').filter({ hasText: "Merge branch 'feature/x'" }).click();
    await expect(page.getByTestId('parent-sha')).toHaveCount(2);
    await page.getByTestId('parent-sha').last().click();
    await expect(page.getByTestId('details-summary')).toHaveText('Add feature file');
    await expect(page.getByRole('row').filter({ hasText: 'Add feature file' })).toHaveAttribute('aria-selected', 'true');
  });

  test('clicking the details SHA copies the full hash', async ({ page, browserName }) => {
    await page.getByRole('row').filter({ hasText: 'Initial commit' }).click();
    await page.getByTestId('details-sha').click();
    await expect(page.getByRole('status')).toHaveText('Copied');
    if (browserName === 'chromium') expect(await page.evaluate(() => navigator.clipboard.readText())).toHaveLength(40);
  });

  test('Enter on a focused row SHA copies it and does not open a diff', async ({ page }) => {
    const row = page.getByRole('row').filter({ hasText: 'Rename guide and update assets' });
    await row.click();
    await row.getByTestId('sha').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toHaveText('Copied');
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
  });

  test('co-authors, the signature badge and initials avatars', async ({ page }) => {
    await page.getByRole('row').filter({ hasText: 'Rename guide and update assets' }).click();
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

  test('the header: signature icon left, SHA centred, parents right; the commit date first (F15, F16)', async ({ page }) => {
    await page.getByRole('row').filter({ hasText: 'Rename guide and update assets' }).click();
    const panel = page.getByRole('complementary', { name: 'Commit details' });
    const [sig, sha, parents, row] = await Promise.all([
      panel.getByTestId('signature-badge').boundingBox(),
      panel.getByTestId('details-sha').boundingBox(),
      panel.locator('.parents').boundingBox(),
      panel.locator('.commit-ids').boundingBox(),
    ]);
    expect(sig!.x - row!.x).toBeLessThan(2);
    expect(Math.abs(sha!.x + sha!.width / 2 - (row!.x + row!.width / 2))).toBeLessThan(2);
    expect(row!.x + row!.width - (parents!.x + parents!.width)).toBeLessThan(2);
    await expect(panel.getByTestId('signature-badge')).toHaveAccessibleName('Not signed');
    await panel.getByTestId('signature-badge').hover();
    await expect(page.getByRole('tooltip')).toHaveText('Not signed');
    // The fixture commits have one timestamp for author and committer: one date, no "authored".
    await expect(panel.getByTestId('commit-date')).toHaveText(/^\d{4}-\d{2}-\d{2} @ \d{1,2}:\d{2} [AP]M$/);
  });

  test('the header stays put, only the message scrolls, and the split resizes and persists (F13)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
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

  test('message links and MR buttons point at the GitLab project', async ({ page }) => {
    await page.getByRole('row').filter({ hasText: 'Rename guide and update assets' }).click();
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

  test('Ctrl+click marks A and B, and Escape leaves compare mode', async ({ page }) => {
    const initial = page.getByRole('row').filter({ hasText: 'Initial commit' });
    const merge = page.getByRole('row').filter({ hasText: "Merge branch 'feature/x'" });
    await initial.click({ modifiers: ['Control'] });
    await merge.click({ modifiers: ['Control'] });
    await expect(initial.getByTestId('compare-a')).toHaveText('A');
    await expect(merge.getByTestId('compare-b')).toHaveText('B');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('compare-a')).toHaveCount(0);
    await expect(merge).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('details-summary')).toHaveText("Merge branch 'feature/x'");
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
