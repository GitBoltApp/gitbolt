import { test as base, expect as baseExpect, type BrowserContext, type BrowserContextOptions } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { harnessHttp } from './fixtures';

/**
 * Every spec imports `test` from here: before each test the harness forgets all settings,
 * profiles and recorded launches (POST /test/reset; later also tabs and watchers), so tests
 * never see each other's state.
 */
export const test = base.extend<{ resetHarness: void; isolatedContext: boolean; _combinedContextOptions: BrowserContextOptions }, { contextPool: Map<string, BrowserContext> }>({
  resetHarness: [async ({ request }, use) => {
    const res = await request.post(`${harnessHttp}/test/reset`);
    expect(res.ok()).toBe(true);
    await use();
  }, { auto: true }],
  contextPool: [async ({}, use) => {
    const pool = new Map<string, BrowserContext>();
    await use(pool);
    await Promise.all([...pool.values()].map((c) => c.close()));
  }, { scope: 'worker' }],
  // One browser context per set of context options for the whole worker, and a new page (a new
  // tab: fresh sessionStorage) per test, instead of Playwright's new context per test. A new
  // context starts with an empty HTTP cache, so every test downloaded and compiled the app's
  // bundle (and Monaco's) again: most of what a short test cost. Kept between tests: only the
  // HTTP cache (and V8's code cache in it). Each test still starts with no cookies and an empty
  // localStorage (the init script below clears it on the tab's first load, so a reload inside a
  // test keeps what the test saved), and its pages are closed after it. A test that needs a
  // context of its own (one that installs a clock, which is the context's) asks for one with
  // `test.use({ isolatedContext: true })`. GITBOLT_E2E_FRESH_CONTEXT=1 gives every test its own.
  isolatedContext: [false, { option: true }],
  context: async ({ browser, contextPool, isolatedContext, _combinedContextOptions }, use) => {
    if (isolatedContext || process.env.GITBOLT_E2E_FRESH_CONTEXT) {
      const fresh = await browser.newContext(_combinedContextOptions);
      await use(fresh);
      await fresh.close();
      return;
    }
    const key = JSON.stringify(_combinedContextOptions);
    let context = contextPool.get(key);
    if (!context) {
      context = await browser.newContext(_combinedContextOptions);
      await context.addInitScript(() => {
        try {
          if (window !== window.top || location.protocol === 'about:' || sessionStorage.getItem('__gbE2eTab')) return;
          sessionStorage.setItem('__gbE2eTab', '1');
          localStorage.clear();
        } catch {
          // An opaque origin has no storage.
        }
      });
      contextPool.set(key, context);
    }
    await context.clearCookies();
    await use(context);
    await Promise.all(context.pages().map((p) => p.close()));
  },
});

/** `expect.poll`'s retry intervals unless a call names its own: Playwright's default backs off to
 * a poll every second ([100, 250, 500, 1000]), so a condition met at 900 ms was only seen at
 * 1850 ms. Every 50 ms, then every 100: the polled reads (a DOM query, a git command) are cheap. */
const POLL_INTERVALS = [50, 100];

const configured = baseExpect.configure({});

/** The retrying assertions on a locator or a page, whose options (last argument) take a `timeout`. */
const RETRYING = new Set([
  'toBeAttached', 'toBeChecked', 'toBeDisabled', 'toBeEditable', 'toBeEmpty', 'toBeEnabled', 'toBeFocused', 'toBeHidden', 'toBeInViewport', 'toBeVisible',
  'toContainClass', 'toContainText', 'toHaveAccessibleDescription', 'toHaveAccessibleName', 'toHaveAttribute', 'toHaveClass', 'toHaveCount', 'toHaveCSS', 'toHaveId',
  'toHaveRole', 'toHaveText', 'toHaveValue', 'toHaveValues', 'toHaveTitle', 'toHaveURL',
]);
/** Each try of a retrying assertion (`chunked`). Under 2500 ms, Playwright's retry backoff
 * ([20, 50, 100, 100, 500] ms, its rungs capped at a fifth of the timeout) keeps only 20 and 50. */
const TRY_MS = 250;
/** How long a retrying assertion is checked finely; after this its last try takes the rest of its
 * timeout, at Playwright's own backoff. A condition still unmet by then is slow work (a big render
 * in progress), and a check every 50 ms (a style and layout pass on a large page) slowed it. */
const FINE_MS = 1500;
const THIS_FILE = fileURLToPath(import.meta.url);
/** Playwright's default assertion timeout (playwright.config.ts sets none). */
const EXPECT_TIMEOUT = 5000;
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const isLocatorOrPage = (v: unknown) => !!v && typeof v === 'object' && (typeof (v as { waitFor?: unknown }).waitFor === 'function' || typeof (v as { goto?: unknown }).goto === 'function');

/**
 * A retrying assertion, tried for `TRY_MS` at a time for its first `FINE_MS`, then once more until
 * its own timeout: the same assertion with the same deadline, only checked about every 50 ms at
 * first. Playwright's backoff checks every 500 ms once 270 ms have passed, so a condition met at
 * 300 ms (a diff's editor starting, an image decoding) was only seen at 770 ms. The last try runs
 * to the deadline, so a failure reports as it would have.
 */
async function chunked(actual: unknown, message: string | undefined, isNot: boolean, name: string, args: unknown[]): Promise<void> {
  const last = args.at(-1);
  const opts = isPlainObject(last) ? last : undefined;
  const rest = opts ? args.slice(0, -1) : args;
  const total = typeof opts?.timeout === 'number' ? opts.timeout : EXPECT_TIMEOUT;
  const run = (timeout: number) => {
    const m = configured(actual, message) as unknown as Record<string, unknown> & { not: Record<string, unknown> };
    return ((isNot ? m.not : m)[name] as (...a: unknown[]) => Promise<void>)(...rest, { ...opts, timeout });
  };
  const start = Date.now();
  const deadline = start + total;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 2 * TRY_MS || Date.now() - start >= FINE_MS) {
      try {
        return await run(Math.max(1, left));
      } catch (e) {
        // Reported as the assertion itself: its own timeout, not the last try's, and located at
        // the spec's line (the report takes the error's first frame outside Playwright: this
        // file's frames are dropped).
        if (e instanceof Error) {
          const timeout = /Timeout: \d+ms/;
          e.message = e.message.replace(timeout, `Timeout: ${total}ms`);
          e.stack = e.stack?.replace(timeout, `Timeout: ${total}ms`).split('\n').filter((l) => !l.includes(THIS_FILE)).join('\n');
        }
        throw e;
      }
    }
    try {
      return await run(TRY_MS);
    } catch {
      // Not yet: try again (a lasting failure is reported by the last try).
    }
  }
}

const chunkedMatchers = (actual: unknown, message: string | undefined, isNot: boolean, matchers: object): object =>
  new Proxy(matchers, {
    get(target, prop, receiver) {
      if (prop === 'not') return chunkedMatchers(actual, message, !isNot, Reflect.get(target, prop, receiver) as object);
      if (typeof prop === 'string' && RETRYING.has(prop)) return (...args: unknown[]) => chunked(actual, message, isNot, prop, args);
      return Reflect.get(target, prop, receiver);
    },
  });

/** Playwright's `expect`: retrying assertions on a locator or a page poll finely (`chunked`), and
 * `expect.poll` takes `POLL_INTERVALS` by default. */
export const expect: typeof baseExpect = new Proxy(configured, {
  apply(target, thisArg, argList: [unknown, (string | { message?: string })?]) {
    const matchers = Reflect.apply(target, thisArg, argList) as object;
    const [actual, messageOrOptions] = argList;
    if (!isLocatorOrPage(actual)) return matchers;
    return chunkedMatchers(actual, typeof messageOrOptions === 'string' ? messageOrOptions : messageOrOptions?.message, false, matchers);
  },
});
const poll = configured.poll;
expect.poll = ((actual, messageOrOptions) =>
  poll(actual, typeof messageOrOptions === 'string' ? { message: messageOrOptions, intervals: POLL_INTERVALS } : { intervals: POLL_INTERVALS, ...messageOrOptions })) as typeof poll;

export type { Locator, Page } from '@playwright/test';

/** Whether a `@budget` test's timing assertions apply: in the `chromium-budget` project only, the
 * engine GitBolt ships (CEF = Chromium), run after the rest so a loaded run doesn't trip them.
 * WebKit still runs those tests' flows, and their `[budget]` logs, but its timings aren't a budget. */
export const budgetApplies = () => base.info().project.name === 'chromium-budget';

/** An armed control's overlay (spec §ui confirms): visual only (aria-hidden), so found by its text. */
export const armedOverlay = (page: import('@playwright/test').Page, text: string | RegExp) => page.locator('.arm-overlay', { hasText: text });

/** The second click on an armed control: a fresh click once the pointer's settle guard
 * (`CLICK_SETTLE_MS`, 200 ms from arming to the press) has passed, as a user's deliberate second
 * click is. Waited from when the target shows, which is after it armed. */
export async function confirmArmed(target: import('@playwright/test').Locator): Promise<void> {
  await target.waitFor();
  await target.page().waitForTimeout(250);
  await target.click();
}
