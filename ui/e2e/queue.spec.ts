import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshFixture, git, openUrl, originGit, testWrite, touch, writeHook } from './fixtures';
import { expect, test, type Page } from './test';

const chip = (page: Page) => page.locator('.status-bar .sb-queue');
const sleep = (label: string, ms: number, fail = false) => ({ op: 'sleep' as const, label, ms, fail });

test.describe('action queue (spec #2 §3.6)', () => {
  test('the chip shows the running item and what waits, in click order, then hides', async ({ page, request }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    const first = testWrite(request, repo, sleep('push dev', 1500));
    await expect(chip(page)).toHaveText('Running: push dev');
    const second = testWrite(request, repo, sleep('push dev', 100));
    await expect(chip(page)).toHaveText('Running: push dev · 1 queued', { timeout: 1000 });
    expect((await first).ok).toBeDefined();
    expect((await second).ok).toBeDefined();
    await expect(chip(page)).toBeHidden();
  });

  test('a queued item can be removed from the list', async ({ page, request }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    const first = testWrite(request, repo, sleep('push dev', 1500));
    await expect(chip(page)).toHaveText('Running: push dev');
    const second = testWrite(request, repo, sleep('commit "x"', 100));
    await expect(chip(page)).toContainText('1 queued');
    await chip(page).click();
    await page.getByRole('menuitem', { name: 'Remove commit "x"' }).click();
    expect((await second).err?.kind).toBe('Cancelled');
    await first;
  });

  test('a failure stops the rest; Resume runs them and Clear drops them', async ({ page, request }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    const failing = testWrite(request, repo, sleep('push dev', 800, true));
    await expect(chip(page)).toHaveText('Running: push dev');
    const b = testWrite(request, repo, sleep('b', 50));
    await expect(chip(page)).toContainText('1 queued');
    expect((await failing).err?.message).toBe('push dev failed');
    await expect(chip(page)).toHaveText('Stopped: push dev failed · 1 not run');
    await chip(page).click();
    await page.getByRole('menuitem', { name: 'Resume' }).click();
    expect((await b).ok).toBeDefined();
    await expect(chip(page)).toBeHidden();

    const again = testWrite(request, repo, sleep('push dev', 800, true));
    await expect(chip(page)).toHaveText('Running: push dev');
    const c = testWrite(request, repo, sleep('c', 50));
    await again;
    await expect(chip(page)).toHaveText('Stopped: push dev failed · 1 not run');
    await chip(page).click();
    await page.getByRole('menuitem', { name: 'Clear' }).click();
    expect((await c).err?.kind).toBe('Cancelled');
    await expect(chip(page)).toBeHidden();
  });

  test('Cancel on the running item stops it, and the queue goes on', async ({ page, request }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    const first = testWrite(request, repo, sleep('push dev', 5000));
    await expect(chip(page)).toHaveText('Running: push dev');
    const second = testWrite(request, repo, sleep('b', 50));
    await expect(chip(page)).toContainText('1 queued');
    await chip(page).click();
    await page.getByRole('menuitem', { name: 'Cancel push dev' }).click();
    expect((await first).err?.kind).toBe('Cancelled');
    expect((await second).ok).toBeDefined();
    await expect(chip(page)).toBeHidden();
  });

  test('a write to an unmarked repository is refused (spec #2 §17.2)', async ({ request }) => {
    // Under the temp dir (the fixture root) but without the fixture marker.
    const dir = mkdtempSync(join(tmpdir(), 'gitbolt-unmarked-'));
    git(dir, 'init', '-q');
    const res = await testWrite(request, dir, sleep('x', 1));
    expect(res.err?.message).toBe('writes are limited to fixture repositories');
    rmSync(dir, { recursive: true, force: true });
  });
});

// --- 2D T17 ---
test('a push in flight is not queued again: the Push button is busy and takes no second click (spec #2 §3.6)', async ({ page }) => {
  const repo = freshFixture('sync');
  git(repo, 'switch', '-q', 'dev');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'dev more');
  const go = `${repo}/../go`;
  writeHook(repo, 'pre-push', `#!/bin/sh\nwhile [ ! -f '${go}' ]; do sleep 0.05; done\n`);
  await page.goto(openUrl(repo));
  const push = page.getByRole('button', { name: 'Push', exact: true });
  await push.click();
  // Pushing again while it runs is ignored (not queued): the button shows it busy and takes no click.
  await expect(push).toHaveAttribute('aria-busy', 'true');
  await expect(push).toBeDisabled();
  await expect(chip(page)).toHaveText('Running: push dev to origin/dev');
  touch(go);
  await expect(chip(page)).toBeHidden();
  await expect(push).not.toHaveAttribute('aria-busy', 'true');
  expect(originGit(repo, 'rev-parse', 'dev')).toBe(git(repo, 'rev-parse', 'dev'));
});
// --- end 2D T17 ---
