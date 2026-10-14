import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { type Budgets, checkSite } from '../scripts/check-site.mjs';

type Files = Record<string, string | Uint8Array>;
const ROOT = '/nowhere/gitvolt-checkout';
const BASE = '/gitvolt/'; // a site under a path, the general case (gitvolt.com's is '/')
const rev = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex').slice(0, 12);
const shortSha = rev;
const webp = (n: number) => {
  const b = Buffer.alloc(n);
  b.write('RIFF', 0);
  b.write('WEBP', 8);
  return b;
};
const bundle = gzipSync(Buffer.from('GBDEMO1\n'));
const MANIFEST = JSON.stringify({ version: 1, repos: [{ name: 'orbital', file: 'orbital.gbdemo', group: null, open: 'active', rev: rev(bundle) }], groups: [] });
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'">`;

/** A small artefact that passes every check; `extra` adds or replaces files. */
function valid(extra: Files = {}): Files {
  return {
    'index.html':
      '<!doctype html><html><head>' + CSP + '<link rel="stylesheet" href="assets/site-a1b2c3d4.css"><link rel="canonical" href="https://www.example.com/"></head>' +
      '<body><nav><a href="#downloads">Download</a> <a href="https://github.com/ExampleOrg/example">Source</a></nav>' +
      '<img src="shots/graph.webp" width="800" height="500" alt=""><iframe src="demo/demo.html"></iframe><section id="downloads"></section></body></html>',
    'assets/site-a1b2c3d4.css': 'body{background:url(../shots/graph.webp)} i{background:url("data:image/svg+xml,%3Csvg%3E")}',
    'shots/graph.webp': webp(1000),
    '404.html': '<!doctype html><html data-gitvolt-404><head>' + CSP + '</head><body><a href="/gitvolt/">Home</a></body></html>',
    'demo/demo.html': '<!doctype html><html><head>' + CSP + '<script type="module" src="./assets/demo-a1b2c3d4.js"></script></head><body></body></html>',
    'demo/assets/demo-a1b2c3d4.js': `console.log("${shortSha(MANIFEST)}")`,
    'demo/assets/gitvolt_graph_wasm_bg.wasm-Ab12Cd34.gz': gzipSync(Buffer.from('\0asm')),
    'demo/demo-data/manifest.json': MANIFEST,
    'demo/demo-data/orbital.gbdemo': bundle,
    ...extra,
  };
}

function site(files: Files): string {
  const dir = mkdtempSync(join(tmpdir(), 'site-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

const check = (files: Files, budgets: Partial<Budgets> = {}) => checkSite(site(files), { root: ROOT, base: BASE, budgets }).errors;

test('a complete site passes, and the report gives its sizes', () => {
  const { errors, report } = checkSite(site(valid()), { root: ROOT, base: BASE });
  expect(errors).toEqual([]);
  expect(report).toEqual(expect.arrayContaining([expect.stringMatching(/^the demo's bundles: .+ of 15\.00 MB$/)]));
});

test('resources from another site are refused; links to other sites are fine', () => {
  const errors = check(valid({
    'index.html':
      '<!doctype html><html><head>' + CSP + '<script src="https://cdn.example.com/a.js"></script><link rel="stylesheet" href="//fonts.example.com/f.css"></head>' +
      '<body><a href="https://www.example.com/">elsewhere</a><img src="shots/graph.webp" srcset="shots/graph.webp 1x, https://img.example.com/2x.webp 2x" width="1" height="1" alt=""></body></html>',
    'assets/site-a1b2c3d4.css': '@import "https://fonts.example.com/x.css"; body{background:url(https://img.example.com/b.png)}',
  }));
  expect(errors).toEqual(expect.arrayContaining([
    'index.html: loads https://cdn.example.com/a.js from another site',
    'index.html: loads //fonts.example.com/f.css from another site',
    'index.html: loads https://img.example.com/2x.webp from another site',
    'assets/site-a1b2c3d4.css: loads https://fonts.example.com/x.css from another site',
    'assets/site-a1b2c3d4.css: loads https://img.example.com/b.png from another site',
  ]));
  expect(errors).toHaveLength(5);
});

test('internal links and fragments resolve', () => {
  const errors = check(valid({
    'index.html':
      '<!doctype html><html><head>' + CSP + '</head><body><a href="features.html">F</a><a href="#pricing">P</a><a href="/elsewhere/">E</a>' +
      '<img src="shots/none.webp" width="1" height="1" alt=""><a href="demo/demo.html#top">D</a><a href="/gitvolt/demo/demo.html">ok</a></body></html>',
  }));
  expect(errors).toEqual(expect.arrayContaining([
    "index.html: features.html doesn't resolve",
    'index.html: #pricing: no id "pricing" in index.html',
    'index.html: /elsewhere/ is outside /gitvolt/',
    "index.html: shots/none.webp doesn't resolve",
    'index.html: demo/demo.html#top: no id "top" in demo/demo.html',
  ]));
  expect(errors).toHaveLength(5);
});

test('404 links are absolute: the page is served at any missing path', () => {
  const errors = check(valid({ '404.html': '<!doctype html><html data-gitvolt-404><head>' + CSP + '</head><body><a href="index.html">Home</a><a href="/gitvolt/">Home</a></body></html>' }));
  expect(errors).toEqual(["404.html: index.html is relative (it's served at any missing path: use /gitvolt/…)"]);
});

test("inline blocks need their page's Content-Security-Policy", () => {
  const h = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
  const page = (styleSrc: string, body: string) => `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src ${styleSrc}">${body}</head><body></body></html>`;
  expect(check(valid({ 'index.html': page(h('a{}'), '<style>a{}</style><style>b{}</style>') }))).toEqual(['index.html: an inline <style> its Content-Security-Policy blocks']);
  expect(check(valid({ 'index.html': page("'unsafe-inline'", '<style>b{}</style>') }))).toEqual([]);
  // A hash turns 'unsafe-inline' off, as in browsers.
  expect(check(valid({ 'index.html': page(`'unsafe-inline' ${h('a{}')}`, '<style>b{}</style>') }))).toEqual(['index.html: an inline <style> its Content-Security-Policy blocks']);
  // Scripts fall back to default-src; JSON data blocks don't run.
  expect(check(valid({ 'index.html': page("'self'", '<script>let x = 1</script><script type="application/json">{}</script>') }))).toEqual(['index.html: an inline <script> its Content-Security-Policy blocks']);
});

test("the demo's data: listed, gzip, with the rev of its bytes, and nothing else", () => {
  const manifest = JSON.stringify({
    version: 1,
    repos: [
      { name: 'orbital', file: 'orbital.gbdemo', rev: '000000000000' },
      { name: 'basic', file: 'basic.gbdemo', rev: 'x' },
      { name: 'sync', file: 'sync.gbdemo' },
    ],
    groups: [],
  });
  const errors = check(valid({
    'demo/demo-data/manifest.json': manifest,
    'demo/assets/demo-a1b2c3d4.js': `//${shortSha(manifest)}`,
    'demo/demo-data/sync.gbdemo': Buffer.from('plain'),
    'demo/demo-data/stray.gbdemo': gzipSync(Buffer.from('stray')),
  }));
  expect(errors).toEqual(expect.arrayContaining([
    `demo/demo-data/orbital.gbdemo: rev 000000000000 doesn't match its bytes (${rev(bundle)})`,
    'demo/demo-data/basic.gbdemo: missing (listed in the manifest)',
    'demo/demo-data/sync.gbdemo: not gzip',
    'demo/demo-data/sync.gbdemo: no rev in the manifest (the demo build adds it)',
    'demo/demo-data/stray.gbdemo: not in the manifest',
  ]));
  expect(errors).toHaveLength(5);
});

test('the budgets', () => {
  const errors = check(valid({ 'assets/icons.ttf': Buffer.alloc(20), 'shots/big.webp': webp(200) }), { bundles: 10, demoCode: 10, rawBinaries: 10, image: 100, site: 10 });
  expect(errors).toEqual(expect.arrayContaining([
    expect.stringMatching(/^the demo's bundles: .+, over the .+ budget$/),
    expect.stringMatching(/^the demo's code \(gzip\): .+, over the .+ budget$/),
    expect.stringMatching(/^binaries Pages sends uncompressed: .+, over the .+ budget$/),
    expect.stringMatching(/^the site outside the demo: .+, over the .+ budget$/),
  ]));
  expect(errors.filter((e) => /^shots\/(big|graph)\.webp: .+ budget for an image$/.test(e))).toHaveLength(2);
  expect(errors).toHaveLength(6);
});

test('an image outside the demo needs its width and height (no layout shift)', () => {
  const errors = check(valid({
    'index.html': '<!doctype html><html><head>' + CSP + '</head><body><img src="shots/graph.webp" alt=""></body></html>',
    'demo/demo.html': '<!doctype html><html><head>' + CSP + '<script type="module" src="./assets/demo-a1b2c3d4.js"></script></head><body><img src="../shots/graph.webp" alt=""></body></html>',
  }));
  expect(errors).toEqual(['index.html: <img src="shots/graph.webp"> has no width and height (layout shift)']);
});

test('missing pages, dotfiles, source maps, the WebAssembly and build paths', () => {
  const files = valid({ '.nojekyll': '', 'assets/a.js.map': '{}', 'assets/leak.js': `//# ${ROOT}/ui/src/x.ts` });
  delete files['404.html'];
  delete files['demo/assets/gitvolt_graph_wasm_bg.wasm-Ab12Cd34.gz'];
  const errors = check(files);
  expect(errors).toEqual(expect.arrayContaining([
    '404.html: missing',
    '.nojekyll: a dotfile (upload-pages-artifact leaves it out)',
    'assets/a.js.map: a source map (not published)',
    'demo/: no gzipped WebAssembly under a hashed name (gitvolt_graph_wasm_bg.wasm-<hash>.gz)',
    `assets/leak.js: contains the build machine's path ${ROOT}`,
  ]));
  expect(errors).toHaveLength(5);
});

test('the real 404 page passes, at the domain root by default', () => {
  const real = readFileSync(fileURLToPath(new URL('../../site/404.html', import.meta.url)), 'utf8');
  expect(real).toContain('data-gitvolt-404');
  expect(checkSite(site(valid({ '404.html': real })), { root: ROOT }).errors).toEqual([]);
});

test('every page needs a Content-Security-Policy with no host or scheme source', () => {
  const page = (content: string) => `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${content}"></head><body></body></html>`;
  expect(check(valid({ 'index.html': '<!doctype html><html><head></head><body></body></html>' }))).toEqual(['index.html: no Content-Security-Policy <meta http-equiv>']);
  const errors = check(valid({ 'index.html': page("default-src 'self'; img-src 'self' https://cdn.example.com data:; connect-src *; frame-src http:; base-uri 'none'") }));
  expect(errors).toEqual([
    "index.html: Content-Security-Policy img-src lists https://cdn.example.com (only 'self', hashes, data: and the like)",
    "index.html: Content-Security-Policy connect-src lists * (only 'self', hashes, data: and the like)",
    "index.html: Content-Security-Policy frame-src lists http: (only 'self', hashes, data: and the like)",
  ]);
});

test('inline styles and style attributes load nothing from another site; <base> stays on the site', () => {
  const errors = check(valid({
    'index.html': '<!doctype html><html><head>' + CSP + '<base href="https://www.example.com/"><style>@import "https://a.example.com/x.css"; b{background:url(https://b.example.com/i.png)}</style></head>' +
      '<body><p style="background:url(\'//c.example.com/i.png\')"></p><p style="background:url(data:image/png;base64,AA)"></p></body></html>',
    'demo/demo.html': '<!doctype html><html><head>' + CSP + '<base href="/elsewhere/"></head><body></body></html>',
  }));
  expect(errors).toEqual(expect.arrayContaining([
    'index.html: loads https://a.example.com/x.css from another site',
    'index.html: loads https://b.example.com/i.png from another site',
    'index.html: loads //c.example.com/i.png from another site',
    'index.html: <base href="https://www.example.com/"> isn\'t on the site',
    'demo/demo.html: <base href="/elsewhere/"> isn\'t on the site',
  ]));
  expect(errors).toHaveLength(5);
  expect(check(valid({ 'demo/demo.html': '<!doctype html><html><head>' + CSP + '<base href="/gitvolt/demo/"></head><body></body></html>' }))).toEqual([]);
});

test("the manifest's rev is compiled into the demo's code", () => {
  const errors = check(valid({ 'demo/assets/demo-a1b2c3d4.js': 'console.log(1)' }));
  expect(errors).toEqual([`demo/demo-data/manifest.json: its rev ${shortSha(MANIFEST)} isn't in demo/assets/*.js (the build compiles it in)`]);
});
