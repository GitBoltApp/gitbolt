import { test as base, expect as baseExpect } from '@playwright/test';
import { harnessHttp } from './fixtures';

/**
 * Every spec imports `test` from here: before each test the harness forgets all settings,
 * profiles and recorded launches (POST /test/reset; later also tabs and watchers), so tests
 * never see each other's state.
 */
export const test = base.extend<{ resetHarness: void }>({
  resetHarness: [async ({ request }, use) => {
    const res = await request.post(`${harnessHttp}/test/reset`);
    expect(res.ok()).toBe(true);
    await use();
  }, { auto: true }],
});

/** `expect.poll`'s retry intervals unless a call names its own: Playwright's default backs off to
 * a poll every second ([100, 250, 500, 1000]), so a condition met at 900 ms was only seen at
 * 1850 ms. Every 50 ms, then every 100: the polled reads (a DOM query, a git command) are cheap. */
const POLL_INTERVALS = [50, 100];

/** Playwright's `expect`, with `POLL_INTERVALS` as `expect.poll`'s default. */
export const expect: typeof baseExpect = baseExpect.configure({});
const poll = expect.poll;
expect.poll = ((actual, messageOrOptions) =>
  poll(actual, typeof messageOrOptions === 'string' ? { message: messageOrOptions, intervals: POLL_INTERVALS } : { intervals: POLL_INTERVALS, ...messageOrOptions })) as typeof poll;

export type { Locator, Page } from '@playwright/test';

/** An armed control's overlay (spec §ui confirms): visual only (aria-hidden), so found by its text. */
export const armedOverlay = (page: import('@playwright/test').Page, text: string | RegExp) => page.locator('.arm-overlay', { hasText: text });

/** The second click on an armed control: a fresh click once the settle guard (350 ms after
 * arming) has passed, as a user's deliberate second click is. */
export async function confirmArmed(target: import('@playwright/test').Locator): Promise<void> {
  await target.waitFor();
  await target.page().waitForTimeout(400);
  await target.click();
}
