import type { Locator, Page } from '@playwright/test';
import { addForgeAccount, E2E_GITLAB_TOKEN, forgeRequests, forgeSeed, freshFixture, git, openUrl, setForgeSeed } from './fixtures';
import { armedOverlay, confirmArmed, expect, test } from './test';

/** The pointer at an element's centre: a hovered chip floats its copy over the resting one, so a
 * locator click would hit the copy (Playwright calls that interception). */
async function pointAt(page: Page, el: Locator, click = false) {
  const box = (await el.boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  if (click) await page.mouse.click(x, y);
  else await page.mouse.move(x, y);
}

test.describe('merge requests (spec #4 §7, 4B)', () => {
  test('a badge, its hover card, and the MR view with a comment and an approval', async ({ page, request }) => {
    // The sync fixture's local `dev` tracks origin/dev: the fake GitLab's !12 is from `dev`.
    const repo = freshFixture('sync');
    git(repo, 'remote', 'set-url', 'origin', 'https://gitlab.example.com/group/project.git');
    await addForgeAccount(request, 'gitlab.example.com', 'gitlab', E2E_GITLAB_TOKEN);
    await page.goto(openUrl(repo));
    const graph = page.getByRole('grid', { name: 'Commit graph' });
    await expect(graph).toBeVisible();

    const badges = graph.getByRole('button', { name: 'Merge request !12: open' });
    await expect(badges).toHaveCount(1);
    const badge = badges.first();
    await expect(badge).toBeVisible();
    // `diverged` and origin/diverged sit on different commits: each chip has the draft's badge.
    await expect(graph.getByRole('button', { name: 'Merge request !5: draft' }).first()).toBeVisible();
    const logBefore = (await forgeRequests(request)).length;
    await pointAt(page, badge);
    const card = page.getByRole('tooltip').filter({ hasText: 'Dev work' });
    await expect(card).toContainText('!12');
    await expect(card.locator('.mr-card-author')).toContainText('Grace Hopper');
    await expect(card.locator('.mr-card-title .mr-state')).toHaveText('Open');
    await expect(card.locator('.mr-card-branches')).toHaveText('dev → main');
    await expect(card).toContainText('Pipeline passed');
    await expect(card).toContainText('0 of 1 approval');

    await pointAt(page, badge, true);
    const view = page.getByRole('dialog', { name: 'Merge request !12' });
    await expect(view).toBeVisible();
    await expect(view).toContainText('Adds the dev work.');
    await expect(view.getByRole('button', { name: 'README.md:2' })).toBeVisible();
    await expect(view).toContainText('+Second line');
    await expect(view.getByRole('button', { name: 'Merge', exact: true })).toBeDisabled();
    await expect(view).toContainText('It needs approval first');

    await test.step('typing :thu in the comment box offers emoji, and Enter inserts :thumbsup: ', async () => {
      const box = view.getByRole('textbox', { name: 'Write a comment' });
      await box.pressSequentially(':thu');
      await expect(page.getByRole('listbox', { name: 'Emoji' })).toBeVisible();
      await box.press('Enter');
      await expect(box).toHaveValue(':thumbsup: ');
      await expect(page.getByRole('listbox', { name: 'Emoji' })).toBeHidden();
      await box.press('Control+a');
      await box.pressSequentially('@');
      await expect(page.getByRole('listbox', { name: 'People' })).toBeVisible();
      await box.press('Escape');
      await expect(page.getByRole('listbox', { name: 'People' })).toBeHidden();
    });
    await view.getByRole('textbox', { name: 'Write a comment' }).fill('Thanks, merging soon.');
    await view.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(view.getByRole('region', { name: 'Activity' })).toContainText('Thanks, merging soon.');
    // Approve is the APPROVALS box's check: it arms in place first.
    await view.locator('.mr-fact[data-fact="reviews"]').getByRole('button', { name: 'Approve', exact: true }).click();
    await confirmArmed(armedOverlay(page, 'Click again to approve'));
    await expect(view.getByRole('button', { name: 'Approved', exact: true })).toBeVisible();
    await expect(view.getByRole('button', { name: 'Merge', exact: true })).toBeEnabled();

    await test.step('an assignee added, then removed: at once, no confirm', async () => {
      const people = view.getByRole('group', { name: 'Reviewers, assignees and labels' });
      const puts = async () => (await forgeRequests(request)).filter((r) => r.method === 'PUT' && r.path === '/api/v4/projects/42/merge_requests/12').length;
      await people.getByRole('button', { name: 'Add assignee' }).click();
      await page.getByRole('combobox', { name: 'Assignees' }).fill('gra');
      await page.getByRole('option', { name: /Grace Hopper/ }).click();
      const remove = people.getByRole('button', { name: 'Remove Grace Hopper' });
      await expect(remove).toBeVisible();
      await expect.poll(puts).toBe(1);
      await remove.click();
      await expect(remove).toBeHidden();
      await expect.poll(puts).toBe(2);
      await expect(people.getByRole('button', { name: 'Remove Ada Lovelace' })).toBeVisible();
    });

    await test.step('auto-merge while the pipeline runs: set, shown with who set it, cancelled', async () => {
      const seed = await forgeSeed(request);
      const m = (seed.gitlab as unknown as { mergeRequests: Array<Record<string, unknown>> }).mergeRequests.find((x) => x.iid === 12)!;
      Object.assign(m, { pipeline: 'running', mergeStatus: 'ci_still_running' });
      await setForgeSeed(request, seed);
      // Opened again (no page load): it loads the running pipeline.
      await page.keyboard.press('Escape');
      await expect(view).toBeHidden();
      await page.getByRole('complementary', { name: 'Sidebar', exact: true }).getByRole('region', { name: 'Merge requests', exact: true }).getByRole('treeitem', { name: '!12 Dev work' }).click();
      const box = view.getByRole('region', { name: 'Merge' });
      await expect(box).toContainText('Merge when all checks pass');
      await box.getByRole('button', { name: 'Set to auto-merge' }).click();
      await confirmArmed(armedOverlay(page, 'Click again to set !12 to auto-merge'));
      await expect(box).toContainText('Auto-merge set by');
      await expect(box).toContainText('Ada Lovelace');
      await expect(box).toContainText('Will merge when checks pass');
      await box.getByRole('button', { name: 'Cancel auto-merge' }).click();
      await confirmArmed(armedOverlay(page, 'Click again to cancel auto-merge of !12'));
      await expect(box.getByRole('button', { name: 'Set to auto-merge' })).toBeVisible();
      const writes = (await forgeRequests(request)).filter((r) => r.path.startsWith('/api/v4/projects/42/merge_requests/12/'));
      expect(writes.some((r) => r.method === 'PUT' && r.path.endsWith('/merge'))).toBe(true);
      expect(writes.some((r) => r.method === 'POST' && r.path.endsWith('/cancel_merge_when_pipeline_succeeds'))).toBe(true);
    });

    // --- MR round 2 ---
    const mrs = (seed: Awaited<ReturnType<typeof forgeSeed>>) => (seed.gitlab as unknown as { mergeRequests: Array<Record<string, unknown>> }).mergeRequests;
    const reopen = async () => {
      await page.keyboard.press('Escape');
      await expect(view).toBeHidden();
      await page.getByRole('complementary', { name: 'Sidebar', exact: true }).getByRole('region', { name: 'Merge requests', exact: true }).getByRole('treeitem', { name: '!12 Dev work' }).click();
      await expect(view).toBeVisible();
    };

    await test.step("Compare selects the MR's base and head in the graph and opens the compare", async () => {
      // !12's head is origin/dev's tip; GitLab's base, main's tip: their merge base is the FROM.
      const head = git(repo, 'rev-parse', 'origin/dev');
      const base = git(repo, 'merge-base', 'origin/main', 'origin/dev');
      const seed = await forgeSeed(request);
      // The review's commentable lines (spec 2026-10-08): GitLab's /diffs for !12 are this compare's
      // own, for its first file that adds lines.
      const file = git(repo, 'diff', '--numstat', base, head).split('\n').map((l) => l.split('\t')).find(([added]) => Number(added) > 0)![2]!;
      const patch = git(repo, 'diff', '-U3', base, head, '--', file);
      Object.assign(mrs(seed).find((x) => x.iid === 12)!, { headSha: head, baseSha: git(repo, 'rev-parse', 'origin/main'), diffs: [{ oldPath: file, newPath: file, diff: `${patch.slice(patch.indexOf('@@'))}\n` }] });
      await setForgeSeed(request, seed);
      await reopen();
      const bar = view.getByRole('region', { name: 'Branches' });
      // The new head loaded: the card counts what it brings.
      await expect(bar).toContainText('1 commit');
      await bar.getByRole('button', { name: 'Compare' }).click();
      const header = page.getByTestId('compare-header');
      await expect(header).toContainText(base.slice(0, 6));
      await expect(header).toContainText(head.slice(0, 6));
      await expect(graph.locator('[role="row"][aria-selected="true"]')).toHaveCount(2);
      // Its click didn't toggle the commit list.
      await expect(bar.getByRole('list', { name: 'Commits' })).toHaveCount(0);
    });

    await test.step("review mode: a line's + opens a comment, Add to review shows it Pending, Delete arms first (spec 2026-10-08 §2)", async () => {
      const base = git(repo, 'merge-base', 'origin/main', 'origin/dev');
      const head = git(repo, 'rev-parse', 'origin/dev');
      const file = git(repo, 'diff', '--numstat', base, head).split('\n').map((l) => l.split('\t')).find(([added]) => Number(added) > 0)![2]!;
      const patch = git(repo, 'diff', '-U3', base, head, '--', file);
      // The first added line's new number.
      let line = 0;
      for (const l of patch.split('\n')) {
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
        if (hunk) { line = Number(hunk[1]); continue; }
        if (!line) continue;
        if (l.startsWith('+')) break;
        if (!l.startsWith('-')) line++;
      }
      await page.locator(`[role="option"][data-path="${file}"], [role="treeitem"][data-path="${file}"]`).first().click();
      const panel = page.locator('.diff-panel');
      const markdown = panel.getByRole('group', { name: 'Markdown view' });
      if (file.endsWith('.md')) await markdown.getByRole('button', { name: 'Source' }).click();
      // The + comes with a pointer move once review mode is on (the forge's diff loaded, a moment
      // after the file opens): moved again until it shows.
      const at = panel.locator('.editor.modified .margin-view-overlays .line-numbers').filter({ hasText: new RegExp(`^${line}$`) });
      await expect(async () => {
        await at.hover({ position: { x: 1, y: 1 } });
        await at.hover();
        await expect(panel.locator('.review-glyph:visible')).toBeVisible({ timeout: 500 });
      }).toPass();
      await panel.locator('.review-glyph:visible').click();
      const box = panel.getByRole('form', { name: 'New comment' });
      await box.getByRole('textbox', { name: 'Comment' }).fill('Why this line?');
      await box.getByRole('button', { name: 'Add to review' }).click();
      await expect(box).toBeHidden();
      const pending = panel.getByRole('article', { name: 'Pending comment' });
      await expect(pending).toContainText('Pending');
      await expect(pending).toContainText('Why this line?');
      expect((await forgeRequests(request)).some((r) => r.method === 'POST' && r.path === '/api/v4/projects/42/merge_requests/12/draft_notes')).toBe(true);
      // The card stays right under its line through mode switches (only its spacer moves).
      const lineNo = panel.locator('.editor.modified .margin-view-overlays .line-numbers').filter({ hasText: new RegExp(`^${line}$`) });
      const gap = async () => {
        const [l, c] = [await lineNo.boundingBox(), await pending.boundingBox()];
        return l && c ? Math.round(c.y - (l.y + l.height)) : null;
      };
      const modes = page.getByRole('group', { name: 'View mode' });
      for (const mode of ['Split', 'Hunk', 'Inline']) {
        await modes.getByRole('button', { name: mode, exact: true }).click();
        await expect.poll(gap).toBeGreaterThanOrEqual(0);
        await expect.poll(gap).toBeLessThanOrEqual(12);
      }
      await pending.getByRole('button', { name: 'Delete' }).click();
      await confirmArmed(armedOverlay(page, 'Click again to delete the pending comment'));
      await expect(pending).toBeHidden();
      await expect.poll(async () => ((mrs(await forgeSeed(request)).find((x) => x.iid === 12) as { draftNotes?: unknown[] }).draftNotes ?? []).length).toBe(0);
      if (file.endsWith('.md')) await markdown.getByRole('button', { name: 'Rendered' }).click();
      await panel.getByRole('button', { name: 'Close diff' }).click();
      await expect(view).toBeVisible();
    });

    await test.step('GitLab Free keeps one reviewer: the toast names who it kept, then + swaps', async () => {
      const seed = await forgeSeed(request);
      (seed.gitlab as unknown as { projects: Array<Record<string, unknown>> }).projects.find((p) => p.id === 42)!.singlePeople = true;
      await setForgeSeed(request, seed);
      const people = view.getByRole('group', { name: 'Reviewers, assignees and labels' });
      await people.getByRole('button', { name: 'Add reviewer' }).click();
      await page.getByRole('combobox', { name: 'Reviewers' }).fill('gra');
      await page.getByRole('option', { name: /Grace Hopper/ }).click();
      await expect(page.getByText('GitLab kept only Ada Lovelace: this project allows one reviewer')).toBeVisible();
      await expect(people.getByRole('button', { name: 'Remove Grace Hopper' })).toBeHidden();
      // The search is still open after that pick; its button toggles, so close it before reopening.
      await page.keyboard.press('Escape');
      await expect(page.getByRole('combobox', { name: 'Reviewers' })).toBeHidden();
      await people.getByRole('button', { name: 'Replace reviewer' }).click();
      await page.getByRole('combobox', { name: 'Reviewers' }).fill('gra');
      await page.getByRole('option', { name: /Grace Hopper/ }).click();
      await expect(people.getByRole('button', { name: 'Remove Grace Hopper' })).toBeVisible();
      await expect(people.getByRole('button', { name: 'Remove Ada Lovelace' })).toBeHidden();
      await expect.poll(async () => mrs(await forgeSeed(request)).find((x) => x.iid === 12)!.reviewers).toEqual(['grace']);
    });

    await test.step('Review… comments through the composer', async () => {
      await view.getByRole('button', { name: 'Review…' }).click();
      const form = view.getByRole('form', { name: 'Review' });
      await form.getByRole('textbox', { name: 'Message' }).fill('One question below.');
      await form.getByRole('button', { name: 'Comment', exact: true }).click();
      await expect(form).toBeHidden();
      await expect(view.getByRole('region', { name: 'Activity' })).toContainText('One question below.');
    });
    await test.step("a comment's image and video open full size over the app; a video it can't play says so", async () => {
      const uploads = `/uploads/${'0123456789abcdef'.repeat(2)}`;
      const activity = view.getByRole('region', { name: 'Activity' });
      await view.getByRole('textbox', { name: 'Write a comment' }).fill(`Screenshot:\n\n![shot](${uploads}/shot.png)\n\n![clip](${uploads}/clip.webm){width=320 height=240}\n\n![screen](${uploads}/screen-hevc.mp4)`);
      await view.getByRole('button', { name: 'Comment', exact: true }).click();
      // The WebM plays inline (paused, metadata only); Playwright's Chromium has no HEVC.
      const clip = activity.locator('video[aria-label="clip"]');
      await expect.poll(() => clip.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(64);
      expect(await clip.evaluate((v: HTMLVideoElement) => [v.paused, v.autoplay, v.preload])).toEqual([true, false, 'metadata']);
      await expect(activity.getByText("This video's format (HEVC) can't play here")).toBeVisible();
      await expect(activity.getByRole('button', { name: 'Open with default app' })).toBeVisible();
      await clip.hover();
      await expect(activity.getByRole('button', { name: 'View full size' })).toBeVisible();
      // A click on the paused picture (above its controls) opens the viewer instead of playing here.
      await clip.click({ position: { x: 10, y: 5 } });
      const player = page.getByRole('dialog', { name: 'Video viewer: clip' });
      await expect(player).toBeVisible();
      await expect.poll(() => player.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime > 0 || !v.paused)).toBe(true);
      expect(await clip.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
      await page.keyboard.press('Escape');
      await expect(player).toBeHidden();

      const shot = activity.getByRole('img', { name: 'shot' });
      await expect.poll(() => shot.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
      await shot.click();
      const viewer = page.getByRole('dialog', { name: 'Image viewer: shot' });
      await expect(viewer).toBeVisible();
      await expect(viewer.getByTestId('lightbox-zoom')).toHaveText('100%');
      expect((await viewer.getByRole('img', { name: 'shot' }).boundingBox())!.width).toBeCloseTo(120, 0);
      await page.keyboard.press('+');
      await expect(viewer.getByTestId('lightbox-zoom')).toHaveText('110%');
      await page.keyboard.press('Escape');
      await expect(viewer).toBeHidden();
      // Esc closed the viewer only, and the focus is back on the image.
      await expect(view).toBeVisible();
      await expect(shot).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(viewer).toBeVisible();
      await page.mouse.click(5, 300);
      await expect(viewer).toBeHidden();
      await expect(view).toBeVisible();
    });
    // --- end MR round 2 ---

    // --- comment actions ---
    type Seeded = { iid: number; discussions: Array<{ id: string; resolved: boolean; notes: Array<{ body: string; awards: Array<{ name: string }> }> }> };
    const mr12 = async () => (mrs(await forgeSeed(request)) as unknown as Seeded[]).find((x) => x.iid === 12)!;
    await test.step('my comment: react 👍 (a pill of 1, mine), edit it, delete it', async () => {
      const activity = view.getByRole('region', { name: 'Activity' });
      const id = await activity.locator('.mr-note', { hasText: 'Thanks, merging soon.' }).getAttribute('data-note');
      const mine = activity.locator(`.mr-note[data-note='${id}']`);
      await mine.hover();
      await mine.getByRole('button', { name: 'Add reaction' }).click();
      await page.getByRole('dialog', { name: 'Add reaction' }).getByRole('button', { name: ':thumbsup:' }).click();
      await expect(mine.getByRole('button', { name: 'thumbsup: 1, yours' })).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(async () => (await mr12()).discussions.flatMap((d) => d.notes).find((n) => n.body === 'Thanks, merging soon.')?.awards.map((a) => a.name)).toEqual(['thumbsup']);
      await mine.hover();
      await mine.getByRole('button', { name: 'Comment actions' }).click();
      await page.getByRole('menuitem', { name: /Edit/ }).click();
      await mine.getByRole('textbox', { name: 'Edit comment' }).fill('Thanks, merging today.');
      await mine.getByRole('button', { name: 'Save' }).click();
      await expect(mine).toContainText('Thanks, merging today.');
      await expect(mine.getByRole('button', { name: 'thumbsup: 1, yours' })).toBeVisible();
      await mine.hover();
      await mine.getByRole('button', { name: 'Comment actions' }).click();
      await page.getByRole('menuitem', { name: /Delete/ }).click();
      await confirmArmed(page.getByRole('menuitem', { name: /Click again to delete the comment/ }));
      await expect(activity).not.toContainText('Thanks, merging today.');
    });
    await test.step("the thread's own system note sits in it; Reply and resolve: it rolls up, and unrolled the button is green", async () => {
      const activity = view.getByRole('region', { name: 'Activity' });
      // By its file:line, which shows rolled up too.
      const diff = activity.getByRole('article').filter({ has: page.getByRole('button', { name: 'README.md:2', exact: true }) });
      await expect(diff).toContainText('Why the second line?');
      await expect(diff.locator('.mr-thread-sys')).toContainText('Grace Hopper changed this line in version 2 of the diff');
      await expect(activity.locator('.mr-timeline > .mr-system', { hasText: 'changed this line' })).toHaveCount(0);
      await diff.getByRole('button', { name: 'Reply', exact: true }).click();
      await diff.getByRole('textbox', { name: 'Reply' }).fill('It documents the setup.');
      await diff.getByRole('button', { name: 'Reply and resolve' }).click();
      await expect.poll(async () => (await mr12()).discussions.find((d) => d.id === 'd2')?.notes.at(-1)?.body).toBe('It documents the setup.');
      // Resolved: rolled up whole, as GitLab's (who started it where, who resolved it, its replies).
      await expect(diff).toContainText('Grace Hopper started a thread on README.md:2');
      await expect(diff).toContainText(/Resolved .* by Ada Lovelace/);
      await expect(diff).not.toContainText('Why the second line?');
      await expect(diff.getByRole('button', { name: '1 reply' })).toHaveAttribute('aria-expanded', 'false');
      await expect(diff).not.toContainText('It documents the setup.');
      await expect(diff).toContainText('Last reply by Ada Lovelace');
      await expect.poll(async () => (await mr12()).discussions.find((d) => d.id === 'd2')?.resolved).toBe(true);
      await diff.getByRole('button', { name: 'Show the resolved thread' }).click();
      const resolved = diff.getByRole('button', { name: 'Unresolve thread' });
      await expect(resolved).toHaveAttribute('aria-pressed', 'true');
      await expect(resolved).toHaveClass(/\bon\b/);
      await expect(diff).toContainText('It documents the setup.');
      // The chevron kept the keyboard; the next step's Esc is the page's, as before.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    });
    // --- end comment actions ---

    // --- review comments (plan 3): the rendered diff, the file list's badge, the chip ---
    await test.step('a block comment in the rendered diff: the badge and the chip count it, Submit review… sends it', async () => {
      // !12 now brings a Markdown file too: a commit on origin/dev, its diff added to the Compare
      // step's seed.
      const blob = git({ cwd: repo, input: '# Review notes\n\nReadme\nSecond line\n' }, 'hash-object', '-w', '--stdin');
      const tree = git({ cwd: repo, input: `${git(repo, 'ls-tree', 'origin/dev')}\n100644 blob ${blob}\tNOTES.md\n` }, 'mktree');
      const head = git(repo, 'commit-tree', tree, '-p', 'origin/dev', '-m', 'Review notes');
      git(repo, 'update-ref', 'refs/remotes/origin/dev', head);
      const seed = await forgeSeed(request);
      const mr = mrs(seed).find((x) => x.iid === 12)!;
      Object.assign(mr, { headSha: head, diffs: [...(mr.diffs as unknown[]), { oldPath: 'NOTES.md', newPath: 'NOTES.md', diff: '@@ -0,0 +1,4 @@\n+# Review notes\n+\n+Readme\n+Second line\n' }] });
      await setForgeSeed(request, seed);
      // Esc first leaves the compare (the graph has the keys), then closes the view.
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('compare-header')).toBeHidden();
      await page.keyboard.press('Escape');
      await expect(view).toBeHidden();
      await page.getByRole('complementary', { name: 'Sidebar', exact: true }).getByRole('region', { name: 'Merge requests', exact: true }).getByRole('treeitem', { name: '!12 Dev work' }).click();
      const bar = view.getByRole('region', { name: 'Branches' });
      // The new head loaded: the card counts what it brings.
      await expect(bar).toContainText('2 commits');
      await bar.getByRole('button', { name: 'Compare' }).click();
      await expect(page.getByTestId('compare-header')).toContainText(head.slice(0, 6));

      const row = page.locator('.file-row[data-path="NOTES.md"]');
      await row.click();
      const pane = page.getByTestId('markdown-diff');
      // A real pointer's way to the "+": from the block, left across the gap to it, a frame per
      // step (Chromium coalesces the moves of one frame into one pointermove).
      const para = (await pane.locator('[data-src-new="3-4"]').first().boundingBox())!;
      const y = para.y + para.height / 2;
      await page.mouse.move(para.x + 20, y);
      const plus = pane.getByRole('button', { name: 'Comment on lines 3–4' });
      const at = (await plus.boundingBox())!;
      for (let x = para.x + 20; x > at.x + at.width / 2; x -= 3) {
        await page.mouse.move(x, y);
        await page.evaluate(() => new Promise(requestAnimationFrame));
        expect(await plus.count(), `the "+" at x=${x}`).toBe(1);
      }
      await page.mouse.click(at.x + at.width / 2, y);
      const box = pane.getByRole('form', { name: 'New comment' });
      await box.getByRole('textbox', { name: 'Comment' }).fill('Worth a sentence on why?');
      await box.getByRole('button', { name: 'Add to review' }).click();
      await expect(row.getByRole('button', { name: '1 pending' })).toBeVisible();
      const chip = page.getByRole('button', { name: 'Reviewing !12 · 1 pending' });
      await expect(chip).toBeVisible();

      await page.keyboard.press('Control+Alt+R');
      const submit = page.getByRole('dialog', { name: 'Submit your review of !12' });
      await submit.getByRole('button', { name: 'Comment', exact: true }).click();
      await expect(chip).toBeHidden();
      expect((await forgeRequests(request)).some((r) => r.method === 'POST' && r.path === '/api/v4/projects/42/merge_requests/12/draft_notes/bulk_publish')).toBe(true);
      // The file closes; the view comes back with the comment on its timeline.
      await page.locator('.diff-panel').getByRole('button', { name: 'Close diff' }).click();
      await expect(view.getByRole('region', { name: 'Activity' })).toContainText('Worth a sentence on why?');
    });

    const log = (await forgeRequests(request)).slice(logBefore);
    const mrCalls = log.filter((r) => r.path.includes('/merge_requests/12/'));
    expect(mrCalls.length).toBeGreaterThan(0);
    expect(mrCalls.every((r) => r.authorized === true)).toBe(true);
    expect(log.some((r) => r.method === 'POST' && r.path === '/api/v4/projects/42/merge_requests/12/notes')).toBe(true);
    expect(log.some((r) => r.method === 'POST' && r.path === '/api/v4/projects/42/merge_requests/12/approve')).toBe(true);
    expect(await page.content()).not.toContain(E2E_GITLAB_TOKEN);
    // Esc closes the view (after it leaves Compare's compare, when the graph has the keys).
    await expect(async () => {
      await page.keyboard.press('Escape');
      await expect(view).toBeHidden({ timeout: 500 });
    }).toPass({ timeout: 5000 });
  });

  test('the MR view docks beside the graph: both stay usable', async ({ page, request }) => {
    const repo = freshFixture('sync');
    git(repo, 'remote', 'set-url', 'origin', 'https://gitlab.example.com/group/project.git');
    await addForgeAccount(request, 'gitlab.example.com', 'gitlab', E2E_GITLAB_TOKEN);
    await page.goto(openUrl(repo));
    const graph = page.getByRole('grid', { name: 'Commit graph' });
    await expect(graph).toBeVisible();
    const sidebar = page.getByRole('complementary', { name: 'Sidebar', exact: true });
    await sidebar.getByRole('region', { name: 'Merge requests', exact: true }).getByRole('treeitem', { name: '!12 Dev work' }).click();
    const view = page.getByRole('dialog', { name: 'Merge request !12' });
    await expect(view).toContainText('Adds the dev work.');
    // The actions are on the status line.
    await expect(view.getByRole('region', { name: 'Summary' }).locator('.mr-line').getByRole('group', { name: 'Actions' })).toBeVisible();

    await view.getByRole('button', { name: 'Dock beside the graph' }).click();
    const undock = view.getByRole('button', { name: 'Undock (float over the graph)' });
    await expect(undock).toBeVisible();
    // Beside the graph, not over it.
    const [v, g] = [(await view.boundingBox())!, (await graph.boundingBox())!];
    expect(g.x).toBeGreaterThanOrEqual(v.x + v.width - 1);

    // A graph row while docked: the details follow, the view stays.
    const details = page.getByRole('complementary', { name: 'Commit details' });
    await graph.getByRole('row').filter({ hasText: 'Add readme' }).click();
    await expect(details).toContainText('Add readme');
    await expect(view).toBeVisible();
    await graph.getByRole('row').filter({ hasText: 'Initial commit' }).click();
    await expect(details).toContainText('Initial commit');
    await expect(view).toBeVisible();

    await test.step('docked narrow, the status line wraps and Check out, Edit and ⋯ stay at its right edge', async () => {
      const handle = page.getByRole('separator', { name: 'Resize the panel' });
      const h = (await handle.boundingBox())!;
      await page.mouse.move(h.x + h.width / 2, h.y + 200);
      await page.mouse.down();
      await page.mouse.move(h.x - 400, h.y + 200, { steps: 8 });
      await page.mouse.up();
      const line = view.locator('.mr-line').first();
      const [l, a] = [(await line.boundingBox())!, (await line.getByRole('group', { name: 'Actions' }).boundingBox())!];
      expect(a.y, 'on a row of their own').toBeGreaterThan(l.y + 4);
      expect(Math.abs(a.x + a.width - (l.x + l.width)), 'at the right edge').toBeLessThan(2);
    });

    await undock.click();
    await expect(view.getByRole('button', { name: 'Dock beside the graph' })).toBeVisible();
    const [v2, g2] = [(await view.boundingBox())!, (await graph.boundingBox())!];
    expect(g2.x).toBeLessThan(v2.x + v2.width);
  });

  test('Edit shows the form first: title, description, then reviewers, assignees and labels; the rest steps aside', async ({ page, request }) => {
    const repo = freshFixture('sync');
    git(repo, 'remote', 'set-url', 'origin', 'https://gitlab.example.com/group/project.git');
    await addForgeAccount(request, 'gitlab.example.com', 'gitlab', E2E_GITLAB_TOKEN);
    await page.goto(openUrl(repo));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    await page.getByRole('complementary', { name: 'Sidebar', exact: true }).getByRole('region', { name: 'Merge requests', exact: true }).getByRole('treeitem', { name: '!12 Dev work' }).click();
    const view = page.getByRole('dialog', { name: 'Merge request !12' });
    await expect(view).toContainText('Adds the dev work.');
    // GITBOLT_SHOT=<prefix> (a manual run): a screenshot of Edit in a narrow and a wide dock.
    const shot = async (size: 'narrow' | 'wide') => { if (process.env.GITBOLT_SHOT) await page.screenshot({ path: `${process.env.GITBOLT_SHOT}-${size}.png` }); };
    await view.getByRole('button', { name: 'Dock beside the graph' }).click();
    const handle = page.getByRole('separator', { name: 'Resize the panel' });
    const drag = async (dx: number) => {
      const h = (await handle.boundingBox())!;
      await page.mouse.move(h.x + h.width / 2, h.y + 200);
      await page.mouse.down();
      await page.mouse.move(h.x + dx, h.y + 200, { steps: 8 });
      await page.mouse.up();
    };
    const edit = view.getByRole('button', { name: 'Edit', exact: true });
    await drag(-400);
    await edit.click();
    await shot('narrow');
    await view.getByRole('button', { name: 'Cancel' }).click();
    await drag(800);
    await edit.click();
    await shot('wide');
    await view.getByRole('button', { name: 'Cancel' }).click();
    await edit.click();
    const form = view.getByRole('form', { name: 'Edit' });
    await expect(form.getByRole('textbox', { name: 'Title' })).toBeFocused();

    await test.step('only the header, the branches and the form; the people rows sit below the description', async () => {
      await expect(view.getByRole('region', { name: 'Activity' })).toBeHidden();
      await expect(view.getByRole('region', { name: 'Merge' })).toBeHidden();
      await expect(view.locator('.mr-facts')).toHaveCount(0);
      const [d, p] = [(await form.locator('.md-field').boundingBox())!, (await form.getByRole('group', { name: 'Reviewers, assignees and labels' }).boundingBox())!];
      expect(p.y).toBeGreaterThan(d.y + d.height - 1);
    });
    await test.step('Esc leaves Edit, back to the normal layout', async () => {
      await form.getByRole('textbox', { name: 'Title' }).press('Escape');
      await expect(form).toBeHidden();
      await expect(view.getByRole('region', { name: 'Activity' })).toBeVisible();
      await expect(view).toBeVisible();
    });
    await test.step("the Labels card's pencil opens Edit with the label picker open", async () => {
      await view.getByRole('button', { name: 'Edit labels' }).click();
      await expect(form).toBeVisible();
      await expect(page.getByRole('combobox', { name: /label/i })).toBeVisible();
    });
  });

  test("a sidebar row's menu: Copy link, then Check out a same-repository MR", async ({ page, request }) => {
    const repo = freshFixture('sync');
    git(repo, 'remote', 'set-url', 'origin', 'https://gitlab.example.com/group/project.git');
    await addForgeAccount(request, 'gitlab.example.com', 'gitlab', E2E_GITLAB_TOKEN);
    await page.goto(openUrl(repo));
    const sidebar = page.getByRole('complementary', { name: 'Sidebar', exact: true });
    const row = sidebar.getByRole('region', { name: 'Merge requests', exact: true }).getByRole('treeitem', { name: '!12 Dev work' });
    const menu = page.getByTestId('context-menu');
    const action = (label: string) => menu.locator('[data-depth="0"] > [role="menuitem"]').filter({ has: page.locator('.ctx-label').getByText(label, { exact: true }) });

    await row.click({ button: 'right' });
    await action('Copy link').click();
    await expect(page.getByRole('status')).toHaveText('Copied');
    if (test.info().project.name === 'chromium') {
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/group\/project\/-\/merge_requests\/12$/);
    }

    // `dev` already tracks origin/dev: Check out switches to it, and the row then says so.
    await row.click({ button: 'right' });
    await action('Check out').click();
    await expect(sidebar.getByRole('region', { name: 'Local', exact: true }).locator('.sb-item.is-head')).toHaveAttribute('aria-label', 'dev');
    await row.click({ button: 'right' });
    await expect(action('Checked out')).toHaveAttribute('aria-disabled', 'true');
  });
});
