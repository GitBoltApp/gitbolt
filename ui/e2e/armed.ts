import type { Locator, Page } from '@playwright/test';

// Shared by e2e/ and e2e-demo/ (test.ts pulls in the harness fixtures, which the demo suite has none of).

/** An armed control's overlay (spec §ui confirms): visual only (aria-hidden), so found by its text. */
export const armedOverlay = (page: Page, text: string | RegExp) => page.locator('.arm-overlay', { hasText: text });

/** The second click on an armed control: a fresh click once the pointer's settle guard
 * (`CLICK_SETTLE_MS`, 200 ms from arming to the press) has passed, as a user's deliberate second
 * click is. Waited from when the target shows, which is after it armed. */
export async function confirmArmed(target: Locator): Promise<void> {
  await target.waitFor();
  await target.page().waitForTimeout(250);
  await target.click();
}
