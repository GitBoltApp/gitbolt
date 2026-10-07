import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { freshFixture, git, openUrl } from './fixtures';
import { expect, test } from './test';

/** A fresh `basic` fixture with one more commit adding `files`. */
function withFiles(files: Record<string, string>, message: string): string {
  const repo = freshFixture('basic');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, 'add', ...Object.keys(files));
  git(repo, 'commit', '-q', '-m', message);
  return repo;
}

type Pwned = { __pwned?: string[] };

// The app's Content Security Policy (crates/gitbolt-app/tauri.conf.json), which the e2e build is
// served under (vite.config.ts). The Markdown sanitizer keeps scripts out of a rendered document;
// the policy is the second layer, for a script that got past it.
test.describe('Content Security Policy', () => {
  test.use({ cspViolationsAllowed: true });

  test('the page is served with the strict policy, and a script injected into rendered Markdown never runs', async ({ page }) => {
    const repo = withFiles({ 'NOTES.md': '# Notes\n\n<script>(window.__pwned ||= []).push("markdown script")</script>\n\n<img src="data:," onerror="(window.__pwned ||= []).push(\'markdown onerror\')">\n\nText after.\n' }, 'Add notes');
    const violations: string[] = [];
    page.on('console', (m) => { if (m.text().startsWith('[csp-violation]')) violations.push(m.text()); });
    const response = await page.goto(openUrl(repo));
    const policy = response!.headers()['content-security-policy'];
    for (const directive of ["default-src 'self'", "script-src 'self' 'wasm-unsafe-eval' 'sha256-", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'", "media-src 'self' blob:"]) {
      expect(policy, directive).toContain(directive);
    }
    expect(policy).not.toContain("'unsafe-eval'");

    await page.getByRole('row').filter({ hasText: 'Add notes' }).first().click();
    await page.locator('[role="option"][data-path="NOTES.md"]').click();
    await page.getByRole('button', { name: 'File View' }).click();
    const md = page.getByTestId('markdown-file');
    await expect(md.getByRole('heading', { name: 'Notes' })).toBeVisible();
    await expect(md).toContainText('Text after.');
    // First layer: the sanitizer dropped the script and the handler.
    expect(await md.locator('script, [onerror]').count()).toBe(0);

    // Second layer: markup that got past the sanitizer into the rendered document still can't run.
    await md.evaluate((el) => {
      const s = document.createElement('script');
      s.textContent = '(window.__pwned ||= []).push("inline script")';
      el.append(s);
      el.insertAdjacentHTML('beforeend', '<img src="data:," onerror="(window.__pwned ||= []).push(\'inline handler\')">');
      const a = document.createElement('a');
      a.href = 'javascript:(window.__pwned ||= []).push("javascript: link")';
      el.append(a);
      a.click();
    });
    await expect.poll(() => violations.length).toBeGreaterThanOrEqual(2);
    expect(await page.evaluate(() => (window as Pwned).__pwned ?? [])).toEqual([]);
    expect(violations.some((v) => v.includes('script-src-elem'))).toBe(true);
    expect(violations.some((v) => v.includes('script-src-attr'))).toBe(true);
    // Nor can it load code from elsewhere, or embed a page.
    await md.evaluate((el) => {
      const s = document.createElement('script');
      s.src = 'https://evil.example/x.js';
      el.append(s);
      const o = document.createElement('object');
      o.data = 'https://evil.example/x.html';
      el.append(o);
    });
    await expect.poll(() => violations.filter((v) => v.includes('evil.example')).length).toBeGreaterThanOrEqual(2);
    expect(await page.evaluate(() => (window as Pwned).__pwned ?? [])).toEqual([]);
  });
});
