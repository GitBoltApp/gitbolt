import { diffArrays, diffWordsWithSpace } from 'diff';
import type { Nodes, RootContent } from 'mdast';
import { htmlDepth } from '../chunks';

/**
 * One alignable unit of a flow (the document, a blockquote, a list item, or a list's items and a
 * table's rows): one block, or the run of blocks an HTML block holds open (`<details>` …
 * `</details>`), which renders whole or not at all (R13).
 */
export interface Unit { nodes: RootContent[]; kind: string; key: string; text: string; chars: number }

export type Op =
  | { op: 'same'; old: Unit; new: Unit }
  | { op: 'removed'; old: Unit }
  | { op: 'added'; new: Unit }
  | { op: 'changed'; old: Unit; new: Unit };

/** How far apart, in one gap of removed and added units, two units may still pair. */
export const PAIR_LOOKAHEAD = 8;
/** Paragraphs, headings, list items and table rows pair when this share of their text is common
 * (or by `containment`, below). */
export const PAIR_SIMILARITY = 0.4;
/** A block that grew or shrank a lot also pairs when this share of the shorter one's words is in
 * the longer one, in order (`containment`)... */
export const PAIR_CONTAINMENT = 0.65;
/** ...if the shorter one has at least this many words: a two-word item is in too many others. */
export const CONTAIN_MIN_WORDS = 4;
/** A block of at most this many words is short: too few for `similarity` or `containment` to
 * judge, so short blocks of one kind and level pair by `looselyAlike` instead. */
export const SHORT_WORDS = 3;
/** Longer blocks never word-diff: they show as removed and added (R14). */
export const WORD_DIFF_MAX_CHARS = 10_000;
/** The whole rendered diff (alignment, pairing, word and line diffs) gives up after this long
 * (R14): the view falls back to Source. */
export const ALIGN_TIMEOUT_MS = 1_500;

/** Thrown when the diff's one deadline has passed (R14). */
export class GaveUp extends Error {
  constructor() { super('the rendered diff ran out of time'); }
}
/** The ms left before `deadline` (a `Date.now()` time, as jsdiff's `timeout` counts), to hand
 * jsdiff as its `timeout`; throws `GaveUp` once it has passed. */
export function left(deadline: number): number {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new GaveUp();
  return ms;
}
/** A jsdiff result run with `timeout: left(deadline)`: `undefined` means it ran out of time. */
export function inTime<T>(r: T | undefined): T {
  if (r === undefined) throw new GaveUp();
  return r;
}

const IGNORED = new Set(['type', 'position', 'data', 'spread', 'children']);
const squash = (s: string) => s.replace(/\s+/g, ' ');
/** CRLF (or a lone CR) as LF: a file's line endings never show as a change. */
export const lf = (s: string) => s.replace(/\r\n?/g, '\n');
function normValue(type: string, v: string): string {
  if (type === 'code') return lf(v).replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
  if (type === 'html') return squash(v).trim();
  if (type === 'text') return squash(v);
  return v;
}
function canon(n: Nodes): unknown[] {
  const out: unknown[] = [n.type];
  for (const [k, v] of Object.entries(n)) {
    if (IGNORED.has(k)) continue;
    out.push(k, k === 'value' && typeof v === 'string' ? normValue(n.type, v) : v);
  }
  if ('children' in n) out.push((n.children as Nodes[]).map(canon));
  return out;
}

/** The blocks' identity for alignment (R5): structure and text, without positions, heading ids
 * (`data`), list tightness (`spread`) or whitespace that doesn't render; code keeps its
 * whitespace except at line ends. */
export const blockKey = (nodes: readonly Nodes[]): string => JSON.stringify(nodes.map(canon));

const BLOCK_PARENTS = new Set(['root', 'blockquote', 'list', 'listItem', 'table', 'tableRow', 'footnoteDefinition', 'diffBlock', 'diffPair']);
/** A node's text: blocks joined by newlines, inline content run together, images by their alt. */
export function plainText(n: Nodes): string {
  if ('value' in n && typeof n.value === 'string') return n.value;
  if (n.type === 'image') return n.alt ?? '';
  if (!('children' in n)) return '';
  return (n.children as Nodes[]).map(plainText).join(BLOCK_PARENTS.has(n.type) ? '\n' : '');
}

function kindOf(n: RootContent): string {
  switch (n.type) {
    case 'code': return n.lang === 'mermaid' ? 'mermaid' : `code:${n.lang ?? ''}`;
    case 'list': return n.ordered ? 'ol' : 'ul';
    case 'table': return n.data?.gbFrontmatter ? 'frontmatter' : `table:${n.align?.length ?? 0}`;
    default: return n.type;
  }
}

const sourceChars = (n: RootContent) => Math.max(1, (n.position?.end.offset ?? 0) - (n.position?.start.offset ?? 0));

export function unitOf(nodes: RootContent[], kind: string): Unit {
  return { nodes, kind, key: blockKey(nodes), text: nodes.map(plainText).join('\n'), chars: nodes.reduce((a, n) => a + sourceChars(n), 0) };
}

/** A flow's children as units. Link and footnote definitions aren't units: they render nowhere
 * in particular (`diffTree` carries them for the whole document). */
export function flowUnits(children: readonly RootContent[]): Unit[] {
  const units: Unit[] = [];
  let run: RootContent[] | null = null;
  let depth = 0;
  for (const n of children) {
    if (n.type === 'definition' || n.type === 'footnoteDefinition') continue;
    if (run) {
      run.push(n);
      if (n.type === 'html') depth = Math.max(0, depth + htmlDepth(n.value));
      if (depth === 0) { units.push(unitOf(run, 'html')); run = null; }
      continue;
    }
    // A block that only closes tags (depth < 0) is a unit of its own: depth never goes below 0,
    // and its stray tags can't close a diff wrapper (render.tsx parses a wrapper's HTML alone).
    if (n.type === 'html' && htmlDepth(n.value) > 0) { run = [n]; depth = htmlDepth(n.value); continue; }
    units.push(unitOf([n], kindOf(n)));
  }
  if (run) units.push(unitOf(run, 'html'));
  return units;
}

/** The share of the longer text both have in common, word by word (0–1); 0 past
 * WORD_DIFF_MAX_CHARS. Throws `GaveUp` past `deadline`. */
export function similarity(a: string, b: string, deadline = Infinity): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  if (max > WORD_DIFF_MAX_CHARS) return 0;
  let common = 0;
  for (const c of inTime(diffWordsWithSpace(a, b, { timeout: left(deadline) }))) if (!c.added && !c.removed) common += c.value.length;
  return common / max;
}

/** The share of the shorter text's words that the longer one has, in the same order (their
 * longest common subsequence over the shorter one's word count, 0-1); 0 when the shorter one has
 * fewer than CONTAIN_MIN_WORDS words, or past WORD_DIFF_MAX_CHARS. Throws `GaveUp` past
 * `deadline`. */
export function containment(a: string, b: string, deadline = Infinity): number {
  if (Math.max(a.length, b.length) > WORD_DIFF_MAX_CHARS) return 0;
  const wa = a.match(/\S+/g) ?? [];
  const wb = b.match(/\S+/g) ?? [];
  const shorter = Math.min(wa.length, wb.length);
  if (shorter < CONTAIN_MIN_WORDS) return 0;
  let common = 0;
  for (const c of inTime(diffArrays(wa, wb, { timeout: left(deadline) }))) if (!c.added && !c.removed) common += c.count ?? c.value.length;
  return common / shorter;
}

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const level = (u: Unit) => (u.nodes[0]!.type === 'heading' ? u.nodes[0].depth : 0);

/** Two blocks of one text kind and level too short to judge by `similarity`: two headings when
 * either has at most SHORT_WORDS words, or two other blocks that both do. */
function short(a: Unit, b: Unit): boolean {
  if (level(a) !== level(b)) return false;
  const [x, y] = [words(a.text).length, words(b.text).length];
  return (a.kind === 'heading' ? Math.min(x, y) : Math.max(x, y)) <= SHORT_WORDS;
}

/** The lower bar for short blocks: a word in common, or one's text starts the other's
 * (`Windows (in progress)` → `Windows`, `Install` → `Installing`). */
function looselyAlike(a: string, b: string): boolean {
  const theirs = new Set(words(b));
  if (words(a).some((w) => theirs.has(w))) return true;
  const [x, y] = [squash(a).trim().toLowerCase(), squash(b).trim().toLowerCase()];
  return x !== '' && y !== '' && (x.startsWith(y) || y.startsWith(x));
}

const ALWAYS = new Set(['ul', 'ol', 'blockquote', 'mermaid', 'frontmatter']);
const BY_TEXT = new Set(['paragraph', 'heading', 'listItem', 'tableRow']);
/** Whether `a` and `b` pair as one changed block. `only`: they're the gap's only removed and only
 * added unit, so two headings of one level, or two short blocks, pair whatever their text. */
function canPair(a: Unit, b: Unit, only: boolean, deadline: number): boolean {
  if (a.kind !== b.kind || a.nodes.length !== 1 || b.nodes.length !== 1) return false;
  if (ALWAYS.has(a.kind) || a.kind.startsWith('code:') || a.kind.startsWith('table:')) return true;
  if (!BY_TEXT.has(a.kind)) return false;
  if (only && level(a) === level(b) && (a.kind === 'heading' || short(a, b))) return true;
  if (short(a, b) && looselyAlike(a.text, b.text)) return true;
  return similarity(a.text, b.text, deadline) >= PAIR_SIMILARITY || containment(a.text, b.text, deadline) >= PAIR_CONTAINMENT;
}

/** One gap's removed and added units: each removed unit pairs with the first unpaired added one of
 * the same kind within PAIR_LOOKAHEAD (`canPair`), in order; the rest stay removed or added. */
function pairGap(old: readonly Unit[], neu: readonly Unit[], deadline: number): Op[] {
  const ops: Op[] = [];
  const only = old.length === 1 && neu.length === 1;
  let oi = 0;
  let nj = 0;
  for (let r = 0; r < old.length; r++) {
    let k = -1;
    for (let c = nj; c < Math.min(neu.length, nj + PAIR_LOOKAHEAD); c++) if (canPair(old[r]!, neu[c]!, only, deadline)) { k = c; break; }
    if (k < 0) continue;
    for (; oi < r; oi++) ops.push({ op: 'removed', old: old[oi]! });
    for (; nj < k; nj++) ops.push({ op: 'added', new: neu[nj]! });
    ops.push({ op: 'changed', old: old[r]!, new: neu[k]! });
    oi = r + 1;
    nj = k + 1;
  }
  for (; oi < old.length; oi++) ops.push({ op: 'removed', old: old[oi]! });
  for (; nj < neu.length; nj++) ops.push({ op: 'added', new: neu[nj]! });
  return ops;
}

/** Two flows lined up (spec: LCS on normalized block text, by Myers' diff over `blockKey`s), each
 * gap's units paired by `pairGap`. `null`: it ran past `deadline` (a `Date.now()` time: the
 * whole diff's one deadline, R14). */
export function alignUnits(old: readonly Unit[], neu: readonly Unit[], deadline = Date.now() + ALIGN_TIMEOUT_MS): Op[] | null {
  try {
    return align(old, neu, deadline);
  } catch (e) {
    if (e instanceof GaveUp) return null;
    throw e;
  }
}

function align(old: readonly Unit[], neu: readonly Unit[], deadline: number): Op[] {
  const parts = inTime(diffArrays(old.map((u) => u.key), neu.map((u) => u.key), { timeout: left(deadline) }));
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  let gapOld: Unit[] = [];
  let gapNew: Unit[] = [];
  const flush = () => { ops.push(...pairGap(gapOld, gapNew, deadline)); gapOld = []; gapNew = []; };
  for (const p of parts) {
    const n = p.count ?? p.value.length;
    if (p.removed) { gapOld.push(...old.slice(i, i + n)); i += n; }
    else if (p.added) { gapNew.push(...neu.slice(j, j + n)); j += n; }
    else {
      flush();
      for (let k = 0; k < n; k++) ops.push({ op: 'same', old: old[i + k]!, new: neu[j + k]! });
      i += n;
      j += n;
    }
  }
  flush();
  return ops;
}
