import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { freshFixture, git, harnessHttp, openUrl } from './fixtures';
import { expect, test, type Page } from './test';

/** The harness answers 401 on any `/test/auth/…` path, so git asks for credentials. The port is
 * this run's harness port (GITBOLT_E2E_PORT_BASE), never a fixed one. */
const AUTH_URL = `${harnessHttp}/test/auth/x.git`;

const fetchButton = (page: Page) => page.getByRole('button', { name: 'Fetch', exact: true });
const statusBar = (page: Page) => page.locator('.status-bar');
const authDialog = (page: Page) => page.getByRole('dialog', { name: 'Authentication required' });
const graph = (page: Page) => page.getByRole('grid', { name: 'Commit graph' });

/** Pushes a new branch `from-e2e` with one commit to the fixture's origin, from another clone. */
function pushFromElsewhere(repo: string, message: string) {
  const origin = join(dirname(repo), 'origin.git');
  const other = join(dirname(repo), 'other');
  git(dirname(repo), 'clone', '-q', origin, other);
  git(other, 'switch', '-q', '-c', 'from-e2e');
  writeFileSync(join(other, 'e2e.txt'), 'x\n');
  git(other, 'add', 'e2e.txt');
  git(other, 'commit', '-q', '-m', message);
  git(other, 'push', '-q', 'origin', 'from-e2e');
}

/** `scripts/fake-ssh` (K96): an ssh stand-in that fails like a dead agent, asks a key passphrase
 * through askpass, or hangs. */
const FAKE_SSH = join(import.meta.dirname, '..', '..', 'scripts', 'fake-ssh');

/** Points the fixture's origin at an ssh URL that `fake-ssh <mode>` serves (its bare origin). */
function sshOrigin(repo: string, mode: string) {
  git(repo, 'remote', 'set-url', 'origin', `ssh://fake${join(dirname(repo), 'origin.git')}`);
  git(repo, 'config', 'core.sshCommand', `${FAKE_SSH} ${mode}`);
  git(repo, 'config', 'ssh.variant', 'simple');
}

/** What the shown diff panel paints, as one string (diff.spec's `paintedNow`, K7): its path, then
 * every visible text of its body. Runs in the page. */
function paintedNow(): string {
  const shown = (el: Element) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const panel = [...document.querySelectorAll('.diff-panel')].find((p) => shown(p));
  const body = panel?.querySelector('.diff-body');
  if (!panel || !body) return '';
  const out = [`panel:${panel.querySelector('[data-testid="diff-path"]')?.textContent ?? ''}`];
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent?.replace(/ /g, ' ').trim();
    if (text && n.parentElement && shown(n.parentElement)) out.push(text);
  }
  return out.join('|');
}

test.describe('fetch', () => {
  test('a user fetch brings in new remote branches', async ({ page }) => {
    const repo = freshFixture('basic');
    pushFromElsewhere(repo, 'Pushed from elsewhere');
    await page.goto(openUrl(repo));
    await expect(graph(page)).toBeVisible();
    await expect(page.getByText('Pushed from elsewhere')).toHaveCount(0);
    await fetchButton(page).click();
    await expect(page.getByText('Pushed from elsewhere')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('row').filter({ hasText: 'Pushed from elsewhere' }).getByText('from-e2e')).toBeVisible();
    await expect(fetchButton(page)).toBeEnabled();
    await expect(statusBar(page)).not.toContainText('Fetching…');
  });

  // The Fetch dropdown is the default picker now (spec #2 §12.1): picking runs nothing, so the
  // palette's "Fetch all" (`repo.fetch`) is the other way to fetch.
  test('Fetch all, from the palette, fetches too', async ({ page }) => {
    const repo = freshFixture('basic');
    pushFromElsewhere(repo, 'Pushed for Fetch all');
    await page.goto(openUrl(repo));
    await expect(graph(page)).toBeVisible();
    await page.keyboard.press('Control+p');
    await page.keyboard.type('>Fetch all');
    await expect(page.getByRole('option').first()).toContainText('Fetch all');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Pushed for Fetch all')).toBeVisible({ timeout: 10_000 });
  });

  test('credential prompts go through the modal', async ({ page }) => {
    const repo = freshFixture('basic');
    git(repo, 'remote', 'set-url', 'origin', AUTH_URL);
    await page.goto(openUrl(repo));
    await fetchButton(page).click();
    const dialog = authDialog(page);
    await expect(dialog).toContainText(`Username for '${harnessHttp}'`);
    await expect(statusBar(page)).toContainText('Waiting for authentication…');
    // K30: the user's fetch shows on its button, never as "Fetching…" in the status bar.
    await expect(fetchButton(page)).toHaveAttribute('aria-busy', 'true');
    await expect(statusBar(page)).not.toContainText('Fetching');
    await expect(dialog.getByLabel('Answer')).toBeFocused();
    await dialog.getByLabel('Answer').fill('ada');
    await dialog.getByRole('button', { name: 'OK' }).click();
    await expect(dialog.getByLabel('Password')).toHaveAttribute('type', 'password');
    await dialog.getByLabel('Password').fill('wrong');
    await dialog.getByRole('button', { name: 'OK' }).click();
    await expect(page.getByRole('status')).toContainText('Authentication failed', { timeout: 10_000 });
    await expect(dialog).toHaveCount(0);
  });

  test('the auth modal owns the keyboard: Esc cancels the prompt, and the app behind sees nothing', async ({ page }) => {
    const repo = freshFixture('basic');
    git(repo, 'remote', 'set-url', 'origin', AUTH_URL);
    await page.goto(openUrl(repo));
    await expect(graph(page)).toBeVisible();
    await fetchButton(page).click();
    await expect(authDialog(page)).toBeVisible();
    // Ctrl+W would close the tab; behind the modal it does nothing.
    await page.keyboard.press('Control+w');
    await expect(page.locator('.tab-page')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(authDialog(page)).toHaveCount(0);
    await expect(statusBar(page)).not.toContainText('Fetching…', { timeout: 10_000 });
    await expect(graph(page)).toBeVisible();
    // A cancelled prompt is a cancel, not an error: no toast, nothing in the bell.
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(statusBar(page).getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
  });

  test('cancelling from the status bar kills the fetch quietly', async ({ page }) => {
    const repo = freshFixture('basic');
    git(repo, 'remote', 'set-url', 'origin', AUTH_URL);
    await page.goto(openUrl(repo));
    await fetchButton(page).click();
    await expect(authDialog(page)).toBeVisible();
    await statusBar(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(authDialog(page)).toBeHidden();
    await expect(statusBar(page)).not.toContainText('Fetching…', { timeout: 5000 });
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(fetchButton(page)).toBeEnabled();
  });

  test("a failing user fetch shows git's message in a toast that links to the activity log (K96)", async ({ page }) => {
    const repo = freshFixture('basic');
    sshOrigin(repo, '--dead-agent');
    await page.goto(openUrl(repo));
    await expect(graph(page)).toBeVisible();
    await fetchButton(page).click();
    const toast = page.getByRole('status');
    await expect(toast).toContainText('Fetch failed: Authentication failed (fake: Permission denied (publickey).)', { timeout: 10_000 });
    await toast.getByRole('button', { name: 'Activity log' }).click();
    await expect(toast).toHaveCount(0);
    const activity = page.getByRole('dialog', { name: 'Activity' });
    await expect(activity).toBeVisible();
    await expect(activity.locator('.activity-entry').first()).toContainText('fake: Permission denied (publickey).');
    await expect(activity.locator('.activity-entry').first()).toContainText('$ git fetch --all');
    await page.keyboard.press('Escape');
    await expect(activity).toHaveCount(0);
    await expect(fetchButton(page)).toBeEnabled();
  });

  test('an ssh key passphrase prompt goes through the modal (K96)', async ({ page }) => {
    const repo = freshFixture('basic');
    pushFromElsewhere(repo, 'Fetched over ssh');
    sshOrigin(repo, '--passphrase testpass');
    await page.goto(openUrl(repo));
    await expect(graph(page)).toBeVisible();
    await fetchButton(page).click();
    const dialog = authDialog(page);
    await expect(dialog).toContainText('Enter passphrase for key');
    await expect(dialog.getByLabel('Password')).toHaveAttribute('type', 'password');
    await dialog.getByLabel('Password').fill('testpass');
    await dialog.getByRole('button', { name: 'OK' }).click();
    // The fetched commit shows; a fetch that worked raises no toast.
    await expect(page.getByText('Fetched over ssh')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('status').filter({ hasText: 'Fetch failed' })).toHaveCount(0);
  });

  test('a passphrase prompt that arrives while the palette is open is on top, focused, and owns Enter (I1)', async ({ page }) => {
    const repo = freshFixture('basic');
    pushFromElsewhere(repo, 'Fetched under the palette');
    sshOrigin(repo, '--delay 2 --passphrase testpass');
    await page.goto(openUrl(repo));
    await expect(graph(page)).toBeVisible();
    await fetchButton(page).click();
    await page.keyboard.press('Control+p');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await page.keyboard.type('>find'); // Enter would run "Find in graph" if the palette still owned it
    const dialog = authDialog(page);
    await expect(dialog).toContainText('Enter passphrase for key', { timeout: 10_000 });
    await expect(dialog.getByLabel('Password')).toBeFocused();
    // The prompt is the topmost thing at its own centre, above the palette.
    const onTop = await dialog.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    });
    expect(onTop).toBe(true);
    await page.keyboard.type('testpass');
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Fetched under the palette')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('search', { name: 'Find in graph' })).toHaveCount(0);
  });

  test('a stuck user fetch shows in the status bar once slow, and Cancel stops it quietly (K96)', async ({ page }) => {
    const repo = freshFixture('basic');
    sshOrigin(repo, '--hang');
    await page.goto(openUrl(repo));
    await expect(graph(page)).toBeVisible();
    await fetchButton(page).click();
    await expect(fetchButton(page)).toHaveAttribute('aria-busy', 'true');
    await expect(statusBar(page)).toContainText('Fetching repo…', { timeout: 10_000 });
    await statusBar(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(statusBar(page)).not.toContainText('Fetching', { timeout: 5000 });
    await expect(fetchButton(page)).toBeEnabled();
    await expect(page.getByRole('status')).toHaveCount(0);
  });

  test('background fetch never shows the auth modal', async ({ page }) => {
    const repo = freshFixture('basic');
    git(repo, 'remote', 'set-url', 'origin', AUTH_URL);
    await page.goto(openUrl(repo));
    await expect(graph(page)).toBeVisible();
    await page.evaluate(() => window.__gb!.setSettings({ fetchIntervalSecs: 1 }));
    await expect(statusBar(page)).toContainText('Fetch skipped: authentication required', { timeout: 10_000 });
    await expect(authDialog(page)).toHaveCount(0);
    // (This covers the first background fetch only: the interval is clamped to 60 s, so no second tick is waited for.)
  });

  test('background fetch runs on its own, and not while the window is minimized', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    await expect(graph(page)).toBeVisible();
    await page.evaluate(() => { window.__gbTestMinimized = true; });
    pushFromElsewhere(repo, 'Fetched in the background');
    await page.evaluate(() => window.__gb!.setSettings({ fetchIntervalSecs: 30 }));
    // A negative check: time has to pass. A fetch from the local origin shows well within it.
    await page.waitForTimeout(1500);
    await expect(page.getByText('Fetched in the background')).toHaveCount(0);
    // Restored: the focus comes back, and the missed tick is replayed. The next regular tick is
    // 60 s away (30 is clamped to 60), so only the replay can fetch within the wait below.
    await page.evaluate(() => { window.__gbTestMinimized = false; window.dispatchEvent(new Event('focus')); });
    await expect(page.getByText('Fetched in the background')).toBeVisible({ timeout: 10_000 });
  });

  test('a background fetch shows nowhere but the activity log (K30)', async ({ page }) => {
    const repo = freshFixture('basic');
    await page.goto(openUrl(repo));
    await expect(graph(page)).toBeVisible();
    pushFromElsewhere(repo, 'Fetched quietly');
    // Record every state of the status bar and the Fetch button while the background fetch runs.
    await page.evaluate(() => {
      const w = window as unknown as { seen: string[] };
      w.seen = [];
      const bar = document.querySelector('.status-bar')!;
      const record = () => {
        const btn = document.querySelector('button[aria-label="Fetch"]');
        w.seen.push(`${bar.textContent ?? ''}|busy=${btn?.getAttribute('aria-busy') ?? ''}`);
      };
      record();
      new MutationObserver(record).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-busy'] });
    });
    await page.evaluate(() => window.__gb!.setSettings({ fetchIntervalSecs: 30 }));
    await expect(page.getByText('Fetched quietly')).toBeVisible({ timeout: 10_000 });
    const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
    expect(seen.filter((s) => s.includes('Fetching') || s.includes('busy=true'))).toEqual([]);
    await expect(page.getByRole('status')).toHaveCount(0);
    const activity = await page.evaluate(() => window.__gb!.activity());
    expect(activity[0]).toMatchObject({ kind: 'fetch', background: true, outcome: 'ok' });
    expect(activity[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  test('a fetch that moves refs while a diff is open neither closes it nor flashes it (K7)', async ({ page }) => {
    // The first diff of a run also loads (and, under the dev server, compiles) Monaco's chunk.
    test.setTimeout(60_000);
    const repo = freshFixture('basic');
    pushFromElsewhere(repo, 'Arrived while diffing');
    await page.goto(openUrl(repo));
    await page.getByRole('row').filter({ hasText: 'Fix typo' }).click();
    await page.locator('[role="option"][data-path]').first().click();
    const diff = page.getByRole('region', { name: 'Diff' });
    await expect(diff.getByTestId('diff-path')).toBeVisible();
    await expect(diff.locator('.editor.modified .view-line').first()).toBeVisible({ timeout: 40_000 });
    await expect.poll(() => page.evaluate(paintedNow)).toMatch(/^panel:.+\|/);
    const before = await page.evaluate(paintedNow);
    // Sample what's painted, twice a frame, across the fetch and the refresh it causes.
    await page.evaluate((fn) => {
      const now = new Function(`return (${fn})()`) as () => string;
      const w = window as unknown as { samples: string[]; stop: boolean };
      w.samples = [];
      w.stop = false;
      const channel = new MessageChannel();
      channel.port1.onmessage = () => w.samples.push(now());
      const loop = () => {
        w.samples.push(now());
        channel.port2.postMessage(null);
        if (!w.stop) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }, paintedNow.toString());
    await fetchButton(page).click();
    await expect(statusBar(page)).not.toContainText('Fetching…', { timeout: 10_000 });
    await expect(fetchButton(page)).toBeEnabled();
    // Let the refsUpdated refresh land (a few frames after the fetch returns).
    await page.waitForTimeout(500);
    const samples = await page.evaluate(() => {
      const w = window as unknown as { samples: string[]; stop: boolean };
      w.stop = true;
      return w.samples;
    });
    expect(samples.length).toBeGreaterThan(10);
    expect(samples.filter((s) => s !== before)).toEqual([]);
    // The graph did refresh underneath: closing the diff shows the fetched branch.
    await page.keyboard.press('Escape');
    await expect(page.getByText('Arrived while diffing')).toBeVisible();
  });
});
