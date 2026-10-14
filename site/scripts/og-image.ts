// The site's social-sharing image (`just site-og`): site/og/og.html in headless Chromium, saved as
// the PNG named on the command line, which scripts/site-og.py turns into site/public/og.jpg (served
// unhashed at the site's root; build/social.ts points og:image at it).
// The page loads only the site's own files, through a made-up origin routed to site/: a request
// for anything else, or a file that's missing, fails the run, as does a font that didn't load.
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { OG_IMAGE } from '../build/social.ts';

const site = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2];
if (!out?.endsWith('.png')) throw new Error('usage: node site/scripts/og-image.ts <out.png>');
const ORIGIN = 'http://og.invalid/';
const TYPES: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff',
};

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: OG_IMAGE.width, height: OG_IMAGE.height }, deviceScaleFactor: 1, colorScheme: 'dark' });
  const failed: string[] = [];
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    const path = url.startsWith(ORIGIN) ? normalize(join(site, decodeURIComponent(new URL(url).pathname))) : '';
    if (!path.startsWith(site)) {
      failed.push(`not the site's: ${url}`);
      return route.abort();
    }
    try {
      await route.fulfill({ body: readFileSync(path), contentType: TYPES[extname(path)] ?? 'application/octet-stream' });
    } catch {
      failed.push(`missing: ${path}`);
      await route.abort();
    }
  });
  await page.goto(`${ORIGIN}og/og.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const fonts = await page.evaluate(() => ['800 64px Sora', '700 50px Sora', '500 25px Inter'].filter((f) => !document.fonts.check(f)));
  if (fonts.length) failed.push(`fonts not loaded: ${fonts.join(', ')}`);
  if (failed.length) throw new Error(`og-image: ${failed.join('; ')}`);
  await page.screenshot({ path: out, type: 'png' });
} finally {
  await browser.close();
}
