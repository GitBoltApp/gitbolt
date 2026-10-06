import { freshFixture, git, openUrl, originGit } from './fixtures';
import { expect, test, confirmArmed, armedOverlay } from './test';

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
    await expect(dialog.getByRole('checkbox', { name: 'Track it' })).toBeChecked();
    await confirmArmed(dialog.getByRole('button', { name: 'Push' }));
    const upstream = () => { try { return git(repo, 'rev-parse', '--abbrev-ref', 'feature/new@{upstream}'); } catch { return null; } };
    await expect.poll(upstream).toBe('origin/feature/new');
    expect(originGit(repo, 'rev-parse', 'feature/new')).toBe(git(repo, 'rev-parse', 'feature/new'));
  });

  test('a rejected push is a choice at the Push button; Force push arms first', async ({ page }) => {
    const repo = freshFixture('sync');
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'local only');
    await page.goto(openUrl(repo));
    await page.getByRole('button', { name: 'Push', exact: true }).click();
    const choice = page.getByRole('alertdialog');
    await expect(choice).toContainText("origin/main has 1 commit main doesn't have");
    // The safe choice first, and focused (board G).
    await expect(choice.getByRole('button', { name: 'Pull' })).toBeFocused();
    await confirmArmed(choice.getByRole('button', { name: 'Force push…' }));
    await confirmArmed(armedOverlay(page, 'Click again to force push: replaces 1 commit'));
    await expect.poll(() => originGit(repo, 'rev-parse', 'main')).toBe(git(repo, 'rev-parse', 'main'));
  });

});

// --- 2D T19 ---
test.describe('fetch and pull, and the push upstream (spec #2 §12.1-§12.3)', () => {
  // One repo and page for both (each was a test of its own, paying for a page load): the pull
  // first, on main's own upstream, then Push ▾ moves that upstream.
  test('the default picker sets the default without running and Pull fast-forwards; Push ▾ changes the upstream without pushing', async ({ page }) => {
    const repo = freshFixture('sync');
    await page.goto(openUrl(repo));
    await test.step('the default picker sets the default without running; Pull fast-forwards', async () => {
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
      // The toast, not the pending marks (also role=status) the pull shows while it runs.
      await expect(page.getByRole('status').filter({ hasText: 'Pulled 1 commit into main (fast-forward)' })).toBeVisible();
      expect(git(repo, 'rev-parse', 'main')).toBe(git(repo, 'rev-parse', 'origin/main'));
    });
    await test.step('Push ▾ changes the upstream without pushing', async () => {
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

  test('a diverged ff-only pull offers Rebase / Merge / Cancel', async ({ page }) => {
    const repo = freshFixture('sync');
    git(repo, 'switch', '-q', 'diverged');
    await page.goto(openUrl(repo));
    await page.getByRole('button', { name: 'Fetch options' }).click();
    await page.getByRole('menuitemradio', { name: 'Pull (fast-forward only)' }).click();
    await page.getByRole('button', { name: 'Pull', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('diverged and origin/diverged have diverged (1 ahead, 1 behind).');
    await confirmArmed(dialog.getByRole('button', { name: 'Rebase' }));
    await expect.poll(() => git(repo, 'rev-list', '--count', '--merges', 'origin/diverged..diverged')).toBe('0');
    expect(git(repo, 'rev-list', '--count', 'origin/diverged..diverged')).toBe('1');
  });
});
// --- end 2D T19 ---
