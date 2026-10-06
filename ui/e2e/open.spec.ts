import type { APIRequestContext, Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fixtures, freshFixture, harnessHttp } from './fixtures';
import { expect, test } from './test';

const pick = (request: APIRequestContext, path: string | null) =>
  request.post(`${harnessHttp}/test/next-pick`, { data: { path } });

const graph = (page: Page) => page.getByRole('grid', { name: 'Commit graph' });

test.describe('open repository screen', () => {
  // Each `test.step` below was a test of its own, paying for a page load; they run in an order
  // where each starts from what it needs (the one that opens a repository last).
  test('the Open screen: the first-run banner, Your repos and its folders, the picker cancelled, a non-repository, then a repository', async ({ page, request }) => {
    await test.step('first run: banner suggests ~/repos, then Your repos lists what is there', async () => {
      await page.goto('/');
      await expect(page.getByRole('tab').first()).toHaveText('Open repository');
      const banner = page.getByRole('region', { name: 'Default repos directory' });
      await banner.getByRole('button', { name: /^Use .*\/home\/repos$/ }).click();
      await expect(banner).toBeHidden();
      const yours = page.locator('section[aria-labelledby="open-yours"]');
      await expect(yours.getByText('repo', { exact: true })).toBeVisible();
      await expect(yours.getByText('main')).toBeVisible();
    });
    await test.step('Your repos: its own scroll box, add a folder through the picker, remove a folder', async () => {
      const yours = page.locator('section[aria-labelledby="open-yours"]');
      const folders = yours.getByRole('list', { name: 'Scanned directories' });
      // The profile migrates to <home>/repos on its first load.
      const repos = (await folders.getByRole('listitem').first().getAttribute('title'))!;
      await expect(yours.getByText('repo', { exact: true })).toBeVisible();
      await pick(request, join(dirname(repos), 'more'));
      await yours.getByRole('button', { name: 'Add directory' }).click();
      await expect(folders.getByRole('listitem')).toHaveCount(2);
      await expect(yours.getByRole('button', { name: /^bulk-39/ })).toBeAttached();
      // Only that column scrolls: the page is fixed, the list overflows its own box.
      const box = yours.locator('.open-scroll');
      expect(await box.evaluate((e) => e.scrollHeight > e.clientHeight + 100)).toBe(true);
      expect(await page.locator('.open-screen').evaluate((e) => e.scrollHeight <= e.clientHeight + 1)).toBe(true);
      await box.evaluate((e) => { e.scrollTop = e.scrollHeight; });
      expect(await box.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
      expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
      // Remove the added folder: its repos go, the other folder's stay.
      await folders.getByRole('button', { name: /Remove directory .*\/more$/ }).click();
      await expect(folders.getByRole('listitem')).toHaveCount(1);
      await expect(yours.getByRole('button', { name: /^bulk-/ })).toHaveCount(0);
      await expect(yours.getByText('repo', { exact: true })).toBeVisible();
    });
    await test.step('a cancelled picker changes nothing', async () => {
      await pick(request, null);
      await page.getByRole('button', { name: 'Open directory…' }).click();
      await expect(page.getByRole('tab').first()).toHaveText('Open repository');
    });
    await test.step('a folder outside any repository shows the error and keeps the screen', async () => {
      await pick(request, fixtures.notRepo);
      await page.getByRole('button', { name: 'Open directory…' }).click();
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(page.getByRole('tab').first()).toHaveText('Open repository');
    });
    await test.step('open folder uses the system picker and turns the tab into the repo', async () => {
      await pick(request, fixtures.basic);
      await page.getByRole('button', { name: 'Open directory…' }).click();
      await expect(graph(page)).toBeVisible();
      await expect(page.getByRole('tab')).toHaveCount(1);
      await expect(page.getByRole('tab').first()).toHaveText('repo');
    });
  });

  test('clone opens the clone in the tab', async ({ page }) => {
    const repo = freshFixture('basic');
    const dest = join(mkdtempSync(join(tmpdir(), 'gitbolt-e2e-clone-')), 'origin');
    await page.goto('/');
    await page.getByLabel('Repository URL').fill(`file://${join(dirname(repo), 'origin.git')}`);
    await page.getByLabel('Destination').fill(dest);
    await page.getByRole('button', { name: 'Clone', exact: true }).click();
    await expect(graph(page)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('tab').first()).toHaveText('origin');
  });

  test('clone credential prompts can be cancelled', async ({ page }) => {
    const dest = join(mkdtempSync(join(tmpdir(), 'gitbolt-e2e-clone-')), 'x');
    await page.goto('/');
    await page.getByLabel('Repository URL').fill(`${harnessHttp}/test/auth/x.git`);
    await page.getByLabel('Destination').fill(dest);
    await page.getByRole('button', { name: 'Clone', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Authentication required' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('alert')).toHaveText('Clone cancelled');
  });

  test('from a repository: Ctrl+O and the recent list (filter, pin, remove); Clone repository… focuses the URL', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(`/?repo=${encodeURIComponent(repo)}`);
    await expect(graph(page)).toBeVisible();
    await test.step('recent repositories: filter, pin and remove', async () => {
      await page.keyboard.press('Control+o');
      await expect(page.getByRole('tab').nth(1)).toHaveText('Open repository');
      const recent = page.locator('section[aria-labelledby="open-recent"]');
      await expect(recent.getByText('repo', { exact: true })).toBeVisible();
      await recent.getByLabel('Filter recent repositories').fill('zzz');
      await expect(recent.getByText('No recent repository matches.')).toBeVisible();
      await recent.getByLabel('Filter recent repositories').fill('');
      await recent.getByRole('button', { name: 'Pin repo' }).click();
      await expect(recent.getByRole('button', { name: 'Unpin repo' })).toHaveAttribute('aria-pressed', 'true');
      await recent.getByRole('button', { name: 'Remove repo from recent' }).click();
      await expect(recent.getByText('Repositories you open appear here.')).toBeVisible();
    });
    await test.step('Clone repository… opens an Open tab with the URL focused', async () => {
      // The previous step's Open tab closed first: Clone… opens one of its own.
      await page.keyboard.press('Control+w');
      await expect(page.getByRole('tab')).toHaveCount(1);
      await page.getByRole('button', { name: 'Menu' }).click();
      await page.getByRole('menuitem', { name: 'File' }).hover();
      await page.getByRole('menuitem', { name: 'Clone repository…' }).click();
      await expect(page.getByRole('tab').nth(1)).toHaveText('Open repository');
      await expect(page.getByLabel('Repository URL')).toBeFocused();
    });
  });});
