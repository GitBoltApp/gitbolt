import type { Element, ElementContent, Root as HastRoot } from 'hast';
import { toJsxRuntime, type Components, type Jsx } from 'hast-util-to-jsx-runtime';
import type { Root } from 'mdast';
import { Fragment, type ReactNode } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { MdCode } from './MdCode';
import { MdImage } from './MdImage';
import { MdLink } from './MdLink';
import { MdMermaid } from './MdMermaid';
import { MdReference } from './MdReference';
import { rehypeUnwrapNestedRefs } from './plugins/unwrapRefs';
import { MD_SCHEMA, rehypeHeadingIds, rehypeSafeUrls, rehypeTaskInputsOnly } from './sanitize';
import type { MarkdownContext, MdReferenceNode } from './types';

export interface SafeHast { hast: HastRoot; refs: MdReferenceNode[]; nonce: string }

function newNonce(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** mdast → sanitized hast (spec §3.1): raw HTML becomes real nodes (rehype-raw), headings get
 * ids, then rehype-sanitize (`MD_SCHEMA`), the data-URL pass and the task-input pass. A `reference` node becomes a
 * `span` carrying this call's nonce (ruling 3). The input tree isn't changed. */
export function toSafeHast(tree: Root): SafeHast {
  const nonce = newNonce();
  const refs: MdReferenceNode[] = [];
  const reference = (_state: unknown, node: MdReferenceNode): Element => {
    refs.push(node);
    return { type: 'element', tagName: 'span', properties: { dataGbRef: `${nonce}:${refs.length - 1}` }, children: [{ type: 'text', value: node.value }] };
  };
  const hast = unified()
    // `clobberPrefix: ''`: the sanitizer adds `user-content-` once.
    .use(remarkRehype, { allowDangerousHtml: true, clobberPrefix: '', handlers: { reference } as never })
    .use(rehypeRaw)
    .use(rehypeUnwrapNestedRefs)
    .use(rehypeHeadingIds)
    .use(rehypeSanitize, MD_SCHEMA)
    .use(rehypeSafeUrls)
    .use(rehypeTaskInputsOnly)
    .runSync(tree as never) as HastRoot;
  return { hast, refs, nonce };
}

const textOf = (n: ElementContent): string => (n.type === 'text' ? n.value : n.type === 'element' ? n.children.map(textOf).join('') : '');
const size = (v: unknown): number | undefined => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 10_000 ? n : undefined;
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** The element overrides (spec §3.1's table). */
export function componentsFor(ctx: MarkdownContext, refs: MdReferenceNode[], nonce: string): Components {
  return {
    a: ({ href, id, name, 'aria-describedby': describedBy, children }) => (
      <MdLink ctx={ctx} href={typeof href === 'string' ? href : ''} id={str(id)} name={str(name)} aria-describedby={str(describedBy)}>{children}</MdLink>
    ),
    img: ({ src, alt, width, height }) => <MdImage ctx={ctx} src={typeof src === 'string' ? src : ''} alt={typeof alt === 'string' ? alt : ''} width={size(width)} height={size(height)} />,
    pre: ({ node, children }) => {
      const code = node?.children.find((c: ElementContent): c is Element => c.type === 'element' && c.tagName === 'code');
      if (!code) return <pre>{children}</pre>;
      const cls = code.properties.className;
      const lang = (Array.isArray(cls) ? cls : []).map(String).find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? null;
      const text = code.children.map(textOf).join('').replace(/\n$/, '');
      return lang === 'mermaid' ? <MdMermaid source={text} /> : <MdCode code={text} lang={lang} />;
    },
    input: ({ checked }) => <input type="checkbox" className="md-task" disabled readOnly checked={checked === true} />,
    source: () => null,
    span: ({ node: _node, children, ...rest }) => {
      const props = rest as Record<string, unknown>;
      const tag = props['data-gb-ref'];
      const i = typeof tag === 'string' && tag.startsWith(`${nonce}:`) ? Number(tag.slice(nonce.length + 1)) : NaN;
      if (Number.isInteger(i) && refs[i]) return <MdReference ctx={ctx} node={refs[i]} />;
      const { 'data-gb-ref': _forged, ...plain } = props;
      return <span {...plain}>{children}</span>;
    },
  };
}

/** The tree as React elements (never an HTML string). */
export function renderTree(tree: Root, ctx: MarkdownContext): ReactNode {
  const { hast, refs, nonce } = toSafeHast(tree);
  return toJsxRuntime(hast, { Fragment, jsx: jsx as Jsx, jsxs: jsxs as Jsx, components: componentsFor(ctx, refs, nonce), passNode: true });
}
