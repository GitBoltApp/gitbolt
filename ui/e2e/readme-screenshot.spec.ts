import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fixtures } from './fixtures';
import { expect, test } from './test';

// The README's screenshot (docs/images/screenshot.webp): opt-in, not part of the suite. Run it with
// `just readme-screenshot`, which sets GITBOLT_README_SHOT to the PNG to write and optimises it.
// The repos are scripts/showcase-repo.sh's, built into this run's fixture root.
const out = process.env.GITBOLT_README_SHOT;
test.skip(!out, 'the README screenshot runs with GITBOLT_README_SHOT=<png> (just readme-screenshot)');
test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium only');
test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, timezoneId: 'UTC', locale: 'en-US' });

test('README screenshot', async ({ page }) => {
  test.setTimeout(120_000);
  const root = mkdtempSync(join(fixtures.notRepo, 'showcase-'));
  execFileSync('bash', [join(import.meta.dirname, '..', '..', 'scripts', 'showcase-repo.sh'), root], { stdio: 'ignore' });
  const repos = ['driftwood', 'docs-site', 'infra', 'mobile-app'].map((r) => join(root, r));
  await page.goto(`/?${repos.map((r) => `repo=${encodeURIComponent(r)}`).join('&')}`);
  await expect(page.getByRole('tab')).toHaveCount(repos.length);
  await page.getByRole('tab', { name: /driftwood/ }).click();
  const grid = page.getByRole('grid', { name: 'Commit graph' });
  await expect(grid).toBeVisible();
  await grid.getByRole('row').filter({ hasText: 'Queue edits while offline' }).click();
  const panel = page.getByRole('complementary', { name: 'Commit details' });
  await expect(panel.getByTestId('details-summary')).toHaveText('Queue edits while offline and replay them on reconnect');
  await expect(panel.getByRole('option')).toHaveCount(5);
  // Nothing hovered or focused that a user wouldn't see at rest.
  await page.mouse.move(1, 999);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(500);
  await page.screenshot({ path: out!, animations: 'disabled', caret: 'hide' });
});
