import { freshFixture, git, openUrl, originGit } from './fixtures';
import { expect, test } from './test';

test.describe('push (spec #2 §12.3, §12.4)', () => {
  test('push dev shows the server output link and the warning toast', async ({ page }) => {
    const repo = freshFixture('sync');
    git(repo, 'switch', '-q', 'dev');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'more dev');
    await page.goto(openUrl(repo));
    const push = page.getByRole('button', { name: 'Push', exact: true });
    await push.hover();
    await expect(page.getByRole('tooltip')).toHaveText('Push dev to origin/dev');
    await push.click();
    const toast = page.getByRole('alert');
    await expect(toast).toContainText('Pushed dev to origin/dev; the server reported a problem');
    await expect(toast).toContainText('“integration: rebase onto dev failed: conflict in a.txt”');
    await toast.getByRole('button', { name: 'Server output (2 lines)' }).click();
    // The server's own lines (`.remote-info`), not the raw stderr under them.
    await expect(page.locator('.remote-info').getByText('Deployed preview for dev')).toBeVisible();
    expect(originGit(repo, 'rev-parse', 'dev')).toBe(git(repo, 'rev-parse', 'dev'));
  });

  test('a branch with no upstream asks where, then pushes and tracks', async ({ page }) => {
    const repo = freshFixture('sync');
    git(repo, 'switch', '-q', 'feature/new');
    await page.goto(openUrl(repo));
    await page.getByRole('button', { name: 'Push', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /Push feature\/new to/ });
    await expect(dialog.getByRole('textbox', { name: 'Branch' })).toHaveValue('feature/new');
    await dialog.getByRole('button', { name: 'Push' }).click();
    const upstream = () => { try { return git(repo, 'rev-parse', '--abbrev-ref', 'feature/new@{upstream}'); } catch { return null; } };
    await expect.poll(upstream).toBe('origin/feature/new');
    expect(originGit(repo, 'rev-parse', 'feature/new')).toBe(git(repo, 'rev-parse', 'feature/new'));
  });

  test('a rejected push offers force-with-lease, confirmed', async ({ page }) => {
    const repo = freshFixture('sync');
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'local only');
    await page.goto(openUrl(repo));
    await page.getByRole('button', { name: 'Push', exact: true }).click();
    await page.getByRole('status').getByRole('button', { name: 'Force push…' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText("Force push main to origin/main? It replaces 1 commit on origin/main that isn't in main. A push can't be undone.");
    await confirm.getByRole('button', { name: 'Force push' }).click();
    await expect.poll(() => originGit(repo, 'rev-parse', 'main')).toBe(git(repo, 'rev-parse', 'main'));
  });

  test('Push ▾ changes the upstream without pushing', async ({ page }) => {
    const repo = freshFixture('sync');
    await page.goto(openUrl(repo));
    await page.getByRole('button', { name: 'Push options' }).click();
    await page.getByRole('menuitem', { name: 'Other branch…' }).click();
    // "Other branch…" is the RefPicker (spec #2 §12.3): a combobox over the remote branches.
    const before = originGit(repo, 'rev-parse', 'main');
    await expect(page.getByRole('combobox', { name: 'Upstream of main' })).toBeVisible();
    await page.getByRole('listbox', { name: 'Upstream of main' }).getByRole('option', { name: 'origin/dev' }).click();
    await expect.poll(() => git(repo, 'rev-parse', '--abbrev-ref', 'main@{upstream}')).toBe('origin/dev');
    expect(originGit(repo, 'rev-parse', 'main')).toBe(before);
  });
});

// --- 2D T19 ---
test.describe('fetch and pull (spec #2 §12.1, §12.2)', () => {
  test('the default picker sets the default without running; Pull fast-forwards', async ({ page }) => {
    const repo = freshFixture('sync');
    await page.goto(openUrl(repo));
    await expect(page.getByRole('button', { name: 'Fetch', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Fetch options' }).click();
    await expect(page.getByText('Select a default pull/fetch operation to execute when clicking this button')).toBeVisible();
    await expect(page.getByRole('menuitemradio', { name: 'Fetch All' })).toHaveAttribute('aria-checked', 'true');
    const before = git(repo, 'rev-parse', 'main');
    await page.getByRole('menuitemradio', { name: 'Pull (fast-forward only)' }).click();
    expect(git(repo, 'rev-parse', 'main')).toBe(before);
    const pull = page.getByRole('button', { name: 'Pull', exact: true });
    await pull.hover();
    await expect(page.getByRole('tooltip')).toHaveText('Pull origin/main into main (fast-forward only)');
    await pull.click();
    await expect(page.getByRole('status')).toContainText('Pulled 1 commit into main (fast-forward)');
    expect(git(repo, 'rev-parse', 'main')).toBe(git(repo, 'rev-parse', 'origin/main'));
  });

  test('a diverged ff-only pull offers Rebase / Merge / Cancel', async ({ page }) => {
    const repo = freshFixture('sync');
    git(repo, 'switch', '-q', 'diverged');
    await page.goto(openUrl(repo));
    await page.getByRole('button', { name: 'Fetch options' }).click();
    await page.getByRole('menuitemradio', { name: 'Pull (fast-forward only)' }).click();
    await page.getByRole('button', { name: 'Pull', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('diverged and origin/diverged have diverged (1 ahead, 1 behind).');
    await dialog.getByRole('button', { name: 'Rebase' }).click();
    await expect.poll(() => git(repo, 'rev-list', '--count', '--merges', 'origin/diverged..diverged')).toBe('0');
    expect(git(repo, 'rev-list', '--count', 'origin/diverged..diverged')).toBe('1');
  });
});
// --- end 2D T19 ---
