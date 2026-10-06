import type { Blockquote, Code, Definition, FootnoteDefinition, Heading, Image, ImageReference, Link, LinkReference, List, ListItem, Nodes, Paragraph, PhrasingContent, Root, RootContent, Table, TableCell, TableRow } from 'mdast';
import { EXIT, visit } from 'unist-util-visit';
import { parseMarkdown } from '../parse';
import type { MdFlavor } from '../types';
import { ALIGN_TIMEOUT_MS, alignUnits, blockKey, flowUnits, GaveUp, left, unitOf, WORD_DIFF_MAX_CHARS, type Op, type Unit } from './blocks';
import type { DiffBlockNode, DiffMark } from './nodes';
import { codeLines, inlineDiff } from './words';

export interface DiffResult { root: Root; changes: number; gaveUp: boolean }
/** `deadline`: the whole diff's one deadline (a `Date.now()` time, R14), set as it starts.
 * `refs`: the old side's link definitions whose URL or title changed, by identifier. */
interface Ctx { changes: number; deadline: number; refs: ReadonlyMap<string, Definition> }

const block = (mark: DiffMark, nodes: readonly RootContent[], note?: string): DiffBlockNode =>
  ({ type: 'diffBlock', mark, children: [...nodes] as DiffBlockNode['children'], ...(note !== undefined ? { note } : {}) });

type Ref = LinkReference | ImageReference;
const isChangedRef = (n: Nodes, c: Ctx): n is Ref => (n.type === 'linkReference' || n.type === 'imageReference') && c.refs.has(n.identifier);

/** A reference to a changed definition as the old side resolved it: a plain link or image. */
function resolvedOld(n: Ref, c: Ctx): Link | Image {
  const d = c.refs.get(n.identifier)!;
  return n.type === 'linkReference'
    ? { type: 'link', url: d.url, title: d.title ?? null, children: n.children }
    : { type: 'image', url: d.url, title: d.title ?? null, alt: n.alt };
}

/** Whether `nodes` use a link definition whose URL or title changed. */
function usesChangedRef(nodes: readonly Nodes[], c: Ctx): boolean {
  if (c.refs.size === 0) return false;
  let found = false;
  for (const n of nodes) visit(n, (x: Nodes) => { if (isChangedRef(x, c)) { found = true; return EXIT; } });
  return found;
}

/** Merged inline content with its uses of changed link definitions marked (the definitions show
 * nothing themselves): one the words kept is shown removed, as the old side resolved it, and
 * added; one in removed words resolves as the old side did. */
function markRefs(nodes: readonly PhrasingContent[], c: Ctx, side: 'both' | 'old' | 'new' = 'both'): PhrasingContent[] {
  if (c.refs.size === 0) return [...nodes];
  return nodes.flatMap((n): PhrasingContent[] => {
    if (n.type === 'diffDel') return [{ ...n, children: markRefs(n.children, c, 'old') }];
    if (n.type === 'diffIns') return [{ ...n, children: markRefs(n.children, c, 'new') }];
    if (isChangedRef(n, c)) {
      if (side === 'old') return [resolvedOld(n, c)];
      if (side === 'new') return [n];
      return [{ type: 'diffDel', children: [resolvedOld(n, c)] }, { type: 'diffIns', children: [n] }];
    }
    return 'children' in n ? [{ ...n, children: markRefs(n.children as PhrasingContent[], c, side) } as PhrasingContent] : [n];
  });
}

/** A copy of a removed node as the old side shows it: without heading ids (the new document's
 * heading keeps the anchor), its references to changed link definitions resolved as they were. */
function oldSide<T extends RootContent>(n: T, c: Ctx): T {
  const copy = structuredClone(n);
  visit(copy, (x: Nodes, i, parent) => {
    if (x.type === 'heading') {
      const props = x.data?.hProperties;
      if (props && 'id' in props) {
        const { id: _id, ...rest } = props;
        x.data = { ...x.data, hProperties: rest };
      }
    } else if (parent && i !== undefined && isChangedRef(x, c)) {
      (parent.children as Nodes[])[i] = resolvedOld(x, c);
    }
  });
  return copy;
}

/** `alignUnits` under the diff's deadline: past it, the whole diff gives up (`GaveUp`). */
function align(old: readonly Unit[], neu: readonly Unit[], c: Ctx): Op[] {
  const ops = alignUnits(old, neu, c.deadline);
  if (!ops) throw new GaveUp();
  // A kept unit that uses a changed link definition is changed: its links show the change.
  return c.refs.size === 0 ? ops : ops.map((op) => (op.op === 'same' && usesChangedRef(op.new.nodes, c) ? { ...op, op: 'changed' } : op));
}

/** Two flows merged: unchanged blocks as they are (the new side's), removed and added ones in
 * marked blocks, changed ones with their changes inside. */
function diffFlow(old: readonly RootContent[], neu: readonly RootContent[], c: Ctx): RootContent[] {
  const ops = align(flowUnits(old), flowUnits(neu), c);
  const out: RootContent[] = [];
  for (const op of ops) {
    if (op.op === 'same') out.push(...op.new.nodes);
    else if (op.op === 'added') { c.changes++; out.push(block('added', op.new.nodes)); }
    else if (op.op === 'removed') { c.changes++; out.push(block('removed', op.old.nodes.map((x) => oldSide(x, c)))); }
    else if (op.old.nodes.length !== 1 || op.new.nodes.length !== 1) { c.changes += 2; out.push(block('removed', op.old.nodes.map((x) => oldSide(x, c))), block('added', op.new.nodes)); }
    else out.push(...changed(op.old.nodes[0]!, op.new.nodes[0]!, c));
  }
  return out;
}

/** A changed pair (`alignUnits` paired them, so they're of the same kind). */
function changed(o: RootContent, n: RootContent, c: Ctx): RootContent[] {
  const replaced = (): RootContent[] => { c.changes += 2; return [block('removed', [oldSide(o, c)]), block('added', [n])]; };
  if (n.type === 'paragraph' || n.type === 'heading') {
    const merged = inlineDiff((o as Paragraph | Heading).children, n.children, c.deadline);
    if (!merged) return replaced();
    c.changes++;
    return [block('changed', [{ ...n, children: markRefs(merged, c) }])];
  }
  if (n.type === 'code') {
    const was = o as Code;
    if (n.lang !== 'mermaid' && Math.max(was.value.length, n.value.length) > WORD_DIFF_MAX_CHARS) return replaced();
    c.changes++;
    if (n.lang === 'mermaid') return [{ type: 'diffPair', children: [block('removed', [was]), block('added', [n])] }];
    const { value, marks, words } = codeLines(was.value, n.value, c.deadline);
    // Only the info string changed: no line shows it, so a note says what did.
    const note = /[+-]/.test(marks) ? undefined
      : (was.lang ?? null) !== (n.lang ?? null) ? `Language changed: ${was.lang ?? 'none'} → ${n.lang ?? 'none'}`
        : `Code block info changed: ${was.meta ?? 'none'} → ${n.meta ?? 'none'}`;
    return [block('changed', [{ ...n, value, data: { ...n.data, gbLines: marks, ...(words !== undefined ? { gbWords: words } : {}) } }], note)];
  }
  // A container whose content changed counts nothing itself and stays unmarked: the innermost
  // marked node counts once and carries the bar. A wholly added or removed container is one mark.
  if (n.type === 'blockquote') return [{ ...n, children: diffFlow((o as Blockquote).children, n.children, c) as Blockquote['children'] }];
  // A change that shows inside nothing (a list's start number, a table's alignment): the block
  // is marked, with a note saying what changed. Where its content holds marks, they show it.
  const before = c.changes;
  const noted = (node: RootContent, note: string): RootContent[] => {
    if (c.changes !== before) return [node];
    c.changes++;
    return [block('changed', [node], note)];
  };
  if (n.type === 'list') {
    const l = diffList(o as List, n, c);
    return n.ordered && ((o as List).start ?? 1) !== (n.start ?? 1) ? noted(l, 'Start number changed') : [l];
  }
  if (n.type === 'table') {
    const t = diffTable(o as Table, n, c);
    if (!t) return replaced();
    return JSON.stringify((o as Table).align ?? []) !== JSON.stringify(n.align ?? []) ? noted(t, 'Alignment changed') : [t];
  }
  return replaced();
}

/** Two lists' items lined up in the new list (R12): kept items as they are, added and removed
 * ones marked, a changed one with its content diffed. An ordered list's items carry their
 * numbers; a removed item keeps its old one and doesn't shift the others. */
function diffList(o: List, n: List, c: Ctx): List {
  const ops = align(o.children.map((i) => unitOf([i], 'listItem')), n.children.map((i) => unitOf([i], 'listItem')), c);
  const oi = new Map(o.children.map((it, i) => [it, i] as const));
  const ni = new Map(n.children.map((it, i) => [it, i] as const));
  const num = (l: List, at: Map<ListItem, number>, it: ListItem) => (n.ordered ? (l.start ?? 1) + at.get(it)! : undefined);
  // `was`: a kept or changed item's old side, for the split view (its number and checkbox there).
  const mark = (it: ListItem, gbDiff: DiffMark | undefined, gbValue: number | undefined, was?: ListItem): ListItem => {
    const gbOldValue = was ? num(o, oi, was) : undefined;
    const old = {
      ...(gbOldValue !== undefined && gbOldValue !== gbValue ? { gbOldValue } : {}),
      ...(was && (was.checked ?? null) !== (it.checked ?? null) ? { gbOldChecked: was.checked ?? null } : {}),
    };
    return gbDiff === undefined && gbValue === undefined && Object.keys(old).length === 0 ? it
      : { ...it, data: { ...it.data, ...(gbDiff ? { gbDiff } : {}), ...(gbValue !== undefined ? { gbValue } : {}), ...old } };
  };
  const items: ListItem[] = [];
  for (const op of ops) {
    if (op.op === 'same') {
      const it = op.new.nodes[0] as ListItem;
      items.push(mark(it, undefined, num(n, ni, it), op.old.nodes[0] as ListItem));
    } else if (op.op === 'added') {
      c.changes++;
      const it = op.new.nodes[0] as ListItem;
      items.push(mark(it, 'added', num(n, ni, it)));
    } else if (op.op === 'removed') {
      c.changes++;
      const it = op.old.nodes[0] as ListItem;
      items.push(mark(oldSide(it, c), 'removed', num(o, oi, it)));
    } else {
      const a = op.old.nodes[0] as ListItem;
      const b = op.new.nodes[0] as ListItem;
      const before = c.changes;
      const kids = diffFlow(a.children, b.children, c);
      // An item whose content is one changed paragraph carries the mark itself, its paragraph
      // inline (a wrapper would push a task's checkbox onto its own line, and loosen a tight list).
      const only = kids.length === 1 && kids[0]!.type === 'diffBlock' ? kids[0] : null;
      if (only && only.mark === 'changed' && only.children.length === 1 && only.children[0]!.type === 'paragraph') {
        items.push(mark({ ...b, children: [only.children[0]] }, 'changed', num(n, ni, b), a));
        continue;
      }
      // The innermost marked node counts and carries the bar: an item whose content holds marks
      // stays unmarked. Only a change of the item's own (a ticked checkbox) marks the item.
      const own = c.changes === before && (a.checked ?? null) !== (b.checked ?? null);
      if (own) c.changes++;
      items.push(mark({ ...b, children: kids as ListItem['children'] }, own ? 'changed' : undefined, num(n, ni, b), a));
    }
  }
  return { ...n, children: items };
}

/** A changed row, cell by cell: word changes where they fit, else the old cell removed and the
 * new one added. */
function changedRow(a: TableRow | undefined, b: TableRow, c: Ctx): TableRow {
  const cells: TableCell[] = b.children.map((cell, k) => {
    const was: PhrasingContent[] = a?.children[k]?.children ?? [];
    const merged = inlineDiff(was, cell.children, c.deadline);
    const fallback: PhrasingContent[] = [
      ...(was.length > 0 ? [{ type: 'diffDel', children: was } as PhrasingContent] : []),
      ...(cell.children.length > 0 ? [{ type: 'diffIns', children: cell.children } as PhrasingContent] : []),
    ];
    return { ...cell, children: markRefs(merged ?? fallback, c) };
  });
  return { ...b, children: cells, data: { ...b.data, gbDiff: 'changed' } };
}

/** Two tables of the same width (R12): the header row first (diffed cell by cell), then the body
 * rows lined up. */
function diffTable(o: Table, n: Table, c: Ctx): Table | null {
  const [oh, ...ob] = o.children;
  const [nh, ...nb] = n.children;
  if (!nh) return null;
  let head = nh;
  if (!oh || blockKey([oh]) !== blockKey([nh]) || usesChangedRef([nh], c)) { c.changes++; head = changedRow(oh, nh, c); }
  const ops = align(ob.map((r) => unitOf([r], 'tableRow')), nb.map((r) => unitOf([r], 'tableRow')), c);
  const rows: TableRow[] = [head];
  for (const op of ops) {
    if (op.op === 'same') rows.push(op.new.nodes[0] as TableRow);
    else if (op.op === 'added') { c.changes++; const r = op.new.nodes[0] as TableRow; rows.push({ ...r, data: { ...r.data, gbDiff: 'added' } }); }
    else if (op.op === 'removed') { c.changes++; const r = oldSide(op.old.nodes[0] as TableRow, c); rows.push({ ...r, data: { ...r.data, gbDiff: 'removed' } }); }
    else { c.changes++; rows.push(changedRow(op.old.nodes[0] as TableRow, op.new.nodes[0] as TableRow, c)); }
  }
  return { ...n, children: rows };
}

/** A document's link and footnote definitions from anywhere in it, by identifier: the first one
 * wins, as when it renders. */
function definitionsIn(r: Root): { links: Map<string, Definition>; notes: Map<string, FootnoteDefinition> } {
  const links = new Map<string, Definition>();
  const notes = new Map<string, FootnoteDefinition>();
  visit(r, (x: Nodes) => {
    if (x.type === 'definition' && !links.has(x.identifier)) links.set(x.identifier, x);
    if (x.type === 'footnoteDefinition' && !notes.has(x.identifier)) notes.set(x.identifier, x);
  });
  return { links, notes };
}

/** The old side's link definitions whose URL or title the new side changed. */
function changedLinks(old: Map<string, Definition>, neu: Map<string, Definition>): Map<string, Definition> {
  const out = new Map<string, Definition>();
  for (const [id, was] of old) {
    const now = neu.get(id);
    if (now && (now.url !== was.url || (now.title ?? null) !== (was.title ?? null))) out.set(id, was);
  }
  return out;
}

/**
 * The merged document's definitions. Link definitions: the new side's, then the old side's the
 * new one lacks (a removed block's `[text][ref]` still resolves; a changed one's uses are marked
 * where they are, `markRefs`). Footnote definitions are diffed by identifier: added, removed (it
 * resolves on the old side), or changed with its content diffed. Each counts as a change, when
 * something in `merged` references it (an unreferenced footnote doesn't render).
 */
function diffDefinitions(old: Root, neu: Root, merged: readonly RootContent[], c: Ctx): RootContent[] {
  const was = definitionsIn(old);
  const now = definitionsIn(neu);
  const links = [...now.links.values(), ...[...was.links.values()].filter((d) => !now.links.has(d.identifier))];
  const cited = new Set<string>();
  for (const n of merged) visit(n, 'footnoteReference', (r) => { cited.add(r.identifier); });
  const notes: FootnoteDefinition[] = [];
  for (const [id, n] of now.notes) {
    const o = was.notes.get(id);
    if (!cited.has(id)) notes.push(n);
    else if (!o) { c.changes++; notes.push({ ...n, children: [block('added', n.children)] as FootnoteDefinition['children'] }); }
    else {
      const before = c.changes;
      const kids = diffFlow(o.children, n.children, c);
      notes.push(c.changes === before ? n : { ...n, children: kids as FootnoteDefinition['children'] });
    }
  }
  for (const [id, o] of was.notes) {
    if (now.notes.has(id)) continue;
    if (!cited.has(id)) { notes.push(o); continue; }
    c.changes++;
    notes.push({ ...o, children: [block('removed', o.children.map((x) => oldSide(x, c)))] as FootnoteDefinition['children'] });
  }
  return [...links, ...notes];
}

/** A node's length in source characters: its own span, or its children's. */
function charsOf(n: Nodes): number {
  const p = n.position;
  if (p?.start.offset !== undefined && p.end.offset !== undefined) return Math.max(1, p.end.offset - p.start.offset);
  return 'children' in n ? Math.max(1, (n.children as Nodes[]).reduce((a, k) => a + charsOf(k), 0)) : 1;
}

/**
 * The rendered diff's tree (5C): `old` and `neu` lined up block by block into ONE document the
 * renderer shows like any other. It holds the nodes `diffBlock`, `diffPair`, `diffIns` and
 * `diffDel`, and marks on list items, table rows and code lines (`nodes.ts`). Definitions come
 * from `diffDefinitions`. Each top-level node gets a position spanning its source length, so
 * `splitChunks` sizes the chunks as for any document. The input trees are never changed: shared
 * nodes are reused, and changed ones are copies. `gaveUp`: the diff ran past its one deadline,
 * `timeout` ms after it started (R14), anywhere: alignment, pairing, word or line diffs.
 * `changes` counts each marked node once (a block, list item, table row or diagram pair); a
 * container holding marks counts nothing itself.
 */
export function diffTrees(old: Root, neu: Root, opts: { timeout?: number } = {}): DiffResult {
  const deadline = Date.now() + (opts.timeout ?? ALIGN_TIMEOUT_MS);
  const c: Ctx = { changes: 0, deadline, refs: changedLinks(definitionsIn(old).links, definitionsIn(neu).links) };
  let merged: RootContent[];
  try {
    left(c.deadline);
    merged = diffFlow(old.children, neu.children, c);
    merged.push(...diffDefinitions(old, neu, merged, c));
  } catch (e) {
    if (e instanceof GaveUp) return { root: { type: 'root', children: [] }, changes: 0, gaveUp: true };
    throw e;
  }
  let at = 0;
  const children = merged.map((node) => {
    const len = charsOf(node);
    // Synthetic positions: only the offsets mean anything (chunk sizing). Line and column are
    // always 1 and map to no source line.
    const placed = { ...node, position: { start: { line: 1, column: 1, offset: at }, end: { line: 1, column: 1, offset: at + len } } };
    at += len;
    return placed;
  });
  return { root: { type: 'root', children, data: { gbChanges: c.changes } }, changes: c.changes, gaveUp: false };
}

/** Both texts parsed (5A's cached parse) and diffed. An added file is `old = ''`, a deleted one
 * `neu = ''` (R6). */
export function diffMarkdown(old: string, neu: string, flavor: MdFlavor): DiffResult {
  return diffTrees(parseMarkdown(old, flavor), parseMarkdown(neu, flavor));
}
