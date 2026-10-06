import { diffLines, diffWordsWithSpace } from 'diff';
import type { PhrasingContent } from 'mdast';
import { inTime, left, lf, WORD_DIFF_MAX_CHARS } from './blocks';

const PUA_START = 0xe000;
const PUA_SIZE = 0x1900; // U+E000–U+F8FF
const PUA = /[\uE000-\uF8FF]/;
/** Inline nodes a word diff treats as one token each: they change whole or not at all. */
const ATOMS = new Set(['inlineCode', 'image', 'imageReference', 'break', 'footnoteReference', 'reference']);
type Atom = Exclude<PhrasingContent, { children: unknown }>;
const isAtom = (n: PhrasingContent): n is Atom => ATOMS.has(n.type) || !('children' in n);
const atomKey = (n: PhrasingContent) => JSON.stringify(n, (k, v) => (k === 'position' ? undefined : v));

/**
 * The inline content's text, each atom as one private-use character standing for its content (the
 * same atom on both sides is the same character, so it can be common). `null`: it can't be
 * word-diffed (R13: inline HTML, whose open and close tags must stay together; text that already
 * has private-use characters; more distinct atoms than the area holds).
 */
function flatten(nodes: readonly PhrasingContent[], atoms: Map<string, string>): string | null {
  let out = '';
  const walk = (list: readonly PhrasingContent[]): boolean => {
    for (const n of list) {
      if (n.type === 'html') return false;
      if (n.type === 'text') {
        if (PUA.test(n.value)) return false;
        out += n.value;
      } else if (isAtom(n)) {
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
    for (const n of list) {
      if (pos >= end) break;
      if (n.type === 'text') {
        const s = Math.max(start, pos);
        const e = Math.min(end, pos + n.value.length);
        if (e > s) into.push({ type: 'text', value: n.value.slice(s - pos, e - pos) });
        pos += n.value.length;
      } else if (isAtom(n)) {
        if (pos >= start) into.push(n);
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
 * `diffIns`, each keeping its formatting. A whitespace-only change marks nothing (R5). `null`:
 * the block can't be word-diffed (`flatten`), or a side is over WORD_DIFF_MAX_CHARS (R14). Throws
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

/** A changed code block's lines, old and new merged in order (`diffLines`), with one mark per
 * line: ' ' kept, '-' removed, '+' added (R10). Line endings are LF first: CRLF never shows as a
 * change, nor reaches the rendered code. Throws `GaveUp` past `deadline` (the whole diff's). */
export function codeLines(old: string, neu: string, deadline = Infinity): { value: string; marks: string } {
  const lines: string[] = [];
  let marks = '';
  for (const c of inTime(diffLines(lf(old), lf(neu), { timeout: left(deadline) }))) {
    if (c.value === '') continue;
    const part = c.value.replace(/\n$/, '').split('\n');
    lines.push(...part);
    marks += (c.added ? '+' : c.removed ? '-' : ' ').repeat(part.length);
  }
  return { value: lines.join('\n'), marks };
}
