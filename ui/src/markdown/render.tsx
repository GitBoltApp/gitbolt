import type { Element, ElementContent, Root as HastRoot } from 'hast';
import { toJsxRuntime, type Components, type Jsx } from 'hast-util-to-jsx-runtime';
import type { Code, ListItem, Root, TableRow } from 'mdast';
import { Fragment, useContext, type ComponentProps, type ReactNode } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkRehype, { defaultHandlers } from 'remark-rehype';
import { unified } from 'unified';
import type { DiffBlockNode, DiffDelNode, DiffInsNode, DiffPairNode } from './diff/nodes';
import { MdCode } from './MdCode';
import { MdImage } from './MdImage';
import { MdLink } from './MdLink';
import { MdMermaid } from './MdMermaid';
import { MdReference } from './MdReference';
import { rehypeUnwrapNestedRefs } from './plugins/unwrapRefs';
import { MD_SCHEMA, rehypeHeadingIds, rehypeSafeUrls, rehypeTaskInputsOnly } from './sanitize';
import { MdContextOverride } from './sideContext';
import type { MarkdownContext, MdImageProps, MdLinkProps, MdReferenceNode, MdReferenceProps } from './types';

export interface SafeHast { hast: HastRoot; refs: MdReferenceNode[]; nonce: string }

/** rehype-raw's transform on its own (`hast-util-raw` comes through it). */
const parseRaw = (rehypeRaw as unknown as () => (tree: HastRoot) => HastRoot)();
const hasRaw = (nodes: readonly ElementContent[]): boolean =>
  nodes.some((n) => n.type === 'raw' || (n.type === 'element' && hasRaw(n.children)));

/** A diff wrapper's content with its raw HTML parsed on its own (5C): a stray closing tag in it
 * (a removed block starting with `</div>`) can't close the wrapper, and the wrapper closes
 * whatever the HTML leaves open. */
function isolated(children: ElementContent[]): ElementContent[] {
  return hasRaw(children) ? (parseRaw({ type: 'root', children }).children as ElementContent[]) : children;
}

function newNonce(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

type State = Parameters<typeof defaultHandlers.code>[0];
type ListParent = Parameters<typeof defaultHandlers.listItem>[2];
type RowParent = Parameters<typeof defaultHandlers.tableRow>[2];

/** mdast → sanitized hast (spec §3.1): raw HTML becomes real nodes (rehype-raw), headings get
 * ids, then rehype-sanitize (`MD_SCHEMA`), the data-URL pass and the task-input pass. A `reference`
 * node becomes a `span` carrying this call's nonce (ruling 3). A rendered diff's marks (5C, R17)
 * become `data-gb-diff` / `data-gb-lines` / `data-gb-note` attributes carrying the same nonce: the document's own
 * HTML can't forge one. The input tree isn't changed. */
export function toSafeHast(tree: Root): SafeHast {
  const nonce = newNonce();
  const refs: MdReferenceNode[] = [];
  const tag = (mark: string) => `${nonce}:${mark}`;
  const reference = (_state: unknown, node: MdReferenceNode): Element => {
    refs.push(node);
    return { type: 'element', tagName: 'span', properties: { dataGbRef: `${nonce}:${refs.length - 1}` }, children: [{ type: 'text', value: node.value }] };
  };
  const wrap = (tagName: 'div' | 'span', mark: string, state: State, node: DiffBlockNode | DiffPairNode | DiffInsNode | DiffDelNode): Element =>
    ({ type: 'element', tagName, properties: { dataGbDiff: tag(mark) }, children: isolated(state.all(node) as ElementContent[]) });
  const handlers = {
    reference,
    diffBlock: (state: State, node: DiffBlockNode) => {
      const el = wrap('div', node.mark, state, node);
      if (node.note) el.properties.dataGbNote = tag(node.note);
      return el;
    },
    diffPair: (state: State, node: DiffPairNode) => wrap('div', 'pair', state, node),
    diffIns: (state: State, node: DiffInsNode) => wrap('span', 'ins', state, node),
    diffDel: (state: State, node: DiffDelNode) => wrap('span', 'del', state, node),
    listItem: (state: State, node: ListItem, parent: ListParent) => {
      const el = defaultHandlers.listItem(state, node, parent);
      if (node.data?.gbDiff) el.properties.dataGbDiff = tag(node.data.gbDiff);
      if (node.data?.gbValue !== undefined) el.properties.value = String(node.data.gbValue);
      return el;
    },
    tableRow: (state: State, node: TableRow, parent: RowParent) => {
      const el = defaultHandlers.tableRow(state, node, parent);
      if (node.data?.gbDiff) el.properties.dataGbDiff = tag(node.data.gbDiff);
      return el;
    },
    code: (state: State, node: Code) => {
      const pre = defaultHandlers.code(state, node);
      const inner = pre.children[0];
      if (node.data?.gbLines !== undefined && inner?.type === 'element') inner.properties.dataGbLines = tag(node.data.gbLines);
      return pre;
    },
  };
  const hast = unified()
    // `clobberPrefix: ''`: the sanitizer adds `user-content-` once.
    .use(remarkRehype, { allowDangerousHtml: true, clobberPrefix: '', handlers: handlers as never })
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

/** 5C: a rendered diff's old side, which its removed parts resolve against. */
export interface DiffRender { old: MarkdownContext }

const MARK_LABEL: Record<string, string> = { added: 'Added', removed: 'Removed', changed: 'Changed' };
const LINE_MARKS = /^[ +-]*$/;

/** A link, image or reference inside a removed part resolves on the old side (R7, R9). */
function SidedLink(p: MdLinkProps) {
  const over = useContext(MdContextOverride);
  return <MdLink {...p} ctx={over ?? p.ctx} />;
}
function SidedImage(p: MdImageProps) {
  const over = useContext(MdContextOverride);
  return <MdImage {...p} ctx={over ?? p.ctx} />;
}
function SidedReference(p: MdReferenceProps) {
  const over = useContext(MdContextOverride);
  return <MdReference {...p} ctx={over ?? p.ctx} />;
}

/** The element overrides (spec §3.1's table). With `diff` (5C), marks carrying `nonce` render as
 * the diff's wrappers; without it, and for any other value, they're dropped. */
export function componentsFor(ctx: MarkdownContext, refs: MdReferenceNode[], nonce: string, diff?: DiffRender): Components {
  const markOf = (v: unknown): string | null => (diff && typeof v === 'string' && v.startsWith(`${nonce}:`) ? v.slice(nonce.length + 1) : null);
  const onOldSide = (children: ReactNode) => (diff ? <MdContextOverride value={diff.old}>{children}</MdContextOverride> : children);
  return {
    a: ({ href, id, name, 'aria-describedby': describedBy, children }) => (
      <SidedLink ctx={ctx} href={typeof href === 'string' ? href : ''} id={str(id)} name={str(name)} aria-describedby={str(describedBy)}>{children}</SidedLink>
    ),
    img: ({ src, alt, width, height }) => <SidedImage ctx={ctx} src={typeof src === 'string' ? src : ''} alt={typeof alt === 'string' ? alt : ''} width={size(width)} height={size(height)} />,
    pre: ({ node, children }) => {
      const code = node?.children.find((c: ElementContent): c is Element => c.type === 'element' && c.tagName === 'code');
      if (!code) return <pre>{children}</pre>;
      const cls = code.properties.className;
      const lang = (Array.isArray(cls) ? cls : []).map(String).find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? null;
      const text = code.children.map(textOf).join('').replace(/\n$/, '');
      const marks = markOf(code.properties.dataGbLines);
      return lang === 'mermaid' ? <MdMermaid source={text} /> : <MdCode code={text} lang={lang} marks={marks !== null && LINE_MARKS.test(marks) ? marks : undefined} />;
    },
    code: ({ node: _node, children, ...rest }) => {
      const { 'data-gb-lines': _lines, ...plain } = rest as Record<string, unknown>;
      return <code {...(plain as ComponentProps<'code'>)}>{children}</code>;
    },
    div: ({ node: _node, children, ...rest }) => {
      const { 'data-gb-diff': raw, 'data-gb-note': rawNote, ...plain } = rest as Record<string, unknown>;
      const mark = markOf(raw);
      if (mark === 'pair') return <div className="md-diff-pair" data-diff-mark="pair">{children}</div>;
      if (mark !== null && mark in MARK_LABEL) {
        const note = markOf(rawNote);
        return (
          <div className={`md-diff-block md-diff-${mark}`} data-diff-mark={mark} role="group" aria-label={MARK_LABEL[mark]}>
            {note && <p className="md-diff-note">{note}</p>}
            {mark === 'removed' ? onOldSide(children) : children}
          </div>
        );
      }
      return <div {...(plain as ComponentProps<'div'>)}>{children}</div>;
    },
    li: ({ node: _node, children, ...rest }) => {
      const { 'data-gb-diff': raw, ...plain } = rest as Record<string, unknown>;
      const mark = markOf(raw);
      const ok = mark !== null && mark in MARK_LABEL;
      return <li {...(plain as ComponentProps<'li'>)} className={ok ? `md-diff-${mark}` : undefined} data-diff-mark={ok ? mark : undefined}>{ok && mark === 'removed' ? onOldSide(children) : children}</li>;
    },
    tr: ({ node: _node, children, ...rest }) => {
      const { 'data-gb-diff': raw, ...plain } = rest as Record<string, unknown>;
      const mark = markOf(raw);
      const ok = mark !== null && mark in MARK_LABEL;
      return <tr {...(plain as ComponentProps<'tr'>)} className={ok ? `md-diff-${mark}` : undefined} data-diff-mark={ok ? mark : undefined}>{ok && mark === 'removed' ? onOldSide(children) : children}</tr>;
    },
    input: ({ checked }) => <input type="checkbox" className="md-task" disabled readOnly checked={checked === true} />,
    source: () => null,
    span: ({ node: _node, children, ...rest }) => {
      const props = rest as Record<string, unknown>;
      const tag = props['data-gb-ref'];
      const i = typeof tag === 'string' && tag.startsWith(`${nonce}:`) ? Number(tag.slice(nonce.length + 1)) : NaN;
      if (Number.isInteger(i) && refs[i]) return <SidedReference ctx={ctx} node={refs[i]} />;
      const mark = markOf(props['data-gb-diff']);
      if (mark === 'ins') return <ins className="md-diff-ins">{children}</ins>;
      if (mark === 'del') return <del className="md-diff-del">{onOldSide(children)}</del>;
      const { 'data-gb-ref': _forged, 'data-gb-diff': _forgedDiff, ...plain } = props;
      return <span {...plain}>{children}</span>;
    },
  };
}

/** The tree as React elements (never an HTML string). `diff` (5C): render its diff marks, with
 * removed parts resolving on `diff.old`. */
export function renderTree(tree: Root, ctx: MarkdownContext, diff?: DiffRender): ReactNode {
  const { hast, refs, nonce } = toSafeHast(tree);
  return toJsxRuntime(hast, { Fragment, jsx: jsx as Jsx, jsxs: jsxs as Jsx, components: componentsFor(ctx, refs, nonce, diff), passNode: true });
}
