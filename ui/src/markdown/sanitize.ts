import GithubSlugger from 'github-slugger';
import type { Element, ElementContent, Root as HastRoot } from 'hast';
import { defaultSchema, type Options as Schema } from 'rehype-sanitize';
import { visit } from 'unist-util-visit';

type Attrs = NonNullable<Schema['attributes']>[string];
const nameOf = (a: Attrs[number]) => (Array.isArray(a) ? a[0] : a);
const without = (list: Attrs | undefined, drop: readonly string[]): Attrs => (list ?? []).filter((a) => !drop.includes(String(nameOf(a))));
const base = defaultSchema.attributes ?? {};

/** GitHub's schema (hast-util-sanitize's default) with spec §6's changes: no class but
 * `language-*` on code, no accesskey/tabindex/style or form attributes, `id`/`name` prefixed `user-content-`, links
 * `http(s)`/`mailto`/relative, images also `data:` (narrowed to raster images by
 * `rehypeSafeUrls`), and these stripped with their contents. `data-gb-ref` on `span` carries a
 * reference through, and `data-gb-diff`, `data-gb-lines`, `data-gb-words` and `data-gb-note` (5C) a diff mark (render.tsx checks
 * their nonce). */
export const MD_SCHEMA: Schema = {
  ...defaultSchema,
  tagNames: [...new Set([...(defaultSchema.tagNames ?? []), 'details', 'summary', 'kbd', 'sub', 'sup', 'br', 'del', 'ins', 'picture', 'source'])],
  strip: ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'noscript', 'template', 'textarea', 'select', 'title'],
  attributes: {
    ...Object.fromEntries(Object.entries(base).map(([tag, list]) => [tag, without(list, ['className'])])),
    '*': without(base['*'], ['className', 'accessKey', 'tabIndex', 'style', 'action', 'method', 'encType', 'accept', 'acceptCharset']),
    code: [['className', /^language-[\w+#.-]+$/], 'dataGbLines', 'dataGbWords'],
    source: ['srcSet', 'media', 'type'],
    // `data-gb-*` carry a reference or (5C) a diff mark through; the overrides check their nonce.
    span: ['dataGbRef', 'dataGbDiff'],
    div: [...without(base.div, ['className']), 'dataGbDiff', 'dataGbNote'],
    li: [...without(base.li, ['className']), 'dataGbDiff', 'value'],
    tr: [...without(base.tr, ['className']), 'dataGbDiff'],
  },
  protocols: { ...defaultSchema.protocols, href: ['http', 'https', 'mailto'], src: ['http', 'https', 'data'] },
  clobberPrefix: 'user-content-',
  clobber: ['ariaDescribedBy', 'ariaLabelledBy', 'id', 'name'],
};

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const textOf = (n: ElementContent): string => (n.type === 'text' ? n.value : n.type === 'element' ? n.children.map(textOf).join('') : '');

/** A heading written as raw HTML without an id gets GitHub's slug too (Markdown headings already
 * have theirs from `remarkHeadingIds`), before the sanitizer prefixes it. The slugger starts with
 * every id already in the tree, so it never repeats a Markdown heading's. */
export function rehypeHeadingIds() {
  return (tree: HastRoot) => {
    const slugger = new GithubSlugger();
    visit(tree, 'element', (el: Element) => {
      if (typeof el.properties.id === 'string') slugger.occurrences[el.properties.id] ??= 0;
    });
    visit(tree, 'element', (el: Element) => {
      if (HEADINGS.has(el.tagName) && el.properties.id === undefined) el.properties.id = slugger.slug(el.children.map(textOf).join(''));
    });
  };
}

const DATA_IMAGE = /^data:image\/(png|gif|jpeg|webp);base64,[a-z0-9+/=\s]+$/i;
const SCHEME = /^\s*[a-z][a-z0-9+.-]*:/i;
/** A network path a browser reads as `//host` that isn't written as one: `\\host`, `/\host`,
 * `/<tab>/host` (browsers drop tabs and newlines, and read `\` as `/`). Plain `//host` stays: the
 * link and image resolvers take it as https. */
const disguisedNetworkPath = (u: string) => {
  const lead = u.replace(/^[\u0000-\u0020]+/, '');
  return /^[\\/]{2}/.test(lead.replace(/[\t\n\r]/g, '')) && !lead.startsWith('//');
};
const safeSrcSet = (set: string) => set.split(',').map((c) => c.trim().split(/\s+/)[0] ?? '').every((u) => u === '' || /^https:\/\//i.test(u) || (!SCHEME.test(u) && !disguisedNetworkPath(u)));

/** After the sanitizer: `data:` only for raster images, no `data:` link, no disguised network
 * path, a `srcset` only of https or relative URLs. */
export function rehypeSafeUrls() {
  return (tree: HastRoot) => {
    visit(tree, 'element', (el: Element) => {
      const { src, href, srcSet } = el.properties;
      if (typeof src === 'string' && ((/^\s*data:/i.test(src) && !DATA_IMAGE.test(src)) || disguisedNetworkPath(src))) delete el.properties.src;
      if (typeof href === 'string' && (/^\s*data:/i.test(href) || disguisedNetworkPath(href))) delete el.properties.href;
      if (srcSet !== undefined && !safeSrcSet(Array.isArray(srcSet) ? srcSet.join(',') : String(srcSet))) delete el.properties.srcSet;
    });
  };
}

type Parent = HastRoot | Element;

/** After the sanitizer: an `input` stays only where GFM puts a task-list checkbox, the first
 * element of a list item or of its first paragraph (the schema turns any `input` into a disabled
 * checkbox; a hand-written one elsewhere is dropped, spec §6). */
export function rehypeTaskInputsOnly() {
  const prune = (node: Parent, inItem: boolean) => {
    const firstElement = node.children.find((c) => c.type === 'element');
    node.children = node.children.filter((c) => {
      if (c.type !== 'element') return true;
      if (c.tagName === 'input') return inItem && c === firstElement;
      prune(c, c.tagName === 'li' || (node.type === 'element' && node.tagName === 'li' && c.tagName === 'p'));
      return true;
    }) as typeof node.children;
  };
  return (tree: HastRoot) => prune(tree, false);
}
