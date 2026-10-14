// Checks the GitHub Pages artefact before it's deployed (scripts/site-pages.sh builds it into
// site/dist/ and runs this; .github/workflows/site.yml runs both): what a visitor's browser loads
// from it, and what GitHub Pages does with it. See docs/website.md.
//
// - The pages are there (index.html, 404.html, demo/demo.html and the demo's manifest), with no
//   dotfile (upload-pages-artifact leaves them out) and no source map.
// - No third-party requests (PRIVACY.md): every resource a page or stylesheet loads is on the site
//   (or a data: URL). Links to other sites are fine: they load nothing.
// - Internal links and #fragments resolve. The 404 page is served at any missing path, so its
//   links must be absolute (<base>…).
// - Every page carries a Content-Security-Policy <meta> with no host or scheme source (only 'self',
//   'none', hashes, nonces, data:, blob:, 'unsafe-inline', 'wasm-unsafe-eval'), and allows its own
//   inline <style> and <script> blocks. Inline styles and <base href> are held to the same
//   no-other-site rule as the rest.
// - Pages serves every file with a 10-minute cache: each bundle the demo's manifest lists carries
//   the rev of its bytes (ui/build/demoDataRev.ts), the manifest's own rev is compiled into the
//   demo's code, and the WebAssembly has a hashed name.
// - <img> outside the demo has a width and height (no layout shift).
// - Sizes: the bundles (spec §4.5), the demo's code at gzip size (Pages gzips text), binaries Pages
//   sends uncompressed, each image, and the site outside the demo.
// - No text file holds the build machine's checkout path.
//
// HTML is read with regular expressions: enough for the pages Vite and site/ produce (an attribute
// value holding '>' would end its tag early).
//
//   node ui/scripts/check-site.mjs [--base /] <dist>
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const BUDGETS = {
  bundles: 15_000_000, // all the demo's data bundles (spec §4.5)
  demoCode: 9_100_000, // the demo's code at gzip size: the app's UI (6.1 MB, measured 2026-10-13) + 3 MB (spec §4.5)
  rawBinaries: 1_000_000, // binaries Pages sends as they are (pdf.js's WebAssembly, Monaco's icon font)
  image: 500_000, // each image outside the demo
  site: 10_000_000, // everything outside the demo
};

// What Pages gzips on the fly (spec §5.3, checked 2026-10-12); everything else goes as it is.
const TEXT = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.xml', '.webmanifest']);
const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.svg', '.ico']);
// Elements and the attributes through which they load something.
const LOADS = {
  script: ['src'], img: ['src', 'srcset'], source: ['src', 'srcset'], iframe: ['src'], frame: ['src'],
  video: ['src', 'poster'], audio: ['src'], track: ['src'], embed: ['src'], object: ['data'], input: ['src'],
  image: ['href', 'xlink:href'], use: ['href', 'xlink:href'],
};
// <link rel> values that load their href (canonical, alternate and the like don't).
const LINK_LOADS = new Set(['stylesheet', 'preload', 'modulepreload', 'prefetch', 'icon', 'apple-touch-icon', 'mask-icon', 'manifest', 'preconnect', 'dns-prefetch']);
const DATA = 'demo/demo-data';
const WASM = /(^|\/)gitvolt_graph_wasm_bg\.wasm-[\w-]{6,}\.gz$/;

const ext = (p) => posix.extname(p).toLowerCase();
const sha256 = (bytes, encoding) => createHash('sha256').update(bytes).digest(encoding);
const fmt = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)} MB` : `${Math.ceil(n / 1000)} KB`);
const isGzip = (b) => b[0] === 0x1f && b[1] === 0x8b;

/** Whether `b` is in a format that's compressed already (Pages sends binaries as they are). */
function compressedFormat(b) {
  const at = (i, s) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  return isGzip(b) || at(0, 'wOF2') || at(0, 'wOFF') || at(1, 'PNG') || (b[0] === 0xff && b[1] === 0xd8)
    || at(0, 'GIF8') || (at(0, 'RIFF') && at(8, 'WEBP')) || at(4, 'ftyp') || at(0, 'OggS')
    || (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) || at(0, 'PK\x03\x04');
}

/** Every file under `dir`, as sorted '/'-separated paths relative to it. */
function walk(dir, rel = '') {
  const out = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, p));
    else out.push(p);
  }
  return out.sort();
}

function attrs(s) {
  const out = {};
  for (const m of s.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? '').replaceAll('&amp;', '&');
  }
  return out;
}

/** A page's tags (outside comments and <script>/<style> bodies), its inline blocks, its CSP. */
function parseHtml(html) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  const inline = [];
  for (const m of clean.matchAll(/<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)) {
    const a = attrs(m[2]);
    const kind = m[1].toLowerCase();
    if (kind === 'script' && (a.src !== undefined || !['', 'module', 'text/javascript', 'application/javascript'].includes((a.type ?? '').toLowerCase()))) continue;
    inline.push({ kind, body: m[3] });
  }
  const bare = clean.replace(/(<(script|style)\b[^>]*>)[\s\S]*?(<\/\2\s*>)/gi, '$1$3');
  const tags = [...bare.matchAll(/<([a-zA-Z][a-zA-Z0-9:-]*)\b([^>]*)>/g)].map((m) => ({ name: m[1].toLowerCase(), attrs: attrs(m[2]) }));
  const meta = tags.find((t) => t.name === 'meta' && (t.attrs['http-equiv'] ?? '').toLowerCase() === 'content-security-policy');
  const csp = meta
    ? Object.fromEntries((meta.attrs.content ?? '').split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([n, ...v]) => [n.toLowerCase(), v]))
    : null;
  return { tags, inline, csp };
}

/** Whether `csp` lets an inline <kind> block with `body` run or apply, as browsers decide. */
function inlineAllowed(csp, kind, body) {
  if (!csp) return true;
  const sources = csp[`${kind}-src-elem`] ?? csp[`${kind}-src`] ?? csp['default-src'];
  if (!sources) return true;
  // A hash or nonce turns 'unsafe-inline' off.
  if (!sources.some((s) => /^'(sha(256|384|512)|nonce)-/.test(s))) return sources.includes("'unsafe-inline'");
  return sources.includes(`'sha256-${sha256(body, 'base64')}'`);
}

/** The urls a stylesheet's text loads: url() and @import. */
function cssRefs(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [
    ...[...text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/g)].map((m) => m[1] ?? m[2] ?? m[3]),
    ...[...text.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/g)].map((m) => m[1] ?? m[2]),
  ].filter((u) => u && !u.startsWith('#'));
}

/** The CSP source expressions that name a host or a scheme (or *): the ones that reach other sites. */
function cspReach(csp) {
  const ok = /^('self'|'none'|'unsafe-inline'|'wasm-unsafe-eval'|'sha(256|384|512)-[^']+'|'nonce-[^']+'|data:|blob:)$/;
  return Object.entries(csp).flatMap(([name, sources]) => sources.filter((s) => !ok.test(s)).map((s) => [name, s]));
}

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Where `url`, on the page or stylesheet `from`, points. */
function locate(url, from, base) {
  if (/^(data|blob|about):/i.test(url)) return { kind: 'inline' };
  if (url.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(url)) return { kind: 'external' };
  const hash = url.indexOf('#');
  const frag = hash >= 0 ? decode(url.slice(hash + 1)) : '';
  const path = (hash >= 0 ? url.slice(0, hash) : url).split('?')[0];
  let p;
  if (path === '') p = from;
  else if (path.startsWith('/')) {
    if (!path.startsWith(base)) return { kind: 'outside' };
    p = path.slice(base.length) || 'index.html';
  } else p = posix.join(posix.dirname(from), path);
  p = posix.normalize(decode(p));
  if (p === '..' || p.startsWith('../')) return { kind: 'outside' };
  if (p === '.' || p.endsWith('/')) p = posix.join(p, 'index.html');
  return { kind: 'site', path: p, frag, relative: path !== '' && !path.startsWith('/') };
}

export function checkSite(dist, { base = '/', root = REPO_ROOT, budgets = {} } = {}) {
  const max = { ...BUDGETS, ...budgets };
  const errors = [];
  const report = [];
  const all = walk(dist);
  const have = new Set(all);
  const read = (p) => readFileSync(join(dist, p));
  const found = (p) => have.has(p) || have.has(`${p}/index.html`);
  const pageOf = (p) => (have.has(p) ? p : `${p}/index.html`);

  for (const p of ['index.html', '404.html', 'demo/demo.html', `${DATA}/manifest.json`]) if (!have.has(p)) errors.push(`${p}: missing`);
  for (const p of all) {
    if (p.split('/').some((s) => s.startsWith('.'))) errors.push(`${p}: a dotfile (upload-pages-artifact leaves it out)`);
    if (p.endsWith('.map')) errors.push(`${p}: a source map (not published)`);
  }

  const cssRef = (file, url) => {
    const at = locate(url, file, base);
    if (at.kind === 'inline') return;
    if (at.kind === 'external') errors.push(`${file}: loads ${url} from another site`);
    else if (at.kind === 'outside' || !found(at.path)) errors.push(`${file}: ${url} doesn't resolve`);
  };

  // Pages: what they load, where they link, their inline blocks.
  const pages = new Map(all.filter((p) => ext(p) === '.html').map((p) => [p, parseHtml(read(p).toString('utf8'))]));
  const ids = (p) => new Set((pages.get(p)?.tags ?? []).flatMap((t) => [t.attrs.id, t.name === 'a' ? t.attrs.name : undefined]).filter(Boolean));
  for (const [page, { tags, inline, csp }] of pages) {
    if (!csp) errors.push(`${page}: no Content-Security-Policy <meta http-equiv>`);
    else for (const [name, src] of cspReach(csp)) errors.push(`${page}: Content-Security-Policy ${name} lists ${src} (only 'self', hashes, data: and the like)`);
    for (const b of inline) {
      if (b.kind === 'style') for (const url of cssRefs(b.body)) cssRef(page, url);
    }
    for (const t of tags) {
      if (t.attrs.style) for (const url of cssRefs(t.attrs.style)) cssRef(page, url);
      if (t.name === 'base' && t.attrs.href !== undefined) {
        const at = locate(t.attrs.href.trim(), page, base);
        if (at.kind !== 'site' && at.kind !== 'inline') errors.push(`${page}: <base href="${t.attrs.href}"> isn't on the site`);
      }
      const loadsHref = t.name === 'link' && (t.attrs.rel ?? '').toLowerCase().split(/\s+/).some((r) => LINK_LOADS.has(r));
      const loads = [...(LOADS[t.name] ?? []), ...(loadsHref ? ['href'] : [])];
      const links = t.name === 'a' || t.name === 'area' ? ['href'] : [];
      for (const attr of [...loads, ...links]) {
        const value = t.attrs[attr];
        if (!value) continue;
        const urls = attr === 'srcset' ? value.split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean) : [value.trim()];
        for (const url of urls) {
          const at = locate(url, page, base);
          if (at.kind === 'inline') continue;
          if (at.kind === 'external') {
            if (loads.includes(attr)) errors.push(`${page}: loads ${url} from another site`);
            continue;
          }
          if (at.kind === 'outside') {
            errors.push(`${page}: ${url} is outside ${base}`);
            continue;
          }
          if (page === '404.html' && at.relative) errors.push(`404.html: ${url} is relative (it's served at any missing path: use ${base}…)`);
          if (!found(at.path)) {
            errors.push(`${page}: ${url} doesn't resolve`);
            continue;
          }
          const target = pageOf(at.path);
          if (at.frag && links.includes(attr) && ext(target) === '.html' && !ids(target).has(at.frag)) errors.push(`${page}: ${url}: no id "${at.frag}" in ${target}`);
        }
      }
      if (t.name === 'img' && !page.startsWith('demo/') && (t.attrs.width === undefined || t.attrs.height === undefined)) {
        errors.push(`${page}: <img src="${t.attrs.src ?? ''}"> has no width and height (layout shift)`);
      }
    }
    for (const b of inline) if (!inlineAllowed(csp, b.kind, b.body)) errors.push(`${page}: an inline <${b.kind}> its Content-Security-Policy blocks`);
  }

  // Stylesheets: url() and @import.
  for (const css of all.filter((p) => ext(p) === '.css')) {
    for (const url of cssRefs(read(css).toString('utf8'))) cssRef(css, url);
  }

  // The demo's data and WebAssembly.
  let bundleBytes = 0;
  const listed = new Set();
  if (have.has(`${DATA}/manifest.json`)) {
    let manifest = null;
    try {
      manifest = JSON.parse(read(`${DATA}/manifest.json`).toString('utf8'));
    } catch {
      errors.push(`${DATA}/manifest.json: not JSON`);
    }
    for (const repo of manifest?.repos ?? []) {
      const p = `${DATA}/${repo.file}`;
      listed.add(p);
      if (!have.has(p)) {
        errors.push(`${p}: missing (listed in the manifest)`);
        continue;
      }
      const bytes = read(p);
      bundleBytes += bytes.length;
      if (!isGzip(bytes)) errors.push(`${p}: not gzip`);
      const actual = sha256(bytes, 'hex').slice(0, 12);
      if (!repo.rev) errors.push(`${p}: no rev in the manifest (the demo build adds it)`);
      else if (repo.rev !== actual) errors.push(`${p}: rev ${repo.rev} doesn't match its bytes (${actual})`);
    }
  }
  for (const p of all) if (p.startsWith(`${DATA}/`) && p.endsWith('.gbdemo') && !listed.has(p)) errors.push(`${p}: not in the manifest`);
  if (have.has(`${DATA}/manifest.json`)) {
    const mrev = sha256(read(`${DATA}/manifest.json`), 'hex').slice(0, 12);
    const built = all.some((p) => /^demo\/assets\/.*\.js$/.test(p) && read(p).includes(mrev));
    if (!built) errors.push(`${DATA}/manifest.json: its rev ${mrev} isn't in demo/assets/*.js (the build compiles it in)`);
  }
  const wasm = all.filter((p) => p.startsWith('demo/') && WASM.test(p));
  if (!wasm.length) errors.push('demo/: no gzipped WebAssembly under a hashed name (gitvolt_graph_wasm_bg.wasm-<hash>.gz)');
  for (const p of wasm) if (!isGzip(read(p))) errors.push(`${p}: not gzip`);

  // Sizes, and the build machine's path.
  let demoCode = 0;
  let raw = 0;
  let siteBytes = 0;
  let total = 0;
  const rawFiles = [];
  for (const p of all) {
    const bytes = read(p);
    total += bytes.length;
    const text = TEXT.has(ext(p));
    if (!text && !compressedFormat(bytes)) {
      raw += bytes.length;
      rawFiles.push(p);
    }
    if (p.startsWith('demo/')) {
      if (!p.startsWith(`${DATA}/`) && !p.startsWith('demo/licenses/')) demoCode += text ? gzipSync(bytes).length : bytes.length;
    } else {
      siteBytes += bytes.length;
      if (IMAGES.has(ext(p)) && bytes.length > max.image) errors.push(`${p}: ${fmt(bytes.length)}, over the ${fmt(max.image)} budget for an image`);
    }
    if (text && root && root.length > 1 && bytes.includes(root)) errors.push(`${p}: contains the build machine's path ${root}`);
  }
  const budget = (label, n, limit) => {
    report.push(`${label}: ${fmt(n)} of ${fmt(limit)}`);
    if (n > limit) errors.push(`${label}: ${fmt(n)}, over the ${fmt(limit)} budget`);
  };
  budget("the demo's bundles", bundleBytes, max.bundles);
  budget("the demo's code (gzip)", demoCode, max.demoCode);
  budget('binaries Pages sends uncompressed', raw, max.rawBinaries);
  budget('the site outside the demo', siteBytes, max.site);
  if (rawFiles.length) report.push(`  sent uncompressed: ${rawFiles.join(', ')}`);
  report.push(`the whole artefact: ${fmt(total)} in ${all.length} files`);
  return { errors, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  let base = '/';
  const i = args.indexOf('--base');
  if (i >= 0) {
    base = args[i + 1] ?? '';
    args.splice(i, 2);
  }
  if (args.length !== 1 || !base.startsWith('/') || !base.endsWith('/')) {
    console.error('usage: node ui/scripts/check-site.mjs [--base /path/] <dist>');
    process.exit(2);
  }
  const { errors, report } = checkSite(resolve(args[0]), { base });
  for (const line of report) console.log(`check-site: ${line}`);
  for (const e of errors) console.error(`check-site: ${e}`);
  if (errors.length) {
    console.error(`check-site: ${errors.length} problem(s) in ${args[0]}`);
    process.exit(1);
  }
  console.log(`check-site: ${args[0]} is ready for GitHub Pages`);
}
