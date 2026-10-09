import { createContext } from 'react';
import type { DiffPosition } from '../api/gen/DiffPosition';
import type { MdFlavor } from './types';

/**
 * A review comment's suggestion (spec 2026-10-08) shows as a diff of the lines it replaces, as the
 * forges show it. Those lines come from whoever renders the note (`MdSuggestionBase`): the diff's
 * text under a card or a comment box, the thread's snippet on the MR view's timeline.
 */

/** The new side's lines around the comment it renders in. */
export interface SuggestionBase {
  /** Whose fence rules apply to a suggestion without offsets. */
  flavor: MdFlavor;
  /** The commented file's path (its language highlights the diff); null: unknown. */
  path: string | null;
  /** How many lines the comment's range has above its last one (0: one line). */
  span: number;
  /** The lines from `above` lines above the comment's last line to `below` lines below it; null
   * when they aren't all known. */
  lines(offset: { above: number; below: number }): string[] | null;
}

/** The suggestion base for the Markdown inside; null (the default): unknown, a suggestion shows
 * only the lines it puts in. */
export const MdSuggestionBase = createContext<SuggestionBase | null>(null);

/** The lines a suggestion fence (`lang`) replaces, relative to the comment's last line: GitLab's
 * `suggestion:-N+M` from N above to M below; a plain `suggestion` on GitHub the commented lines,
 * on GitLab the last one alone (its offsets default to 0). */
export function suggestionOffset(lang: string, base: Pick<SuggestionBase, 'flavor' | 'span'>): { above: number; below: number } {
  const m = /^suggestion:-(\d+)\+(\d+)$/.exec(lang);
  if (m) return { above: Number(m[1]), below: Number(m[2]) };
  return { above: base.flavor === 'github' ? base.span : 0, below: 0 };
}

/** What a suggestion in fence `lang` replaces, as `base` knows it; null: unknown. */
export function replacedLines(lang: string, base: SuggestionBase | null): string[] | null {
  return base ? base.lines(suggestionOffset(lang, base)) : null;
}

/** A base over the new side's text of the file at `path`: `get(from, to)` gives its 1-based
 * lines `from`..`to` (fewer, or null, past either end); the comment covers `start`..`line`. */
export function linesBase(flavor: MdFlavor, path: string | null, start: number, line: number, get: (from: number, to: number) => readonly string[] | null): SuggestionBase {
  return {
    flavor,
    path,
    span: Math.max(0, line - start),
    lines: ({ above, below }) => {
      const [from, to] = [line - above, line + below];
      if (from < 1) return null;
      const got = get(from, to);
      return got && got.length === to - from + 1 ? [...got] : null;
    },
  };
}

/** A base over a diff note's position, from `get` (the new side's lines). A note on a removed
 * line (no new line) has nothing a suggestion replaces: null. */
export function positionBase(flavor: MdFlavor, pos: DiffPosition | null | undefined, get: (from: number, to: number) => readonly string[] | null): SuggestionBase | null {
  if (!pos || pos.line === null) return null;
  const start = pos.startLine !== null && pos.startLine < pos.line ? pos.startLine : pos.line;
  return linesBase(flavor, pos.path, start, pos.line, get);
}

/** A base over a diff note's snippet (the MR view's timeline): its new-side lines (context and
 * added ones, their prefix taken off), the last of them the note's line. Offsets reaching past
 * them, or a note on a removed line, give null. */
export function snippetBase(flavor: MdFlavor, pos: DiffPosition | null | undefined): SuggestionBase | null {
  const raw = pos?.snippet?.split('\n');
  if (!pos || !raw || pos.line === null || raw[raw.length - 1]?.startsWith('-')) return null;
  const neu = raw.filter((l) => !l.startsWith('-') && !l.startsWith('\\')).map((l) => l.slice(1));
  const line = pos.line;
  const first = line - neu.length + 1;
  return positionBase(flavor, pos, (from, to) => (from >= first && to <= line ? neu.slice(from - first, to - first + 1) : null));
}
