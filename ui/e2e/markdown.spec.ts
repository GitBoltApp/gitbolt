import type { Locator, Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { addForgeAccount, E2E_GITLAB_TOKEN, forgeRequests, forgeSeed, freshFixture, git, openUrl, setForgeSeed } from './fixtures';
import { bigMarkdown } from './markdownFixture';
import { expect, test } from './test';

const UPLOAD_HASH = '0123456789abcdef'.repeat(2); // the fake forge's upload dir (its UPLOAD_SECRET)

/** The pointer at an element's centre (a hovered chip floats its copy over the resting one, so a
 * click hovers first and then clicks the copy). */
async function pointAt(page: Page, el: Locator, click = false) {
  const centre = async () => {
    const box = (await el.boundingBox())!;
    return [box.x + box.width / 2, box.y + box.height / 2] as const;
  };
  await page.mouse.move(...(await centre()));
  if (click) await page.mouse.click(...(await centre()));
}

/** Records the longest main-thread task from now on (Chromium's Long Tasks API). */
async function watchLongTasks(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __longest: number };
    w.__longest = 0;
    new PerformanceObserver((list) => { for (const e of list.getEntries()) w.__longest = Math.max(w.__longest, e.duration); }).observe({ type: 'longtask' });
  });
}
const longestTask = (page: Page) => page.evaluate(() => (window as unknown as { __longest: number }).__longest);

/** The sync fixture on the fake GitLab, with `!12`'s description set to `description`. */
async function openWithDescription(page: Page, request: Parameters<typeof forgeSeed>[0], description: string, firstComment?: string, title?: string) {
  const repo = freshFixture('sync');
  git(repo, 'remote', 'set-url', 'origin', 'https://gitlab.example.com/group/project.git');
  const seed = await forgeSeed(request);
  const mrs = seed.gitlab.mergeRequests as Array<{ iid: number; title: string; description: string; discussions: Array<{ notes: Array<{ body: string }> }> }>;
  const mr = mrs.find((m) => m.iid === 12)!;
  mr.description = description;
  if (firstComment !== undefined) mr.discussions[0].notes[0].body = firstComment;
  if (title !== undefined) mr.title = title;
  await setForgeSeed(request, seed);
  await addForgeAccount(request, 'gitlab.example.com', 'gitlab', E2E_GITLAB_TOKEN);
  await page.goto(openUrl(repo));
  const badge = page.getByRole('grid', { name: 'Commit graph' }).getByRole('button', { name: 'Merge request !12: open' }).first();
  await expect(badge).toBeVisible();
  return badge;
}

test.describe('rendered Markdown in the MR/PR view (spec #5 §7)', () => {
  test('a description renders, its upload loads through the API, and its !ref opens the other MR in GitBolt', async ({ page, request }) => {
    const badge = await openWithDescription(page, request, `## What / why\n\nCaching follows !5.\n\n\`\`\`ts\nconst cached = true;\n\`\`\`\n\n![shot](/uploads/${UPLOAD_HASH}/shot.png)`);
    await pointAt(page, badge, true);
    const view = page.getByRole('dialog', { name: 'Merge request !12' });
    await expect(view.getByRole('heading', { name: 'What / why' })).toBeVisible();
    await expect(view.locator('.md-code')).toContainText('const cached = true;');
    const ref = view.getByRole('link', { name: '!5' });
    await ref.hover();
    await expect(page.getByRole('tooltip')).toHaveText('Open !5 in GitBolt');
    await expect.poll(async () => (await forgeRequests(request)).some((r) => r.path === `/api/v4/projects/42/uploads/${UPLOAD_HASH}/shot.png` && r.authorized)).toBe(true);
    await expect(view.getByRole('button', { name: /Load image from/ })).toHaveCount(0);
    await ref.click();
    await expect(page.getByRole('dialog', { name: 'Merge request !5' })).toBeVisible();
    expect(await page.content()).not.toContain(E2E_GITLAB_TOKEN);
  });

  test('a long code line in a comment scrolls inside its block, and a long title wraps; the panel never scrolls sideways', async ({ page, request }) => {
    const long = 'Unify the config-file lexer, parser and the standalone formatter so they share one tokenizer and stop drifting apart';
    const badge = await openWithDescription(page, request, 'Short.', `Try this:\n\n\`\`\`sh\necho ${'x'.repeat(400)}\n\`\`\``, long);
    await pointAt(page, badge, true);
    const view = page.getByRole('dialog', { name: 'Merge request !12' });
    const pre = view.locator('.mr-note-body pre').first();
    await expect(pre).toContainText('echo xxx');
    const widths = await pre.evaluate((el) => {
      const panel = el.closest('.flyout-body') as HTMLElement;
      return { pre: [el.scrollWidth, el.clientWidth], panel: [panel.scrollWidth, panel.clientWidth] };
    });
    expect(widths.pre[0]).toBeGreaterThan(widths.pre[1]);
    expect(widths.panel[0]).toBeLessThanOrEqual(widths.panel[1] + 1);
    // A long title wraps in the header: all of it shows, nothing is cut off.
    const title = view.locator('.flyout-title');
    await expect(title).toContainText('stop drifting apart');
    const t = await title.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight) }));
    expect(t.scroll).toBeLessThanOrEqual(t.client + 1);
    expect(t.height).toBeGreaterThan(t.line * 1.5);
  });

  test('the merge box keeps its height when the body overflows (a long description and activity)', async ({ page, request }) => {
    const long = Array.from({ length: 200 }, (_, i) => `Line ${i + 1} of a long description.`).join('\n\n');
    const badge = await openWithDescription(page, request, long);
    await pointAt(page, badge, true);
    const view = page.getByRole('dialog', { name: 'Merge request !12' });
    await expect(view.getByText('Line 200 of a long description.')).toBeAttached();
    const box = await view.locator('.mr-merge').boundingBox();
    expect(box?.height ?? 0).toBeGreaterThan(40);
    await expect(view.locator('.mr-merge').getByRole('button', { name: 'Merge' })).toBeVisible();
  });

  test('a 900 KB description renders progressively with no long task over 200 ms @budget', async ({ page, request }) => {
    const badge = await openWithDescription(page, request, bigMarkdown(900_000));
    await watchLongTasks(page);
    await pointAt(page, badge, true);
    const view = page.getByRole('dialog', { name: 'Merge request !12' });
    await expect(view.getByRole('heading', { name: 'Section 1', exact: true })).toBeVisible();
    // The last section is rendered (in the DOM; content-visibility may skip painting it).
    await expect(view.locator('.mr-description .md-rendering')).toHaveCount(0, { timeout: 20_000 });
    await expect(view.locator('.mr-description h2').last()).toHaveText(/^Section \d+$/);
    await view.locator('.mr-description').evaluate((el) => el.closest('.flyout-body')?.scrollBy(0, 100_000));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(await longestTask(page)).toBeLessThan(200);
  });

  test('a description over 1 MB stays plain text and opens with no long task over 200 ms @budget', async ({ page, request }) => {
    const badge = await openWithDescription(page, request, bigMarkdown(1_100_000));
    await watchLongTasks(page);
    await pointAt(page, badge, true);
    const view = page.getByRole('dialog', { name: 'Merge request !12' });
    await expect(view.locator('.mr-description .md-plain')).toBeVisible();
    await expect(view.getByRole('heading', { name: 'Section 1', exact: true })).toHaveCount(0);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(await longestTask(page)).toBeLessThan(200);
  });
});

// --- 5B: File View and navigation ---

/** A fresh `sync` fixture whose origin is the fake GitLab, with one more commit on main adding
 * `files` (no harness fixture: the files are this spec's own). */
function docsRepo(files: Record<string, string>, message: string): string {
  const repo = freshFixture('sync');
  git(repo, 'remote', 'set-url', 'origin', 'https://gitlab.example.com/group/project.git');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, 'add', ...Object.keys(files));
  git(repo, 'commit', '-q', '-m', message);
  return repo;
}

/** Selects the commit `summary`, opens its file `path`, and switches to File View. */
async function openInFileView(page: Page, summary: string, path: string) {
  await page.getByRole('row').filter({ hasText: summary }).first().click();
  await page.locator(`[role="option"][data-path="${path}"]`).click();
  await page.getByRole('button', { name: 'File View' }).click();
}

test.describe('Markdown and navigation history (spec #5 §7, 5B)', () => {
  test('a reference opens the other MR, mouse back returns; a relative link opens the other file, Alt+← returns', async ({ page, request }) => {
    const repo = docsRepo({
      'README.md': '# Readme\n\nSee the [guide](docs/guide.md).\n',
      'docs/guide.md': '# Guide\n\nBack to the [readme](../README.md).\n',
    }, 'Docs');
    const seed = await forgeSeed(request);
    const mrs = seed.gitlab.mergeRequests as Array<{ iid: number; description: string }>;
    mrs.find((m) => m.iid === 12)!.description = '## What / why\n\n```rust\nfn main() {}\n```\n\nFollows !5.';
    await setForgeSeed(request, seed);
    await addForgeAccount(request, 'gitlab.example.com', 'gitlab', E2E_GITLAB_TOKEN);
    await page.goto(openUrl(repo));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();

    // 1–2. Open !12: its description renders (a heading, a code block, a reference).
    const sidebar = page.getByRole('complementary', { name: 'Sidebar', exact: true });
    await sidebar.getByRole('region', { name: 'Merge requests', exact: true }).getByRole('treeitem', { name: '!12 Dev work' }).click();
    const first = page.getByRole('dialog', { name: 'Merge request !12' });
    const description = first.getByRole('region', { name: 'Description' });
    await expect(description.getByRole('heading', { name: 'What / why' })).toBeVisible();
    await expect(description.locator('pre')).toContainText('fn main() {}');
    // 3. The reference opens !5 in the app.
    await description.getByText('!5', { exact: true }).click();
    const second = page.getByRole('dialog', { name: 'Merge request !5' });
    await expect(second).toBeVisible();
    // 4. Mouse back (the side button: MouseEvent.button 3) returns to !12.
    await second.dispatchEvent('mouseup', { button: 3 });
    await expect(first).toBeVisible();
    await first.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(first).toBeHidden();

    // 5. A Markdown file opens rendered in File View.
    await openInFileView(page, 'Docs', 'README.md');
    const md = page.getByTestId('markdown-file');
    await expect(md.getByRole('heading', { name: 'Readme' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Markdown view' }).getByRole('button', { name: 'Rendered' })).toHaveAttribute('aria-pressed', 'true');
    // 6. A relative link opens the other file, rendered, at the same commit.
    await md.getByText('guide', { exact: true }).click();
    await expect(md.getByRole('heading', { name: 'Guide' })).toBeVisible();
    await expect(page.getByTestId('diff-path')).toContainText('docs/guide.md');
    // 7. Alt+← returns.
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(md.getByRole('heading', { name: 'Readme' })).toBeVisible();
    await expect(page.getByTestId('diff-path')).toContainText('README.md');
  });

  test('a 1 MB Markdown file renders with no main-thread task over 200 ms, or falls back to Source @budget', async ({ page }) => {
    const section = (i: number) => `## Section ${i}\n\nSome *emphasis*, a [link](#section-${i}), \`code\` and **bold** text.\n\n- one\n- two\n\n`;
    let big = '# Big\n\n';
    for (let i = 1; big.length < 1024 * 1024; i++) big += section(i);
    const repo = docsRepo({ 'small.md': '# Small\n', 'big.md': big }, 'Big docs');
    await page.goto(openUrl(repo));
    await expect(page.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    // Warm up: Monaco, Shiki and the Markdown chunk load with the small file.
    await openInFileView(page, 'Big docs', 'small.md');
    await expect(page.getByTestId('markdown-file').getByRole('heading', { name: 'Small' })).toBeVisible();
    // The big file's diff first, settled, so only File View's work is measured.
    await page.locator('[role="option"][data-path="big.md"]').click();
    await expect(page.getByTestId('diff-path')).toContainText('big.md');
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const w = window as unknown as { __long: number[] };
      w.__long = [];
      new PerformanceObserver((list) => { for (const e of list.getEntries()) w.__long.push(e.duration); }).observe({ type: 'longtask' });
    });
    await page.getByRole('button', { name: 'File View' }).click();
    const rendered = page.getByTestId('markdown-file').getByRole('heading', { name: 'Section 1', exact: true });
    const fellBack = page.getByRole('note').filter({ hasText: 'Too large to render' });
    await expect(rendered.or(fellBack)).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(500);
    const longest = await page.evaluate(() => Math.max(0, ...(window as unknown as { __long: number[] }).__long));
    if (!(await fellBack.isVisible())) expect(longest, 'longest main-thread task while File View rendered 1 MB of Markdown (ms)').toBeLessThanOrEqual(200);
  });
});
