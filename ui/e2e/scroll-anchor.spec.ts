import { freshFixture, git, openUrl } from './fixtures';
import { expect, test, type Page } from './test';

// K78: a refresh (a watcher refresh, a background fetch) keeps the same commits at the same
// screen position, except at the very top, which stays the top so new commits show.

const grid = (page: Page) => page.getByRole('grid', { name: 'Commit graph' });

/** The row nearest the middle of the grid: its id and its offset from the grid's top. Null while
 * the rendered rows don't reach the middle: a scroll's rows render on its scroll event, a frame
 * after `scrollTop` is set. */
const probe = (page: Page) => grid(page).evaluate((g) => {
  const box = g.getBoundingClientRect();
  const mid = box.top + box.height / 2;
  const row = [...g.querySelectorAll('[role="row"][id^="graph-row-"]')].find((r) => r.getBoundingClientRect().bottom > mid && r.getBoundingClientRect().top <= mid);
  return row ? { id: row.id, offset: Math.round(row.getBoundingClientRect().top - box.top) } : null;
});
const height = (page: Page) => grid(page).evaluate((g) => g.scrollHeight);

async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 500 });
  const repo = freshFixture('long_history');
  await page.goto(openUrl(repo));
  await expect(grid(page)).toBeVisible();
  return repo;
}

/** Commits on HEAD from outside (the watcher refreshes), and waits until the graph has grown. */
async function commitElsewhere(page: Page, repo: string, count: number) {
  const h = await height(page);
  for (let i = 0; i < count; i++) git(repo, 'commit', '-q', '--allow-empty', '-m', `Brand new ${i}`);
  await expect.poll(() => height(page), { timeout: 10_000 }).toBeGreaterThan(h);
  await page.waitForTimeout(300);
}

test.describe('scroll position across a refresh (K78)', () => {
  // One repo and page for the four (each was a test of its own, paying for a page load and a
  // fixture): every step's checks are relative to where it starts, and each adds its own commits.
  // The top first, while each new commit's message is still unique.
  test('the same commits stay in the same place across a refresh, mid-history with or without a selection; at the very top it stays the top', async ({ page }) => {
    const repo = await open(page);
    await test.step('at the very top it stays at the top, so the new commits show', async () => {
      await grid(page).evaluate((g) => { g.scrollTop = 0; });
      await commitElsewhere(page, repo, 3);
      expect(await grid(page).evaluate((g) => g.scrollTop)).toBe(0);
      await expect(page.getByRole('row').filter({ hasText: 'Brand new 2' })).toBeVisible();
    });
    for (const how of ['no selection', 'a selection off screen', 'a selection near the bottom of the view']) {
      await test.step(`mid-history with ${how}: the same commits stay in the same place`, async () => {
        if (how === 'a selection off screen') await page.getByRole('row').filter({ hasText: 'Commit 5' }).first().click();
        await grid(page).evaluate((g) => { g.scrollTop = 900; });
        if (how === 'a selection near the bottom of the view') {
          await expect.poll(() => grid(page).evaluate((g) => g.scrollTop)).toBe(900);
          await grid(page).evaluate((g) => {
            const bottom = g.getBoundingClientRect().bottom;
            const rows = [...g.querySelectorAll<HTMLElement>('[role="row"][id^="graph-row-"]')].filter((r) => r.getBoundingClientRect().bottom <= bottom - 2);
            rows[rows.length - 1].click();
          });
        }
        await expect.poll(() => grid(page).evaluate((g) => g.scrollTop)).toBe(900);
        await expect.poll(() => probe(page)).not.toBeNull();
        const before = await probe(page);
        await commitElsewhere(page, repo, 3);
        expect(await probe(page)).toEqual(before);
      });
    }
  });
});
