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
    await expect(page.getByRole('tooltip')).toHaveText(/Margaret Hamilton\s*margaret@example\.com/);
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
