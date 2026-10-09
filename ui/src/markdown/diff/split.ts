import type { Code, Heading, List, ListItem, Nodes, Parent, Root, RootContent, TableRow } from 'mdast';
import { htmlDepth } from '../chunks';
import type { DiffBlockNode, DiffMark, DiffPairNode, SplitCellNode, SplitRowNode } from './nodes';

type Side = 'old' | 'new';
/** One aligned unit of the split view: what each side shows (`null`: a placeholder). */
interface Row { mark: DiffMark | null; old: RootContent[] | null; neu: RootContent[] | null; joined?: boolean }

const MARKED = new Set(['diffBlock', 'diffPair', 'diffIns', 'diffDel']);
/** Whether a merged node holds any diff mark. */
function hasMarks(n: Nodes): boolean {
  if (MARKED.has(n.type)) return true;
  if ((n.type === 'listItem' || n.type === 'tableRow') && n.data?.gbDiff !== undefined) return true;
  return 'children' in n && (n.children as Nodes[]).some(hasMarks);
}

const kids = (n: Parent, side: Side) => (n.children as Nodes[]).flatMap((c) => sided(c, side));

/** The split view's placeholder for a table row only the other side has: as many cells, blank. */
const emptyRow = (r: TableRow): TableRow =>
  ({ type: 'tableRow', data: { gbEmpty: true }, children: r.children.map(() => ({ type: 'tableCell', children: [{ type: 'text', value: ' ' }] })) });

/** A copy of `n` without its source lines (review comments): a container split into rows is
 * copied into each row, and its lines belong to none of them (its items and blocks carry theirs). */
function bare<T extends Nodes>(n: T): T {
  if (!n.data?.gbSrc) return n;
  const { gbSrc: _lines, ...data } = n.data;
  return { ...n, data } as T;
}

/** A changed diagram's half (`0`: removed, `1`: added) carrying the pair's source lines: each
 * column shows its own side's (review comments). */
function half(pair: DiffPairNode, i: 0 | 1): DiffBlockNode {
  const b = pair.children[i];
  const gbSrc = pair.data?.gbSrc;
  return gbSrc ? { ...b, data: { ...b.data, gbSrc } } : b;
}

/**
 * A merged node (`diffTree`) as one side shows it: the other side's words, blocks, items and
 * code lines left out (a table row becomes a blank placeholder row, to keep the rows lined up), a
 * changed diagram's own half, and on the old side, its items' old numbers and checkboxes and no
 * heading ids (the new side's heading keeps the anchor). A copy: the merged tree isn't changed.
 */
function sided(n: Nodes, side: Side): Nodes[] {
  const other: DiffMark = side === 'old' ? 'added' : 'removed';
  switch (n.type) {
    case 'diffBlock': return n.mark === other ? [] : [{ ...n, children: kids(n, side) } as Nodes];
    case 'diffPair': return sided(half(n, side === 'old' ? 0 : 1), side);
    case 'diffIns': return side === 'old' ? [] : [{ ...n, children: kids(n, side) } as Nodes];
    case 'diffDel': return side === 'new' ? [] : [{ ...n, children: kids(n, side) } as Nodes];
    case 'listItem': {
      if (n.data?.gbDiff === other) return [];
      const item: ListItem = { ...n, children: kids(n, side) as ListItem['children'] };
      if (side === 'new' || !n.data) return [item];
      const { gbOldValue, gbOldChecked, ...data } = n.data;
      return [{ ...item, ...(gbOldChecked !== undefined ? { checked: gbOldChecked } : {}), data: { ...data, ...(gbOldValue !== undefined ? { gbValue: gbOldValue } : {}) } }];
    }
    case 'tableRow': return n.data?.gbDiff === other ? [emptyRow(n)] : [{ ...n, children: kids(n, side) } as Nodes];
    case 'code': {
      const marks = n.data?.gbLines;
      if (marks === undefined) return [n];
      const drop = side === 'old' ? '+' : '-';
      const lines = n.value.split('\n');
      const keep = lines.map((_, i) => marks[i] !== drop);
      const words = n.data?.gbWords?.split(';').filter((_, i) => keep[i]).join(';');
      const code: Code = { ...n, value: lines.filter((_, i) => keep[i]).join('\n'), data: { ...n.data, gbLines: [...marks].filter((_, i) => keep[i]).join(''), ...(words !== undefined ? { gbWords: words } : {}) } };
      return [code];
    }
    case 'heading': {
      const props = n.data?.hProperties;
      const h: Heading = { ...n, children: kids(n, side) as Heading['children'] };
      if (side === 'new' || !props || !('id' in props)) return [h];
      const { id: _id, ...rest } = props;
      return [{ ...h, data: { ...n.data, hProperties: rest } }];
    }
    default: return ['children' in n ? ({ ...n, children: kids(n, side) } as Nodes) : n];
  }
}

const sideOf = (nodes: readonly RootContent[], side: Side) => nodes.flatMap((n) => sided(n, side)) as RootContent[];

/** A unit both sides show: as it is (changed inside, when it holds marks). */
const rowFor = (nodes: RootContent[]): Row => (nodes.some(hasMarks)
  ? { mark: 'changed', old: sideOf(nodes, 'old'), neu: sideOf(nodes, 'new') }
  : { mark: null, old: sideOf(nodes, 'old'), neu: nodes });

/** Rows split from one container (a list's items, a blockquote's blocks), each side wrapped in
 * a copy of it; all but the last continue it (`joined`). */
function within(rows: Row[], shell: (children: RootContent[]) => RootContent): Row[] {
  return rows.map((r, i) => ({
    mark: r.mark,
    old: r.old && [shell(r.old)],
    neu: r.neu && [shell(r.neu)],
    ...(i < rows.length - 1 ? { joined: true } : {}),
  }));
}

/** A changed list: a row per marked item, and one per run of unmarked ones (R12's item alignment). */
function listRows(list: List): Row[] {
  const rows: Row[] = [];
  let run: ListItem[] = [];
  const flush = () => { if (run.length > 0) rows.push(rowFor(run as RootContent[])); run = []; };
  for (const it of list.children) {
    if (!hasMarks(it)) { run.push(it); continue; }
    flush();
    const mark = it.data?.gbDiff;
    if (mark === 'added') rows.push({ mark, old: null, neu: [it as RootContent] });
    else if (mark === 'removed') rows.push({ mark, old: sideOf([it as RootContent], 'old'), neu: null });
    else rows.push(rowFor([it as RootContent]));
  }
  flush();
  return within(rows, (items) => bare({ ...list, children: items as ListItem[] }));
}

function nodeRows(n: RootContent): Row[] {
  switch (n.type) {
    case 'diffBlock':
      if (n.mark === 'added') return [{ mark: 'added', old: null, neu: [n] }];
      if (n.mark === 'removed') return [{ mark: 'removed', old: sideOf([n], 'old'), neu: null }];
      return [rowFor([n])];
    case 'diffPair': return [{ mark: 'changed', old: [half(n, 0)], neu: [half(n, 1)] }];
    case 'list': return hasMarks(n) ? listRows(n) : [rowFor([n])];
    case 'blockquote': return hasMarks(n) ? within(flowRows(n.children), (children) => bare({ ...n, children: children as typeof n.children })) : [rowFor([n])];
    default: return [rowFor([n])];
  }
}

/** A merged flow's rows, one per aligned unit. A run an HTML block holds open is one row: it
 * renders whole (R13). */
function flowRows(flow: readonly RootContent[]): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < flow.length; i++) {
    const n = flow[i]!;
    if (n.type === 'html' && htmlDepth(n.value) > 0) {
      const run: RootContent[] = [n];
      let depth = htmlDepth(n.value);
      while (depth > 0 && i + 1 < flow.length) {
        const m = flow[++i]!;
        run.push(m);
        if (m.type === 'html') depth = Math.max(0, depth + htmlDepth(m.value));
      }
      rows.push(rowFor(run));
    } else rows.push(...nodeRows(n));
  }
  return rows;
}

const cell = (side: Side, nodes: RootContent[] | null): SplitCellNode =>
  (nodes ? { type: 'splitCell', side, children: nodes as SplitCellNode['children'] } : { type: 'splitCell', side, empty: true, children: [] });

/**
 * The split view of a rendered diff (or of one of its chunks): the merged tree (`diffTree`) as
 * rows, one per aligned unit, each holding the old side's cell and the new side's. Unchanged
 * blocks show on both sides; a removed block on the left with a placeholder on the right, an
 * added one the other way; a changed block's old side keeps its removed words, code lines and
 * diagram, the new side its added ones. A changed list or blockquote is split into rows per item
 * or block, so they stay lined up. Link and footnote definitions follow the rows, as they are.
 */
export function splitTree(root: Root): Root {
  const isDef = (n: RootContent) => n.type === 'definition' || n.type === 'footnoteDefinition';
  const rows = flowRows(root.children.filter((n) => !isDef(n))).map((r): SplitRowNode => ({
    type: 'splitRow',
    mark: r.mark,
    ...(r.joined ? { joined: true as const } : {}),
    children: [cell('old', r.old), cell('new', r.neu)],
  }));
  return { ...root, children: [...rows, ...root.children.filter(isDef)] };
}
