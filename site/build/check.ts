// The landing page's own checks, run by `just site-build` right after the page's build. Plan 6's
// ui/scripts/check-site.mjs then checks the whole Pages artefact (links, third-party loads, image
// sizes, the demo's data and code); this adds what only the page knows: no generated part left
// unfilled, which screenshots are still placeholders, the header button's reserved width, the link
// previews' image (an absolute URL to a file in the build), and the weight of the first screen, which paints before the demo loads (spec §4.5). Text is counted
// gzipped, as GitHub Pages serves it.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { gzipSync } from 'node:zlib';
import { pendingMethods } from './pending.ts';
import { SHOTS, type ShotId } from './shots.ts';

export const PAGE_BUDGETS = {
  /** Everything the first screen loads: HTML, CSS, JS, fonts, art, the hero's still at 2x. */
  firstLoad: 900_000,
  pageJs: 20_000,
  pageCss: 30_000,
};
export interface BudgetLine { name: string; limit: number; actual: number }
export interface PageReport { errors: string[]; warnings: string[]; budgets: BudgetLine[] }

const TEXT = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.txt']);

/** Bytes over the wire: gzipped for text, as is for the rest. */
export function wireSize(path: string): number {
  return TEXT.has(extname(path)) ? gzipSync(readFileSync(path)).length : statSync(path).size;
}

const isLocal = (u: string) => u !== '' && !/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(u);
const clean = (u: string) => normalize(u.split(/[?#]/)[0]).replace(/^\.\//, '');
const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
const lastSrcset = (srcset: string) => srcset.split(',').map((c) => c.trim().split(/\s+/)[0]).filter(Boolean).at(-1);

/** What the first screen fetches: the page, its scripts, styles, preloads and icon, its CSS's art
 * and fonts (woff2: browsers never fetch the woff fallback), and each eager image's largest source. */
export function firstLoadFiles(dist: string, html: string): string[] {
  const files = new Set<string>(['index.html']);
  for (const m of html.matchAll(/<(?:script|link)\b[^>]*>/g)) {
    const url = attr(m[0], 'src') ?? attr(m[0], 'href');
    if (url && isLocal(url)) files.add(clean(url));
  }
  for (const m of html.matchAll(/<img\b[^>]*>/g)) {
    if (/\bloading="lazy"/.test(m[0])) continue;
    const srcset = attr(m[0], 'srcset');
    const url = srcset ? lastSrcset(srcset) : attr(m[0], 'src');
    if (url && isLocal(url)) files.add(clean(url));
  }
  for (const css of [...files].filter((f) => f.endsWith('.css') && existsSync(join(dist, f)))) {
    for (const m of readFileSync(join(dist, css), 'utf8').matchAll(/url\(([^)]+)\)/g)) {
      const u = m[1].trim().replace(/^["']|["']$/g, '');
      if (isLocal(u) && !u.endsWith('.woff')) files.add(normalize(join(dirname(css), clean(u))));
    }
  }
  return [...files];
}

/** The shots whose placeholder card is expected: those whose scene (in the screenshot spec) needs a
 * method still PENDING in the demo's coverage.ts, or has no scene yet (its plan hasn't landed). */
export function expectedPlaceholders(specTs: string, coverageTs: string): Set<ShotId> {
  const pending = pendingMethods(coverageTs);
  const scenes = new Map<string, string[]>();
  for (const m of specTs.matchAll(/\bid:\s*'([a-z]+)',\s*needs:\s*\[([^\]]*)\]/g)) {
    scenes.set(m[1], [...m[2].matchAll(/'([A-Za-z]+)'/g)].map((n) => n[1]));
  }
  return new Set((Object.keys(SHOTS) as ShotId[]).filter((id) => {
    const needs = scenes.get(id);
    return !needs || needs.some((n) => pending.has(n));
  }));
}

/** The widest label the header button grows to once the page knows the visitor's system. */
const WIDEST_CTA = 'for Windows';

export interface PageOptions {
  /** Shots allowed to still be placeholders; any other placeholder is an error, not a warning. */
  expected?: Set<ShotId>;
  /** The path the site is served under (GITVOLT_SITE_BASE), to find og:image's file in the build. */
  base?: string;
}

const metaContent = (html: string, key: string): string | undefined =>
  [...html.matchAll(/<meta\b[^>]*>/g)].map((m) => m[0]).filter((t) => attr(t, 'property') === key || attr(t, 'name') === key).map((t) => attr(t, 'content'))[0];

/** og:image and twitter:image: there, absolute (scrapers don't resolve relative URLs), and a file
 * this build has under `base`. */
export function checkSocial(dist: string, html: string, base = '/'): string[] {
  const errors: string[] = [];
  for (const key of ['og:image', 'twitter:image']) {
    const url = metaContent(html, key);
    if (!url) { errors.push(`index.html: no ${key} <meta> (link previews would have no image)`); continue; }
    if (!/^https:\/\/[^/]+\//.test(url)) { errors.push(`index.html: ${key} "${url}" isn't an absolute https URL`); continue; }
    const path = decodeURIComponent(new URL(url).pathname);
    if (!path.startsWith(base) || !existsSync(join(dist, path.slice(base.length)))) errors.push(`index.html: ${key} "${url}" isn't a file in the build (base ${base})`);
  }
  return errors;
}

export function checkPage(dist: string, budgets: typeof PAGE_BUDGETS = PAGE_BUDGETS, opts: PageOptions = {}): PageReport {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const errors = [...html.matchAll(/<!--([a-z]+:[a-z0-9-]+)-->/g)].map((m) => `index.html: <!--${m[1]}--> was never filled`);
  errors.push(...checkSocial(dist, html, opts.base));
  const warnings: string[] = [];
  const altToId = new Map((Object.entries(SHOTS) as [ShotId, { alt: string }][]).map(([id, s]) => [s.alt, id]));
  for (const m of html.matchAll(/<span class="shot-cap">([^<]*)<\/span>/g)) {
    const id = altToId.get(m[1].replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'"));
    if (opts.expected && !(id && opts.expected.has(id))) errors.push(`screenshot still a placeholder, and its scene isn't waiting on a pending method: "${m[1]}" (just site-shots)`);
    else warnings.push(`no screenshot yet: "${m[1]}" (just site-shots)`);
  }
  const first = firstLoadFiles(dist, html).filter((f) => existsSync(join(dist, f)));
  const cssFiles = first.filter((f) => f.endsWith('.css'));
  // The header's "Download" grows to "Download for <OS>" when JS runs; the page must reserve the
  // room: a hidden `.cta-size` copy of the widest label, or a CSS `content:` one.
  const sizer = new RegExp(`class="cta-size"[^>]*>[^]*?${WIDEST_CTA}`).test(html);
  if (/class="cta-os"/.test(html) && !sizer && !cssFiles.some((f) => readFileSync(join(dist, f), 'utf8').replace(/\s/g, '').includes(`content:"${WIDEST_CTA}"`.replace(/\s/g, '')))) {
    errors.push(`the header button's CSS doesn't reserve the width of "${WIDEST_CTA}" (the label would shift the layout)`);
  }
  const sum = (files: string[]) => files.reduce((n, f) => n + wireSize(join(dist, f)), 0);
  const lines: BudgetLine[] = [
    { name: 'firstLoad', limit: budgets.firstLoad, actual: sum(first) },
    { name: 'pageJs', limit: budgets.pageJs, actual: sum(first.filter((f) => f.endsWith('.js'))) },
    { name: 'pageCss', limit: budgets.pageCss, actual: sum(cssFiles) },
  ];
  for (const b of lines) if (b.actual > b.limit) errors.push(`${b.name}: ${b.actual} bytes, over its ${b.limit}`);
  return { errors, warnings, budgets: lines };
}
