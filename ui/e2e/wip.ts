import { expect, type Locator, type Page } from '@playwright/test';
import { freshFixture, openUrl } from './fixtures';

/** Opens a fresh copy of the fixture and selects its WIP row; the repo path. */
export async function openWip(page: Page, fixture: 'wip_staging' | 'wip_conflict' = 'wip_staging'): Promise<string> {
  const repo = freshFixture(fixture);
  await page.goto(openUrl(repo));
  // A stopped merge selects the WIP by itself and opens no file (H.1).
  if (fixture === 'wip_conflict') await expect(page.getByTestId('wip-header')).toBeVisible({ timeout: 15_000 });
  else await selectWip(page);
  return repo;
}

/** Selects the (first) WIP row: a click on its message cell's corner, off the inline summary box. */
export async function selectWip(page: Page): Promise<void> {
  await page.getByRole('grid', { name: 'Commit graph' }).getByRole('row').filter({ hasText: '// WIP' }).first().locator('[data-col="message"]').click({ position: { x: 3, y: 3 } });
  await expect(page.getByTestId('wip-header')).toBeVisible();
}

export const section = (page: Page, which: 'unstaged' | 'staged' | 'conflicted') => page.locator(`.wip-section[data-section="${which}"]`);
export const fileRow = (page: Page, which: 'unstaged' | 'staged' | 'conflicted', path: string) => section(page, which).locator(`.file-row[data-path="${path}"]`);
/** `fileRow`'s CSS selector, for checks that run in the page. */
export const fileRowSelector = (which: 'unstaged' | 'staged' | 'conflicted', path: string) => `.wip-section[data-section="${which}"] .file-row[data-path="${path}"]`;

declare global {
  interface Window { __gbBudget?: Promise<number> }
}

/** What `timedClick` waits for: an element matching `sel` (with `text` in it, if given) shows, or,
 * with `gone`, the last such element leaves. */
export type Done = string | { sel: string; text?: string; gone?: boolean };

/**
 * §16's write budgets run "from the click to the updated panel": clicks `target`, then answers the
 * milliseconds from that click event to the first frame drawn once `done` holds. Timed in the
 * page, so neither Playwright's actionability checks before the click nor its polling after it
 * count.
 */
export async function timedClick(page: Page, target: Locator, done: Done): Promise<number> {
  await page.evaluate(({ sel, text, gone }) => {
    const present = () => [...document.querySelectorAll(sel)].some((e) => text === undefined || (e.textContent ?? '').includes(text));
    window.__gbBudget = new Promise<number>((resolve) => {
      const onClick = (e: MouseEvent) => {
        document.removeEventListener('click', onClick, true);
        const t0 = e.timeStamp;
        const seen = new MutationObserver(() => {
          if (present() === !!gone) return;
          seen.disconnect();
          requestAnimationFrame(() => resolve(performance.now() - t0));
        });
        seen.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      };
      document.addEventListener('click', onClick, true);
    });
  }, typeof done === 'string' ? { sel: done } : done);
  await target.click();
  return page.evaluate(() => window.__gbBudget!);
}
