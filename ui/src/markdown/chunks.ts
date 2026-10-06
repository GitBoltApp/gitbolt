import type { Definition, FootnoteDefinition, Nodes, Root, RootContent } from 'mdast';
import { visit } from 'unist-util-visit';
import { MD_BASE_FONT_PX } from './fontPx';

/** Source characters per chunk: one chunk's hast, sanitizing and React render fit well inside a
 * 200 ms task (ruling 21). */
export const CHUNK_CHARS = 8_192;

declare module 'mdast' {
  /** `gbChars`: a chunk's length in source characters (its placeholder height comes from it). */
  interface RootData { gbChars?: number }
}

/** Rendered height per source character, roughly (12px text at 1.55, File View's 880px measure,
 * block margins): a chunk not laid out yet holds about its height, so anchors drift less. */
const PX_PER_CHAR = 0.18;
/** A chunk's estimated height in px, from its source length (`gbChars`), for text of `fontPx`
 * (the pane's, `MdFontPx`): PX_PER_CHAR is 12px's, and a larger size scales it twice over, as
 * each line is taller and holds fewer characters in the same measure. */
export const chunkHeightOf = (tree: Root, fontPx = MD_BASE_FONT_PX): number =>
  Math.max(40, Math.round((tree.data?.gbChars ?? CHUNK_CHARS) * PX_PER_CHAR * (fontPx / MD_BASE_FONT_PX) ** 2));

const BLOCK_TAG = /<(\/?)(details|div|table|blockquote|section|picture|ul|ol|dl|p)\b[^>]*?(\/?)>/gi;

/** The net count of block-level HTML tags a raw HTML node leaves open. */
export function htmlDepth(value: string): number {
  let d = 0;
  for (const m of value.matchAll(BLOCK_TAG)) if (m[3] !== '/') d += m[1] ? -1 : 1;
  return d;
}

/** A copy of `node` without `position`: smaller to send, and the renderer doesn't need offsets. */
export function withoutPositions<T extends Nodes>(node: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'position') continue;
    out[k] = k === 'children' && Array.isArray(v) ? v.map((c) => withoutPositions(c as Nodes)) : v;
  }
  return out as T;
}

function footnoteIds(nodes: RootContent[]): string[] {
  const ids: string[] = [];
  for (const n of nodes) visit(n, 'footnoteReference', (r) => { ids.push(r.identifier); });
  return ids;
}

/** `tree` cut into roots of about `size` source characters at top-level block boundaries, never
 * inside an open HTML block. Every chunk carries the document's link definitions (so a
 * `[text][ref]` resolves in any chunk); a footnote definition goes with the first chunk that
 * references it, else the last one. Positions are dropped. */
export function splitChunks(tree: Root, size = CHUNK_CHARS): Root[] {
  const defs = tree.children.filter((n): n is Definition => n.type === 'definition').map((n) => withoutPositions(n));
  const notes = new Map(tree.children.filter((n): n is FootnoteDefinition => n.type === 'footnoteDefinition').map((n) => [n.identifier, withoutPositions(n)] as const));
  const blocks = tree.children.filter((n) => n.type !== 'definition' && n.type !== 'footnoteDefinition');
  const groups: RootContent[][] = [];
  const lengths: number[] = [];
  let cur: RootContent[] = [];
  let start = blocks[0]?.position?.start.offset ?? 0;
  let end = start;
  let depth = 0;
  for (const b of blocks) {
    cur.push(b);
    if (b.type === 'html') depth = Math.max(0, depth + htmlDepth(b.value));
    end = b.position?.end.offset ?? end;
    if (depth === 0 && end - start >= size) {
      groups.push(cur);
      lengths.push(end - start);
      cur = [];
      start = end;
    }
  }
  if (cur.length > 0 || groups.length === 0) {
    groups.push(cur);
    lengths.push(end - start);
  }
  const placed = new Set<string>();
  const roots: Root[] = groups.map((g, i) => {
    const own: FootnoteDefinition[] = [];
    for (const id of footnoteIds(g)) {
      const d = notes.get(id);
      if (d && !placed.has(id)) { placed.add(id); own.push(d); }
    }
    return { type: 'root', children: [...g.map((n) => withoutPositions(n)), ...defs, ...own], data: { gbChars: lengths[i] } };
  });
  for (const [id, d] of notes) if (!placed.has(id)) roots[roots.length - 1]!.children.push(d);
  return roots;
}
