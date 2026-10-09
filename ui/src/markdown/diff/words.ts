import { diffLines, diffWordsWithSpace } from 'diff';
import type { PhrasingContent } from 'mdast';
import { inTime, left, lf, PAIR_SIMILARITY, similarity, WORD_DIFF_MAX_CHARS } from './blocks';

const PUA_START = 0xe000;
const PUA_SIZE = 0x1900; // U+E000–U+F8FF
const PUA = /[-]/;
/** Inline nodes a word diff treats as one token each: they change whole or not at all. */
const ATOMS = new Set(['inlineCode', 'image', 'imageReference', 'break', 'footnoteReference', 'reference', 'html']);
type Atom = Exclude<PhrasingContent, { children: unknown }>;
const isAtom = (n: PhrasingContent): n is Atom => ATOMS.has(n.type) || !('children' in n);
const atomKey = (n: PhrasingContent | PhrasingContent[]) => JSON.stringify(n, (k, v) => (k === 'position' ? undefined : v));

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const TAG = /<(\/?)([A-Za-z][\w-]*)\b[^>]*?(\/?)>/g;
/** The net count of elements an inline HTML node leaves open (void and self-closed tags,
 * comments and declarations count nothing). */
function tagDepth(value: string): number {
  let d = 0;
  for (const m of value.matchAll(TAG)) if (m[3] !== '/' && !VOID.has(m[2]!.toLowerCase())) d += m[1] ? -1 : 1;
  return d;
}

/** A token of a word diff: one node, or a run of inline HTML from an opening tag to the tag that
 * closes it (R13: open and close tags stay together), with what's between them. */
type Item = PhrasingContent | PhrasingContent[];

/** A list's nodes as a word diff walks them (`Item`). A tag nothing closes (`<repo>` written as a
 * placeholder) is an atom of its own, as is any other inline HTML. */
function items(list: readonly PhrasingContent[]): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < list.length; i++) {
    const n = list[i]!;
    let end = i;
    if (n.type === 'html' && tagDepth(n.value) > 0) {
      let depth = tagDepth(n.value);
      for (let j = i + 1; j < list.length; j++) {
        const m = list[j]!;
        if (m.type === 'html') depth += tagDepth(m.value);
        if (depth <= 0) { end = j; break; }
      }
    }
    out.push(end > i ? list.slice(i, end + 1) : n);
    i = end;
  }
  return out;
}

/**
 * The inline content's text, each atom as one private-use character standing for its content (the
 * same atom on both sides is the same character, so it can be common). Inline HTML is atoms
 * (`items`): the words around it still diff, and an element changes whole. `null`: it can't be
 * word-diffed (text that already has private-use characters; more distinct atoms than the area
 * holds).
 */
function flatten(nodes: readonly PhrasingContent[], atoms: Map<string, string>): string | null {
  let out = '';
  const walk = (list: readonly PhrasingContent[]): boolean => {
    for (const n of items(list)) {
      if (!Array.isArray(n) && n.type === 'text') {
        if (PUA.test(n.value)) return false;
        out += n.value;
      } else if (Array.isArray(n) || isAtom(n)) {
        const key = atomKey(n);
        let ch = atoms.get(key);
        if (ch === undefined) {
          if (atoms.size >= PUA_SIZE) return false;
          ch = String.fromCharCode(PUA_START + atoms.size);
          atoms.set(key, ch);
        }
        out += ch;
      } else if (!walk(n.children)) return false;
    }
    return true;
  };
  return walk(nodes) ? out : null;
}

/** The part of `nodes` covering flattened offsets [start, end): text cut at the edges, atoms
 * whole, formatting parents (emphasis, strong, links, …) copied around what's left inside them. */
function slice(nodes: readonly PhrasingContent[], start: number, end: number): PhrasingContent[] {
  let pos = 0;
  const walk = (list: readonly PhrasingContent[]): PhrasingContent[] => {
    const into: PhrasingContent[] = [];
    for (const n of items(list)) {
      if (pos >= end) break;
      if (!Array.isArray(n) && n.type === 'text') {
        const s = Math.max(start, pos);
        const e = Math.min(end, pos + n.value.length);
        if (e > s) into.push({ type: 'text', value: n.value.slice(s - pos, e - pos) });
        pos += n.value.length;
      } else if (Array.isArray(n) || isAtom(n)) {
        if (pos >= start) into.push(...(Array.isArray(n) ? n : [n]));
        pos += 1;
      } else {
        const kids = walk(n.children);
        if (kids.length > 0) into.push({ ...n, children: kids } as PhrasingContent);
      }
    }
    return into;
  };
  return walk(nodes);
}

/**
 * A changed block's inline content with its word-level changes (spec: `diffWordsWithSpace`):
 * common words from the new side, removed ones from the old side in `diffDel`, added ones in
 * `diffIns`, each keeping its formatting. A whitespace-only change marks nothing (R5). Inline HTML
 * changes whole (`items`): an element in a `diffDel`/`diffIns` renders on its own. `null`: the
 * block can't be word-diffed (`flatten`), or a side is over WORD_DIFF_MAX_CHARS (R14). Throws
 * `GaveUp` past `deadline` (the whole diff's).
 */
export function inlineDiff(old: readonly PhrasingContent[], neu: readonly PhrasingContent[], deadline = Infinity): PhrasingContent[] | null {
  const atoms = new Map<string, string>();
  const a = flatten(old, atoms);
  const b = a === null ? null : flatten(neu, atoms);
  if (a === null || b === null || Math.max(a.length, b.length) > WORD_DIFF_MAX_CHARS) return null;
  const out: PhrasingContent[] = [];
  let i = 0;
  let j = 0;
  for (const c of inTime(diffWordsWithSpace(a, b, { timeout: left(deadline) }))) {
    const n = c.value.length;
    const blank = /^\s*$/.test(c.value);
    if (c.removed) {
      if (!blank) out.push({ type: 'diffDel', children: slice(old, i, i + n) });
      i += n;
    } else if (c.added) {
      out.push(...(blank ? slice(neu, j, j + n) : [{ type: 'diffIns', children: slice(neu, j, j + n) } as PhrasingContent]));
      j += n;
    } else {
      out.push(...slice(neu, j, j + n));
      i += n;
      j += n;
    }
  }
  return out;
}

/** A code line longer than this gets no word marks: its whole-line mark says enough. */
const CODE_WORDS_MAX_CHARS = 1_000;

/** The pairs of a removed run's lines with the added run's after it (Monaco's inline diff): line
 * by line when the runs are the same length, else each removed line with the next added one
 * similar enough (PAIR_SIMILARITY), in order. Indices into the runs. */
function pairLines(old: readonly string[], neu: readonly string[], deadline: number): [number, number][] {
  if (old.length === neu.length) return old.map((_, i) => [i, i]);
  const pairs: [number, number][] = [];
  let next = 0;
  for (let i = 0; i < old.length && next < neu.length; i++) {
    for (let j = next; j < neu.length; j++) {
      if (similarity(old[i]!, neu[j]!, deadline) >= PAIR_SIMILARITY) { pairs.push([i, j]); next = j + 1; break; }
    }
  }
  return pairs;
}

/** The changed words of a paired removed line `a` and added line `b`, as `start-end` character
 * ranges on each (`,` between them); `null` when they share nothing but whitespace (the line
 * changed whole) or one is over CODE_WORDS_MAX_CHARS. */
function lineWords(a: string, b: string, deadline: number): { old: string; neu: string } | null {
  if (Math.max(a.length, b.length) > CODE_WORDS_MAX_CHARS) return null;
  const old: string[] = [];
  const neu: string[] = [];
  let i = 0;
  let j = 0;
  let common = false;
  for (const c of inTime(diffWordsWithSpace(a, b, { timeout: left(deadline) }))) {
    const n = c.value.length;
    const blank = /^\s*$/.test(c.value);
    if (c.removed) {
      if (!blank) old.push(`${i}-${i + n}`);
      i += n;
    } else if (c.added) {
      if (!blank) neu.push(`${j}-${j + n}`);
      j += n;
    } else {
      if (!blank) common = true;
      i += n;
      j += n;
    }
  }
  return common ? { old: old.join(','), neu: neu.join(',') } : null;
}

/** A changed code block's lines, old and new merged in order (`diffLines`), with one mark per
 * line: ' ' kept, '-' removed, '+' added (R10). Line endings are LF first: CRLF never shows as a
 * change, nor reaches the rendered code. `words`: within each removed run and the added run right
 * after it, a paired line's changed words (`pairLines`, `lineWords`); one `;`-separated entry per
 * merged line, empty for a line without any; absent when no line has any. Throws `GaveUp` past
 * `deadline` (the whole diff's). */
export function codeLines(old: string, neu: string, deadline = Infinity): { value: string; marks: string; words?: string } {
  const lines: string[] = [];
  let marks = '';
  // Each side's last line ends like the others: a line added after it keeps it in common.
  const ended = (s: string) => (s === '' ? s : `${lf(s)}\n`);
  for (const c of inTime(diffLines(ended(old), ended(neu), { timeout: left(deadline) }))) {
    if (c.value === '') continue;
    const part = c.value.replace(/\n$/, '').split('\n');
    lines.push(...part);
    marks += (c.added ? '+' : c.removed ? '-' : ' ').repeat(part.length);
  }
  const words = lines.map(() => '');
  let any = false;
  for (const run of marks.matchAll(/(-+)(\++)/g)) {
    const r0 = run.index;
    const a0 = r0 + run[1]!.length;
    const a1 = a0 + run[2]!.length;
    for (const [i, j] of pairLines(lines.slice(r0, a0), lines.slice(a0, a1), deadline)) {
      const w = lineWords(lines[r0 + i]!, lines[a0 + j]!, deadline);
      if (!w) continue;
      words[r0 + i] = w.old;
      words[a0 + j] = w.neu;
      any ||= w.old !== '' || w.neu !== '';
    }
  }
  return { value: lines.join('\n'), marks, ...(any ? { words: words.join(';') } : {}) };
}
