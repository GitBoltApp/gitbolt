// Opt-in: opens the real repository named by GITBOLT_REAL_REPO (read-only) and checks the
// graph actually renders at scale. Skipped entirely unless that env var is set, so `just e2e`
// never depends on any particular developer's machine.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { expect, test } from '@playwright/test';

const REAL_REPO = process.env.GITBOLT_REAL_REPO;

// Never let a read command take git's optional locks (see GitCli::run in git.rs, and the
// GIT_OPTIONAL_LOCKS=0 fix this guards): the whole point of this spec is proving GitBolt (and
// this spec's own bookkeeping) never write to the repo it's inspecting.
const READ_ONLY_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };

function run(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: READ_ONLY_ENV });
}

/** The per-worktree git-dir for `repo` (main worktree: `.git`; linked: `.git/worktrees/<name>`). */
function gitDir(repo: string): string {
  const dotGit = join(repo, '.git');
  const st = statSync(dotGit);
  if (st.isDirectory()) return dotGit;
  const m = readFileSync(dotGit, 'utf8').trim().match(/^gitdir:\s*(.+)$/);
  if (!m) throw new Error(`unrecognized .git file at ${dotGit}`);
  return isAbsolute(m[1]) ? m[1] : join(repo, m[1]);
}

interface Snapshot {
  status: string;
  forEachRef: string;
  indexSha256: string;
  indexMtimeMs: number;
}

/** Everything GitBolt (or this spec) must leave untouched: working-tree status, refs, and the
 * main worktree's index (bytes + mtime — a plain, unlocked `git status` rewrites this even when
 * nothing tracked actually changed). */
function snapshot(repo: string): Snapshot {
  const indexPath = join(gitDir(repo), 'index');
  return {
    status: run(repo, ['status', '--porcelain']),
    forEachRef: run(repo, ['for-each-ref']),
    indexSha256: createHash('sha256').update(readFileSync(indexPath)).digest('hex'),
    indexMtimeMs: statSync(indexPath).mtimeMs,
  };
}

/** Number of dirty, usable worktrees of `repo` — mirrors collect_wip's filter in snapshot.rs
 * (skips bare, prunable, unborn-HEAD and missing worktrees), read-only throughout. */
function dirtyWorktreeCount(repo: string): number {
  const blocks = run(repo, ['worktree', 'list', '--porcelain']).split('\n\n');
  let count = 0;
  for (const block of blocks) {
    if (!block.trim() || /^bare\b/m.test(block) || /^prunable\b/m.test(block) || !/^HEAD /m.test(block)) continue;
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path || !existsSync(path)) continue;
    if (run(path, ['status', '--porcelain']).trim().length > 0) count++;
  }
  return count;
}

test.describe('real repository (opt-in)', () => {
  test.skip(!REAL_REPO, 'set GITBOLT_REAL_REPO=/path/to/repo to run this against a real repository');

  test('renders the real graph read-only, at scale', async ({ page }, testInfo) => {
    const before = snapshot(REAL_REPO!);

    const readyLogs: string[] = [];
    page.on('console', (msg) => {
      if (msg.text().includes('[gitbolt] graph ready')) readyLogs.push(msg.text());
    });

    const t0 = Date.now();
    await page.goto(`/?repo=${encodeURIComponent(REAL_REPO!)}`);
    const grid = page.getByRole('grid', { name: 'Commit graph' });
    await expect(grid).toBeVisible();
    await expect(page.getByRole('row').first()).toBeVisible();
    const firstRowMs = Date.now() - t0;
    await expect.poll(() => readyLogs.length, { message: 'waiting for the app\'s own [gitbolt] graph ready console log' }).toBeGreaterThan(0);
    console.log(`[real-repo] page load -> first row visible: ${firstRowMs} ms`);
    console.log(`[real-repo] app-reported: ${readyLogs.at(-1)}`);

    // `aria-rowcount` carries the full logical row count (graph.rows.length): commit rows are
    // capped at DEFAULT_COMMIT_LIMIT (2000) plus one WIP row per dirty, usable worktree.
    const rowCount = Number(await grid.getAttribute('aria-rowcount'));
    const wipCount = dirtyWorktreeCount(REAL_REPO!);
    console.log(`[real-repo] rowCount=${rowCount} wipCount(dirty, usable worktrees)=${wipCount}`);
    expect(rowCount).toBeGreaterThanOrEqual(2000);
    expect(rowCount).toBeLessThanOrEqual(2000 + wipCount);

    const screenshotPath = testInfo.outputPath(`real-repo-${testInfo.project.name}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[real-repo] screenshot: ${screenshotPath}`);

    const after = snapshot(REAL_REPO!);
    expect(after.status, 'git status --porcelain must be unchanged').toBe(before.status);
    expect(after.forEachRef, 'git for-each-ref must be unchanged').toBe(before.forEachRef);
    expect(after.indexSha256, '.git/index sha256 must be unchanged').toBe(before.indexSha256);
    expect(after.indexMtimeMs, '.git/index mtime must be unchanged').toBe(before.indexMtimeMs);
  });

  test('details, diffs and WIP stay read-only and fast', async ({ page }) => {
    test.setTimeout(120_000);
    const before = snapshot(REAL_REPO!);
    const logs: string[] = [];
    page.on('console', (msg) => { if (/\[gitbolt\] (details|diff) ready/.test(msg.text())) logs.push(msg.text()); });
    await page.goto(`/?repo=${encodeURIComponent(REAL_REPO!)}`);
    const grid = page.getByRole('grid', { name: 'Commit graph' });
    await expect(grid).toBeVisible();

    await page.getByRole('row').filter({ hasNot: page.getByText('// WIP') }).first().click();
    await expect(page.getByTestId('details-summary')).toBeVisible();
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('ArrowDown');
      await expect(page.getByTestId('details-summary')).toBeVisible();
    }
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Diff' })).toBeVisible();
    // The first diff also loads the editor's chunk (Monaco + Shiki): allow for a cold start, as
    // diff.spec.ts does, before timing the rest -- otherwise the fast-poll loop below can race
    // the chunk load and record no `diff ready` log at all.
    await expect.poll(() => logs.some((l) => l.includes('diff ready')), { timeout: 15_000 }).toBe(true);
    // Opening a file moves focus into the files zone (DetailsPanel's pickFileList picks the
    // listbox holding the open file), not into the diff pane itself. So these ArrowDowns page
    // through the file list -- FileList's onKeyDown opens each newly-active file's diff -- which
    // is exactly what samples several more `diff ready` logs below.
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(150);
    }
    await page.keyboard.press('Escape');
    await expect(grid).toBeVisible();

    const wipRow = page.getByRole('row').filter({ hasText: '// WIP' }).first();
    if (await wipRow.count()) {
      await wipRow.click();
      const unstaged = page.getByRole('listbox', { name: 'Unstaged' });
      const staged = page.getByRole('listbox', { name: 'Staged', exact: true });
      const list = (await unstaged.getByRole('option').count()) > 0 ? unstaged : staged;
      const first = list.getByRole('option').first();
      if (await first.count()) {
        await first.click();
        await expect(page.getByRole('region', { name: 'Diff' })).toBeVisible();
        await page.keyboard.press('Escape');
      }
    }

    const ms = (kind: string) => logs.filter((l) => l.includes(`${kind} ready`)).map((l) => Number(/in (\d+) ms/.exec(l)![1])).sort((x, y) => x - y);
    const median = (xs: number[]) => xs[Math.floor(xs.length / 2)] ?? Number.NaN;
    const details = ms('details');
    // Diff samples arrive in file-open order, not fastest-first: the *first* one opened is the
    // cold Monaco + Shiki load, not necessarily the slowest. Pull it out by arrival, then sort
    // only the rest (`diffs.slice(1)` after sorting was dropping the fastest warm sample instead).
    const diffsByArrival = logs.filter((l) => l.includes('diff ready')).map((l) => Number(/in (\d+) ms/.exec(l)![1]));
    const [cold, ...warm] = diffsByArrival;
    const diffs = [...warm].sort((x, y) => x - y);
    console.log(`[real-repo] details ready ms: ${details.join(', ')} (median ${median(details)})`);
    console.log(`[real-repo] diff ready ms: cold ${cold} ms (loads Monaco + Shiki); warm ${diffs.join(', ')} (median ${median(diffs)})`);
    // Spec §17.3 budgets (50 ms / 100 ms) are for the packaged app; this run is a debug harness
    // and the Vite dev server. The soft checks catch order-of-magnitude regressions, and 1D's
    // `just bench` measures the real budgets.
    expect.soft(median(details)).toBeLessThan(150);
    expect.soft(median(diffs)).toBeLessThan(400);

    const after = snapshot(REAL_REPO!);
    expect(after.status, 'git status --porcelain must be unchanged').toBe(before.status);
    expect(after.forEachRef, 'git for-each-ref must be unchanged').toBe(before.forEachRef);
    expect(after.indexSha256, '.git/index sha256 must be unchanged').toBe(before.indexSha256);
    expect(after.indexMtimeMs, '.git/index mtime must be unchanged').toBe(before.indexMtimeMs);
  });
});
