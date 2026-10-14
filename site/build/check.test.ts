import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { checkPage, expectedPlaceholders, firstLoadFiles, PAGE_BUDGETS } from './check.ts';
import { SHOTS } from './shots.ts';

const SOCIAL = '<meta property="og:image" content="https://gitvolt.com/og.jpg"><meta name="twitter:image" content="https://gitvolt.com/og.jpg">';
const GOOD = `<!doctype html><html><head>${SOCIAL}<link rel="stylesheet" href="./assets/site.css"><script type="module" src="./assets/main.js"></script></head>
<body><img class="still" src="./assets/hero-1x.webp" srcset="./assets/hero-1x.webp 1240w, ./assets/hero.webp 2480w" width="1240" height="775" alt="The app">
<img src="./assets/graph-1x.webp" width="720" height="450" alt="A graph" loading="lazy"></body></html>`;

function page(html = GOOD, extra: Record<string, string | Buffer> = {}): string {
  const dist = mkdtempSync(join(tmpdir(), 'site-check-'));
  mkdirSync(join(dist, 'assets'));
  const files: Record<string, string | Buffer> = {
    'index.html': html,
    'assets/site.css': 'body{background:url(./bands.svg)}@font-face{src:url(./face.woff2) format("woff2"),url(./face.woff) format("woff")}',
    'assets/bands.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'assets/face.woff2': Buffer.alloc(1000),
    'assets/face.woff': Buffer.alloc(3000),
    'assets/main.js': 'console.log(1)',
    'assets/hero-1x.webp': Buffer.alloc(100),
    'assets/hero.webp': Buffer.alloc(400),
    'assets/graph-1x.webp': Buffer.alloc(100),
    'og.jpg': Buffer.alloc(100),
    ...extra,
  };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dist, name), body);
  return dist;
}

const card = (alt: string) => `<figure class="shot"><div class="shot-in"><span class="shot-tag">Screenshot</span><span class="shot-cap">${alt}</span></div></figure>`;

test('a sound page passes, with its budgets reported', () => {
  const r = checkPage(page());
  expect(r.errors).toEqual([]);
  expect(r.warnings).toEqual([]);
  expect(r.budgets.map((b) => b.name)).toEqual(['firstLoad', 'pageJs', 'pageCss']);
});

test("the first load: the page, its script and CSS, the CSS's art and fonts (woff2 only), the hero's largest image; not lazy images", () => {
  expect(firstLoadFiles(page(), GOOD).sort()).toEqual(['assets/bands.svg', 'assets/face.woff2', 'assets/hero.webp', 'assets/main.js', 'assets/site.css', 'index.html']);
});

test('a marker left unfilled is an error; a screenshot not taken yet a warning', () => {
  const html = GOOD.replace('</body>', `<!--readme:groups-->${card('A stack')}</body>`);
  const r = checkPage(page(html));
  expect(r.errors).toEqual(['index.html: <!--readme:groups--> was never filled']);
  expect(r.warnings).toEqual(['no screenshot yet: "A stack" (just site-shots)']);
});

test('over a budget is an error naming it', () => {
  const r = checkPage(page(GOOD, { 'assets/hero.webp': Buffer.alloc(2000) }), { ...PAGE_BUDGETS, firstLoad: 1500 });
  expect(r.errors).toEqual([expect.stringMatching(/^firstLoad: \d+ bytes, over its 1500$/)]);
});

test("a link preview's image must be there, absolute, and a file of the build under the base", () => {
  expect(checkPage(page(GOOD.replace(SOCIAL, ''))).errors).toEqual([
    'index.html: no og:image <meta> (link previews would have no image)',
    'index.html: no twitter:image <meta> (link previews would have no image)',
  ]);
  expect(checkPage(page(GOOD.replace(SOCIAL, SOCIAL.replaceAll('https://gitvolt.com/', './')))).errors).toEqual([
    'index.html: og:image "./og.jpg" isn\'t an absolute https URL',
    'index.html: twitter:image "./og.jpg" isn\'t an absolute https URL',
  ]);
  const under = page(GOOD.replace(SOCIAL, SOCIAL.replaceAll('gitvolt.com/', 'gitvoltapp.github.io/gitvolt/')));
  expect(checkPage(under, PAGE_BUDGETS, { base: '/gitvolt/' }).errors).toEqual([]);
  expect(checkPage(under).errors).toEqual([
    'index.html: og:image "https://gitvoltapp.github.io/gitvolt/og.jpg" isn\'t a file in the build (base /)',
    'index.html: twitter:image "https://gitvoltapp.github.io/gitvolt/og.jpg" isn\'t a file in the build (base /)',
  ]);
});

const COVERAGE = "export const PENDING = [\n  'undo', 'push',\n] as const satisfies readonly Method[];";
const SPEC = "{ id: 'worktrees', needs: [], run }, { id: 'review', needs: ['push'], run }, { id: 'image', needs: [], run },";

test('expected placeholders come from the scenes whose methods are pending, or that do not exist yet', () => {
  const e = expectedPlaceholders(SPEC, COVERAGE);
  expect([...e].sort()).toEqual(['hero', 'markdown', 'menus', 'previews', 'rebase', 'review', 'stack', 'undo']);
  expect(expectedPlaceholders(SPEC, "export const PENDING = [] as const")).not.toContain('review');
});

test('a placeholder is a warning when expected and an error otherwise', () => {
  const html = GOOD.replace('</body>', `${card(SHOTS.review.alt)}${card(SHOTS.image.alt)}</body>`);
  const r = checkPage(page(html), PAGE_BUDGETS, { expected: expectedPlaceholders(SPEC, COVERAGE) });
  expect(r.warnings).toEqual([`no screenshot yet: "${SHOTS.review.alt}" (just site-shots)`]);
  expect(r.errors).toEqual([expect.stringContaining(SHOTS.image.alt)]);
});

test('the header button must reserve the width of its longest label', () => {
  const html = GOOD.replace('<body>', '<body><a class="cta">Download <small class="cta-os"></small></a>');
  expect(checkPage(page(html)).errors).toEqual([expect.stringContaining('reserve')]);
  const css = '.cta small::before{content:"for Windows";visibility:hidden}';
  expect(checkPage(page(html, { 'assets/site.css': css })).errors).toEqual([]);
  const sized = GOOD.replace('<body>', '<body><a class="cta"><span class="cta-in">Download <small class="cta-os"></small></span><span class="cta-size" aria-hidden="true">Download <small>for Windows</small></span></a>');
  expect(checkPage(page(sized)).errors).toEqual([]);
});
