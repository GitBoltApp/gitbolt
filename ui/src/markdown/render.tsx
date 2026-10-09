import type { Element, ElementContent, Root as HastRoot } from 'hast';
import { toJsxRuntime, type Components, type Jsx } from 'hast-util-to-jsx-runtime';
import type { Blockquote, Code, Heading, List, ListItem, Nodes, Paragraph, Root, Table, TableRow, ThematicBreak } from 'mdast';
import { createElement, Fragment, useContext, type ComponentProps, type ReactNode } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkRehype, { defaultHandlers } from 'remark-rehype';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import type { DiffBlockNode, DiffDelNode, DiffInsNode, DiffPairNode, SplitCellNode, SplitRowNode } from './diff/nodes';
import { splitTree } from './diff/split';
import { BlockSlot } from './blockSlot';
import { MdCode, MdSuggestion } from './MdCode';
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

/** Drops every block's `data-gb-src` (review comments) but this render's own (`keep`: its nonce;
 * null: all of them). The block overrides read them only in a rendered diff, so no other render,
 * and no document's own HTML, can put one on the page. */
function dropSources(tree: HastRoot, keep: string | null): void {
  visit(tree, 'element', (el: Element) => {
    const v = el.properties.dataGbSrc;
    if (v !== undefined && !(keep !== null && typeof v === 'string' && v.startsWith(`${keep}:`))) delete el.properties.dataGbSrc;
  });
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
  const wrap = (tagName: 'div' | 'span', mark: string, state: State, node: DiffBlockNode | DiffPairNode | DiffInsNode | DiffDelNode | SplitCellNode): Element =>
    ({ type: 'element', tagName, properties: { dataGbDiff: tag(mark) }, children: isolated(state.all(node) as ElementContent[]) });
  // Review comments (spec 2026-10-08 §3): a block's source lines (`gbSrc`) as `data-gb-src`,
  // carrying the nonce. In the split view a cell shows its own side's lines only (`column`).
  let column: 'old' | 'new' | null = null;
  const span = (r: readonly [number, number] | null) => (r ? `${r[0]}-${r[1]}` : '');
  const src = (node: Nodes, el: Element): Element => {
    const s = node.data?.gbSrc;
    const neu = s && column !== 'old' ? s.new : null;
    const old = s && column !== 'new' ? s.old : null;
    if (s && (neu || old)) el.properties.dataGbSrc = tag(`${s.id}:${span(neu)}:${span(old)}`);
    return el;
  };
  const handlers = {
    reference,
    diffBlock: (state: State, node: DiffBlockNode) => {
      const el = wrap('div', node.mark, state, node);
      if (node.note) el.properties.dataGbNote = tag(node.note);
      return src(node, el);
    },
    diffPair: (state: State, node: DiffPairNode) => src(node, wrap('div', 'pair', state, node)),
    diffIns: (state: State, node: DiffInsNode) => wrap('span', 'ins', state, node),
    diffDel: (state: State, node: DiffDelNode) => wrap('span', 'del', state, node),
    // The split view (5C): a row's cells, each one's HTML parsed on its own.
    splitRow: (state: State, node: SplitRowNode): Element =>
      ({ type: 'element', tagName: 'div', properties: { dataGbDiff: tag(`row:${node.mark ?? 'same'}${node.joined ? ':joined' : ''}`) }, children: state.all(node) as ElementContent[] }),
    splitCell: (state: State, node: SplitCellNode) => {
      const was = column;
      column = node.empty ? null : node.side;
      try {
        return wrap('div', node.empty ? 'empty' : node.side, state, node);
      } finally {
        column = was;
      }
    },
    listItem: (state: State, node: ListItem, parent: ListParent) => {
      const el = defaultHandlers.listItem(state, node, parent);
      if (node.data?.gbDiff) el.properties.dataGbDiff = tag(node.data.gbDiff);
      if (node.data?.gbValue !== undefined) el.properties.value = String(node.data.gbValue);
      return src(node, el);
    },
    tableRow: (state: State, node: TableRow, parent: RowParent) => {
      const el = defaultHandlers.tableRow(state, node, parent);
      if (node.data?.gbDiff) el.properties.dataGbDiff = tag(node.data.gbDiff);
      if (node.data?.gbEmpty) el.properties.dataGbDiff = tag('empty');
      return el;
    },
    // A file's front matter (`remarkFrontmatterTable`): a row per key, the key a row header.
    table: (state: State, node: Table) => {
      if (!node.data?.gbFrontmatter) return src(node, defaultHandlers.table(state, node));
      const rows = node.children.map((r): Element => {
        const [key, value] = r.children;
        const props: Element['properties'] = {};
        if (r.data?.gbDiff) props.dataGbDiff = tag(r.data.gbDiff);
        if (r.data?.gbEmpty) props.dataGbDiff = tag('empty');
        const cell = (tagName: 'th' | 'td', c: typeof key): Element => ({ type: 'element', tagName, properties: {}, children: c ? (state.all(c) as ElementContent[]) : [] });
        return { type: 'element', tagName: 'tr', properties: props, children: [cell('th', key), cell('td', value)] };
      });
      return src(node, { type: 'element', tagName: 'table', properties: { dataGbFm: tag(node.data.gbFrontmatter) }, children: [{ type: 'element', tagName: 'tbody', properties: {}, children: rows }] } satisfies Element);
    },
    code: (state: State, node: Code) => {
      const pre = defaultHandlers.code(state, node);
      const inner = pre.children[0];
      if (node.data?.gbLines !== undefined && inner?.type === 'element') inner.properties.dataGbLines = tag(node.data.gbLines);
      if (node.data?.gbWords !== undefined && inner?.type === 'element') inner.properties.dataGbWords = tag(node.data.gbWords);
      return src(node, pre);
    },
    paragraph: (state: State, node: Paragraph) => src(node, defaultHandlers.paragraph(state, node)),
    heading: (state: State, node: Heading) => src(node, defaultHandlers.heading(state, node)),
    list: (state: State, node: List) => src(node, defaultHandlers.list(state, node)),
    blockquote: (state: State, node: Blockquote) => src(node, defaultHandlers.blockquote(state, node)),
    thematicBreak: (state: State, node: ThematicBreak) => src(node, defaultHandlers.thematicBreak(state, node)),
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
  dropSources(hast, nonce);
  return { hast, refs, nonce };
}

const textOf = (n: ElementContent): string => (n.type === 'text' ? n.value : n.type === 'element' ? n.children.map(textOf).join('') : '');
const size = (v: unknown): number | undefined => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 10_000 ? n : undefined;
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** 5C: a rendered diff's old side, which its removed parts (and in `split`, its whole left
 * column) resolve against. `split`: show it side by side (`splitTree`). */
export interface DiffRender { old: MarkdownContext; split?: boolean }

const MARK_LABEL: Record<string, string> = { added: 'Added', removed: 'Removed', changed: 'Changed' };
const isMark = (m: string) => Object.hasOwn(MARK_LABEL, m);
const LINE_MARKS = /^[ +-]*$/;
/** A review comment's suggestion fence (spec 2026-10-08): GitHub's `suggestion`, GitLab's
 * `suggestion:-N+M` (the lines above and below the commented one it replaces). */
const SUGGESTION_LANG = /^suggestion(?::-\d+\+\d+)?$/;
const WORD_MARKS = /^[\d,;-]*$/;

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

/** Review comments (spec 2026-10-08 §3): a block's source lines from its nonce-checked
 * `data-gb-src` ("<id>:<new from-to>:<old from-to>", one side empty at most). */
interface BlockSrc { id: number; new: string | null; old: string | null }
const SRC = /^(\d+):(\d+-\d+)?:(\d+-\d+)?$/;
/** The lines as the page carries them (`diff/review/renderedBlocks.ts` reads them). */
const srcAttrs = (s: BlockSrc | null): Record<string, string> =>
  (s ? { 'data-src-id': String(s.id), ...(s.new ? { 'data-src-new': s.new } : {}), ...(s.old ? { 'data-src-old': s.old } : {}) } : {});
const slotOf = (s: BlockSrc | null): ReactNode => (s ? <BlockSlot id={s.id} sides={{ new: s.new !== null, old: s.old !== null }} /> : null);
/** The block tags with no override of their own: they get one that carries the lines. */
const SOURCED = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'blockquote', 'hr'] as const;

/** The element overrides (spec §3.1's table). With `diff` (5C), marks carrying `nonce` render as
 * the diff's wrappers; without it, and for any other value, they're dropped. */
export function componentsFor(ctx: MarkdownContext, refs: MdReferenceNode[], nonce: string, diff?: DiffRender): Components {
  const markOf = (v: unknown): string | null => (diff && typeof v === 'string' && v.startsWith(`${nonce}:`) ? v.slice(nonce.length + 1) : null);
  const onOldSide = (children: ReactNode) => (diff ? <MdContextOverride value={diff.old}>{children}</MdContextOverride> : children);
  const srcOf = (v: unknown): BlockSrc | null => {
    const m = markOf(v);
    const g = m === null ? null : SRC.exec(m);
    return g && (g[2] || g[3]) ? { id: Number(g[1]), new: g[2] ?? null, old: g[3] ?? null } : null;
  };
  const sourcedTag = (tag: (typeof SOURCED)[number]) => function Sourced({ node: _node, children, ...rest }: { node?: Element; children?: ReactNode }) {
    const { 'data-gb-src': raw, ...plain } = rest as Record<string, unknown>;
    const s = srcOf(raw);
    const el = createElement(tag, { ...plain, ...srcAttrs(s) }, children);
    return s ? <>{el}{slotOf(s)}</> : el;
  };
  return {
    // Only a rendered diff's blocks carry lines; elsewhere they stay plain elements.
    ...(diff ? (Object.fromEntries(SOURCED.map((t) => [t, sourcedTag(t)])) as unknown as Partial<Components>) : {}),
    a: ({ href, id, name, 'aria-describedby': describedBy, children }) => (
      <SidedLink ctx={ctx} href={typeof href === 'string' ? href : ''} id={str(id)} name={str(name)} aria-describedby={str(describedBy)}>{children}</SidedLink>
    ),
    img: ({ src, alt, width, height }) => <SidedImage ctx={ctx} src={typeof src === 'string' ? src : ''} alt={typeof alt === 'string' ? alt : ''} width={size(width)} height={size(height)} />,
    pre: ({ node, children, ...rest }) => {
      const s = srcOf((rest as Record<string, unknown>)['data-gb-src']);
      const code = node?.children.find((c: ElementContent): c is Element => c.type === 'element' && c.tagName === 'code');
      let inner: ReactNode;
      if (!code) inner = <pre>{children}</pre>;
      else {
        const cls = code.properties.className;
        const lang = (Array.isArray(cls) ? cls : []).map(String).find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? null;
        const text = code.children.map(textOf).join('').replace(/\n$/, '');
        const marks = markOf(code.properties.dataGbLines);
        const words = markOf(code.properties.dataGbWords);
        const lineMarks = marks !== null && LINE_MARKS.test(marks) ? marks : undefined;
        if (lang === 'mermaid') inner = <MdMermaid source={text} />;
        else if (lang !== null && SUGGESTION_LANG.test(lang)) inner = <MdSuggestion code={text} />;
        else inner = <MdCode code={text} lang={lang} marks={lineMarks} words={lineMarks !== undefined && words !== null && WORD_MARKS.test(words) ? words : undefined} />;
      }
      // A code block renders as a component: a box carries its lines and its slot.
      return s ? <div className="md-src-code" {...srcAttrs(s)}>{inner}{slotOf(s)}</div> : inner;
    },
    code: ({ node: _node, children, ...rest }) => {
      const { 'data-gb-lines': _lines, 'data-gb-words': _words, ...plain } = rest as Record<string, unknown>;
      return <code {...(plain as ComponentProps<'code'>)}>{children}</code>;
    },
    div: ({ node: _node, children, ...rest }) => {
      const { 'data-gb-diff': raw, 'data-gb-note': rawNote, 'data-gb-src': rawSrc, ...plain } = rest as Record<string, unknown>;
      const mark = markOf(raw);
      const s = srcOf(rawSrc);
      if (mark === 'pair') return <div className="md-diff-pair" data-diff-mark="pair" {...srcAttrs(s)}>{children}{slotOf(s)}</div>;
      // The split view: a changed row is the change Previous/Next stop at; the old column
      // resolves on the old side.
      if (mark?.startsWith('row:')) {
        const [, rowMark = '', joined] = mark.split(':');
        const ok = isMark(rowMark);
        return <div className={`md-split-row${ok ? ` md-split-${rowMark}` : ''}${joined ? ' md-split-joined' : ''}`} data-diff-mark={ok ? rowMark : undefined}>{children}</div>;
      }
      if (mark === 'old') return <div className="md-split-cell md-split-old">{onOldSide(children)}</div>;
      if (mark === 'new') return <div className="md-split-cell md-split-new">{children}</div>;
      if (mark === 'empty') return <div className="md-split-cell md-split-empty" aria-hidden="true" />;
      if (mark !== null && mark in MARK_LABEL) {
        const note = markOf(rawNote);
        return (
          <div className={`md-diff-block md-diff-${mark}`} data-diff-mark={mark} role="group" aria-label={MARK_LABEL[mark]} {...srcAttrs(s)}>
            {note && <p className="md-diff-note">{note}</p>}
            {mark === 'removed' ? onOldSide(children) : children}
            {slotOf(s)}
          </div>
        );
      }
      return <div {...(plain as ComponentProps<'div'>)}>{children}</div>;
    },
    li: ({ node: _node, children, ...rest }) => {
      const { 'data-gb-diff': raw, 'data-gb-src': rawSrc, ...plain } = rest as Record<string, unknown>;
      const mark = markOf(raw);
      const s = srcOf(rawSrc);
      const ok = mark !== null && mark in MARK_LABEL;
      return <li {...(plain as ComponentProps<'li'>)} className={ok ? `md-diff-${mark}` : undefined} data-diff-mark={ok ? mark : undefined} {...srcAttrs(s)}>{ok && mark === 'removed' ? onOldSide(children) : children}{slotOf(s)}</li>;
    },
    table: ({ node: _node, children, ...rest }) => {
      const { 'data-gb-fm': fm, 'data-gb-src': rawSrc, ...plain } = rest as Record<string, unknown>;
      const s = srcOf(rawSrc);
      const table = typeof fm === 'string' && (fm === `${nonce}:yaml` || fm === `${nonce}:toml`)
        ? <table className="md-frontmatter" data-frontmatter={fm.slice(nonce.length + 1)} {...srcAttrs(s)}><caption>Front matter</caption>{children}</table>
        : <table {...(plain as ComponentProps<'table'>)} {...srcAttrs(s)}>{children}</table>;
      return s ? <>{table}{slotOf(s)}</> : table;
    },
    tr: ({ node: _node, children, ...rest }) => {
      const { 'data-gb-diff': raw, ...plain } = rest as Record<string, unknown>;
      const mark = markOf(raw);
      if (mark === 'empty') return <tr className="md-split-empty-row" aria-hidden="true">{children}</tr>;
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
 * removed parts resolving on `diff.old`; `diff.split`: side by side, in rows. */
export function renderTree(tree: Root, ctx: MarkdownContext, diff?: DiffRender): ReactNode {
  const { hast, refs, nonce } = toSafeHast(diff?.split ? splitTree(tree) : tree);
  if (!diff) dropSources(hast, null);
  return toJsxRuntime(hast, { Fragment, jsx: jsx as Jsx, jsxs: jsxs as Jsx, components: componentsFor(ctx, refs, nonce, diff), passNode: true });
}
