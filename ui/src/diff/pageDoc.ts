/**
 * An HTML file's rendered view: the page as a static document for an `<iframe sandbox srcdoc>`
 * (`HtmlPage.tsx`). Parsed with `DOMParser`, which never runs scripts or loads anything. The
 * frame's sandbox stops scripts, forms and popups; a `srcdoc` document inherits the app's Content
 * Security Policy, and the policy added here tightens it to inline styles and `data:` files
 * only, so nothing is fetched: not the network, and not the app's own origin (a `srcdoc`
 * document's relative URLs resolve against the app's page).
 */

/** Added first in the page's `<head>`: CSP only ever tightens, and a `<meta>` policy covers what
 * follows it. Relative images and stylesheets come in as `data:` URLs and `<style>` (`assets`). */
export const PAGE_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline' data:; font-src data:; media-src data:";

/** What the page uses that doesn't show here: the hosts of its http(s) files (scripts,
 * stylesheets, images, fonts, frames), in the order they appear, and whether it has scripts at
 * all (a `<script>`, an `on…` handler, a `javascript:` link). */
export interface PageExternals { hosts: string[]; scripts: boolean }

/** The relative files the page uses that can be inlined: images (`<img src>`) and stylesheets
 * (`<link rel="stylesheet" href>`), as written. */
export interface PageAssets { images: string[]; styles: string[] }

/** What replaces each relative file, by its reference as written: an image's `data:` URL, a
 * stylesheet's text. Missing ones stay as they are (and don't load). Maps, not objects: a
 * reference is the page's text, so `__proto__` or `constructor` must be only a key. */
export interface InlinedAssets {
  images: ReadonlyMap<string, string>;
  styles: ReadonlyMap<string, string>;
  /** How many were left out: past the byte budget or the count (`htmlAssets.ts`). */
  omitted?: number;
}

const NO_ASSETS: InlinedAssets = { images: new Map(), styles: new Map() };

/** A page parsed once (per text): the document, and what the bar and the inlining need from it.
 * `pageSrcdoc` works on a copy of `doc`. */
export interface Page { doc: Document; externals: PageExternals; assets: PageAssets }

/** The `<script type>`s a browser runs (HTML's JavaScript MIME types, and `module`); none, or
 * an empty one, runs too. Any other type holds data. */
const RUNS = /^(module|(application|text)\/(x-)?(ecmascript|javascript)|text\/javascript1\.[0-5]|text\/(jscript|livescript))$/i;
/** `<link rel>`s that fetch a file for the page. */
const LINK_FETCHES = /\b(stylesheet|icon|preload|modulepreload|manifest|apple-touch-icon)\b/i;
/** Elements and their attributes that load a single file. */
const URL_ATTRS: [string, string][] = [
  ['script', 'src'], ['img', 'src'], ['source', 'src'], ['video', 'src'], ['video', 'poster'], ['audio', 'src'], ['track', 'src'],
  ['iframe', 'src'], ['frame', 'src'], ['embed', 'src'], ['object', 'data'], ['input', 'src'],
];
/** CSS's `url(…)` and `@import "…"`. */
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)|@import\s+(['"])([^'"]+)\3/gi;

/** `url`'s host when it's an http(s) URL (protocol-relative too), else `null`. */
export function externalHost(url: string): string | null {
  const u = url.trim();
  if (!/^(https?:)?\/\//i.test(u)) return null;
  try {
    return new URL(u, 'https://relative.invalid/').hostname || null;
  } catch {
    return null;
  }
}

/** Whether `url` is a path in the repository: not absolute, not a fragment, not `data:` or another scheme. */
export const isRelativeRef = (url: string): boolean => {
  const u = url.trim();
  return u !== '' && !u.startsWith('#') && !u.startsWith('//') && !/^[a-z][a-z0-9+.-]*:/i.test(u);
};

const srcsetUrls = (srcset: string) => srcset.split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean);
const cssUrls = (css: string) => [...css.matchAll(CSS_URL)].map((m) => m[2] ?? m[4]);
const isCodeScript = (el: Element) => {
  const type = el.getAttribute('type')?.split(';')[0].trim() ?? '';
  return type === '' || RUNS.test(type);
};
/** An event handler attribute: `on` and an event the element has a handler property for
 * (`onclick`, `onload`; not `one` or `only`). */
const isHandler = (el: Element, name: string) => /^on[a-z]+$/i.test(name) && name.toLowerCase() in el;
const parse = (text: string) => new DOMParser().parseFromString(text, 'text/html');

/** Every file URL the document names, in document order (scripts' too). */
function fileUrls(doc: Document): string[] {
  const out: string[] = [];
  for (const el of doc.querySelectorAll('*')) {
    const tag = el.localName;
    for (const [t, attr] of URL_ATTRS) {
      const v = t === tag ? el.getAttribute(attr) : null;
      if (v !== null && (tag !== 'script' || isCodeScript(el))) out.push(v);
    }
    // SVG's `<image>` and `<use>` load a file too (`href`, or the older `xlink:href`).
    if (tag === 'image' || tag === 'use') out.push(el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? '');
    if (tag === 'link' && LINK_FETCHES.test(el.getAttribute('rel') ?? '')) out.push(el.getAttribute('href') ?? '');
    const srcset = (tag === 'img' || tag === 'source') ? el.getAttribute('srcset') : null;
    if (srcset) out.push(...srcsetUrls(srcset));
    if (tag === 'style') out.push(...cssUrls(el.textContent ?? ''));
    const style = el.getAttribute('style');
    if (style) out.push(...cssUrls(style));
  }
  return out;
}

const hasHandlers = (doc: Document) =>
  [...doc.querySelectorAll('*')].some((el) => [...el.attributes].some((a) => isHandler(el, a.name)) || /^\s*javascript:/i.test(el.getAttribute('href') ?? ''));

/** Parses `text` once, for the bar, the inlining and the frame. */
export function readPage(text: string): Page {
  const doc = parse(text);
  return { doc, externals: externalsOf(doc), assets: assetsOf(doc) };
}

/** What the page uses that doesn't show here (the bar above the render). */
export const pageExternals = (text: string): PageExternals => externalsOf(parse(text));

/** The relative images and stylesheets the page uses, each once. */
export const pageAssets = (text: string): PageAssets => assetsOf(parse(text));

function externalsOf(doc: Document): PageExternals {
  const hosts = [...new Set(fileUrls(doc).map(externalHost).filter((h): h is string => h !== null))];
  const scripts = [...doc.querySelectorAll('script')].some(isCodeScript) || hasHandlers(doc);
  return { hosts, scripts };
}

function assetsOf(doc: Document): PageAssets {
  const images = [...doc.querySelectorAll('img[src]')].map((el) => el.getAttribute('src')!).filter(isRelativeRef);
  const styles = [...doc.querySelectorAll('link[href]')]
    .filter((el) => /\bstylesheet\b/i.test(el.getAttribute('rel') ?? ''))
    .map((el) => el.getAttribute('href')!)
    .filter(isRelativeRef);
  return { images: [...new Set(images)], styles: [...new Set(styles)] };
}

/** CSS text that can't end its `<style>` early: `</style` in it (in a string, a comment) becomes
 * `<\/style`, which CSS reads the same. */
export const styleText = (css: string): string => css.replace(/<\/(style)/gi, '<\\/$1');

/** A `javascript:` URL, as a browser reads one (leading spaces and control characters, tabs or
 * newlines within the scheme). */
const JS_URL = /^[\u0000- ]*j[\t\n\r]*a[\t\n\r]*v[\t\n\r]*a[\t\n\r]*s[\t\n\r]*c[\t\n\r]*r[\t\n\r]*i[\t\n\r]*p[\t\n\r]*t[\t\n\r]*:/i;

/** Attributes that make a request of their own: a link's `ping`, and `attributionsrc`. */
const DROPPED_ATTRS = new Set(['ping', 'attributionsrc']);

/** Replaces relative images and stylesheets with what `assets` has for them. */
function inline(doc: Document, assets: InlinedAssets): void {
  for (const el of doc.querySelectorAll('img[src]')) {
    const url = assets.images.get(el.getAttribute('src')!);
    if (url) el.setAttribute('src', url);
  }
  for (const el of doc.querySelectorAll('link[href]')) {
    const css = /\bstylesheet\b/i.test(el.getAttribute('rel') ?? '') ? assets.styles.get(el.getAttribute('href')!) : undefined;
    if (css === undefined) continue;
    const style = doc.createElement('style');
    style.textContent = styleText(css);
    const media = el.getAttribute('media');
    if (media) style.setAttribute('media', media);
    el.replaceWith(style);
  }
}

/**
 * Best-effort hardening: the sandbox and the policy are what keep the page from running. The
 * policy goes first in the head; scripts, `on…` handlers, `<link>`s not inlined, refreshes,
 * `<base>` and nested `srcdoc` come out (none would run; this keeps the console quiet and nothing navigating); every
 * link opens a new window, which the sandbox refuses, so a click does nothing (a `#fragment` too:
 * in a `srcdoc` document it resolves against the app's page).
 */
function clean(doc: Document): void {
  // A `<link>` still here wasn't inlined: none of them loads (a stylesheet, a preload, a prefetch).
  for (const el of doc.querySelectorAll('script, base, link, meta[http-equiv="refresh" i]')) el.remove();
  for (const el of doc.querySelectorAll('*')) {
    // Handlers, any `javascript:` URL (`href`, SVG's `xlink:href`, `formaction`), and a link's
    // `ping` and `attributionsrc` (requests on a click or a load).
    for (const a of [...el.attributes]) if (/^on/i.test(a.name) || DROPPED_ATTRS.has(a.name.toLowerCase()) || JS_URL.test(a.value)) el.removeAttributeNode(a);
  }
  for (const el of doc.querySelectorAll('iframe[srcdoc], frame[srcdoc]')) el.removeAttribute('srcdoc');
  for (const el of doc.querySelectorAll('a, area')) el.setAttribute('target', '_blank');
  for (const el of doc.querySelectorAll('form')) el.setAttribute('target', '_blank');
  const first = doc.head.firstElementChild;
  if (first?.localName !== 'meta' || first.getAttribute('http-equiv') !== 'Content-Security-Policy' || first.getAttribute('content') !== PAGE_CSP) {
    const meta = doc.createElement('meta');
    meta.setAttribute('http-equiv', 'Content-Security-Policy');
    meta.setAttribute('content', PAGE_CSP);
    doc.head.prepend(meta);
  }
}

// The doctype keeps the page in standards mode; a page without one renders in quirks mode, as a
// browser would show it.
const serialize = (doc: Document) => `${doc.doctype ? '<!DOCTYPE html>' : ''}${doc.documentElement.outerHTML}`;

/** Rounds of parse and clean again before a page that keeps changing is given up. */
const MAX_ROUNDS = 4;
/** What shows for a page whose markup doesn't settle (it reads differently each time it's parsed). */
export const UNSETTLED_PAGE = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}"></head><body><p>This page can't be shown here.</p></body></html>`;

/**
 * The page (parsed, or its text) as the frame's `srcdoc`: `assets` inlined first, then cleaned (`clean`). Markup can
 * read differently once serialized and parsed again (an element in SVG or MathML, a `<style>`
 * that ends early), so the result is parsed and cleaned again until it stays the same: what the
 * frame parses is what was cleaned. `DOMParser` parses with scripting off, as the sandboxed frame
 * does, so `<noscript>` reads the same in both.
 */
export function pageSrcdoc(page: Page | string, assets: InlinedAssets = NO_ASSETS): string {
  const doc = typeof page === 'string' ? parse(page) : page.doc.cloneNode(true) as Document;
  inline(doc, assets);
  clean(doc);
  let out = serialize(doc);
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const again = parse(out);
    clean(again);
    const next = serialize(again);
    if (next === out) return out;
    out = next;
  }
  return UNSETTLED_PAGE;
}

/** The bar names this many hosts at most (the last place says how many more). */
const MAX_HOSTS = 4;

/** The bar's text above a page with `ext`, `omitted` of its own files left out (too much to
 * inline), or `null` when everything it uses shows. */
export function pageNote(ext: PageExternals, omitted = 0): string | null {
  const said: string[] = [];
  if (ext.hosts.length > 0) {
    const named = ext.hosts.length > MAX_HOSTS ? `${ext.hosts.slice(0, MAX_HOSTS - 1).join(', ')} and ${ext.hosts.length - MAX_HOSTS + 1} more` : ext.hosts.join(', ');
    said.push(`This page uses scripts or files from ${named} — they don't run here.`);
  } else if (ext.scripts) said.push("This page uses scripts — they don't run here.");
  if (omitted > 0) {
    const whose = said.length > 0 ? 'its' : "this page's";
    said.push(omitted === 1 ? `One of ${whose} images or stylesheets is left out: too large to show here.` : `${omitted} of ${whose} images and stylesheets are left out: too large to show here.`);
  }
  return said.length > 0 ? `${said.join(' ')} Open in browser to see it fully.` : null;
}
