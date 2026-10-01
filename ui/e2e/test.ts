import { test as base, expect } from '@playwright/test';
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

export { expect };
export type { Locator, Page } from '@playwright/test';
