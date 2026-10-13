import { useMemo } from 'react';
import { create } from 'zustand';
import { textKey } from '../util/textHash';
import type { ViewPref } from './diffPrefs';

/** Spec #5 §3.3: the extensions File View can show rendered. */
export const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdx'] as const;

/** Whether `path`'s file name ends in one of `list`'s extensions (any case). */
const extensionIn = (path: string, list: readonly string[]) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && list.includes(name.slice(dot + 1).toLowerCase());
};

/** Whether File View offers `Source | Rendered` for `path` (its file name has a Markdown extension). */
export function isMarkdownPath(path: string): boolean {
  return extensionIn(path, MARKDOWN_EXTENSIONS);
}

/** Whether a diff of `t` is a Markdown diff: either side's path is Markdown, so a rename to or
 * from a Markdown name (e.g. `Bug_Template.md` → `Bug_Template`) still renders. */
export function isMarkdownTarget(t: { path: string; oldPath: string | null }): boolean {
  return isMarkdownPath(t.path) || (t.oldPath !== null && isMarkdownPath(t.oldPath));
}

/** The extensions shown as a page (`HtmlPage.tsx`), with the same `Source | Rendered` toggle. */
export const HTML_EXTENSIONS = ['html', 'htm', 'xhtml'] as const;

/** Whether `path` is an HTML file, shown rendered as a static page. */
export const isHtmlPath = (path: string): boolean => extensionIn(path, HTML_EXTENSIONS);

/** Whether a diff of `t` is an HTML diff (either side's path, as `isMarkdownTarget`). */
export const isHtmlTarget = (t: { path: string; oldPath: string | null }): boolean => isHtmlPath(t.path) || (t.oldPath !== null && isHtmlPath(t.oldPath));

/** Whether `path` has a rendered view (Markdown or HTML): the `Source | Rendered` toggle, its
 * app-wide pick (`markdownView`, or HTML's own `htmlView`) and a just-created file's Source apply to both. */
export const isRenderedPath = (path: string): boolean => isMarkdownPath(path) || isHtmlPath(path);

/** Whether a diff of `t` has a rendered view. */
export const isRenderedTarget = (t: { path: string; oldPath: string | null }): boolean => isMarkdownTarget(t) || isHtmlTarget(t);

/** Which rendered view a file (or a diff of it) has: its new path's, else its old path's. */
export function renderedKindOf(t: { path: string; oldPath: string | null }): 'markdown' | 'html' | null {
  for (const p of [t.path, t.oldPath]) {
    if (p !== null && isMarkdownPath(p)) return 'markdown';
    if (p !== null && isHtmlPath(p)) return 'html';
  }
  return null;
}

/** The extensions shown as a table (`ui/src/table/`), with `Source | Table`. */
export const TABLE_EXTENSIONS = ['csv', 'tsv'] as const;

/** The kinds of file with a view beside their source, each with its own app-wide pick: Markdown
 * and HTML rendered, CSV and TSV as a table. */
export type ViewKind = 'markdown' | 'html' | 'table';
export const VIEW_PREFS: Record<ViewKind, ViewPref> = { markdown: 'markdownView', html: 'htmlView', table: 'tableView' };

/** Which view `path` has beside its source, by its extension; null for none. */
export function viewKindOf(path: string): ViewKind | null {
  if (isMarkdownPath(path)) return 'markdown';
  if (isHtmlPath(path)) return 'html';
  return extensionIn(path, TABLE_EXTENSIONS) ? 'table' : null;
}

/** Which view a diff of `t` has: its new path's, else its old path's (a rename to or from one). */
export const viewKindOfTarget = (t: { path: string; oldPath: string | null }): ViewKind | null =>
  viewKindOf(t.path) ?? (t.oldPath !== null ? viewKindOf(t.oldPath) : null);

/** Spec #5 §3.1: File View renders Markdown up to this many UTF-8 bytes; above, Source. */
export const RENDER_MAX_BYTES = 5 * 1024 * 1024;
/** A parse taking longer than this falls back to Source. */
export const PARSE_BUDGET_MS = 2000;
/** Files above this many characters are parsed once, timed, before they render. */
export const PRECHECK_BYTES = 500 * 1024;
export const TOO_LARGE_TO_RENDER = 'Too large to render';

/** Over RENDER_MAX_BYTES in UTF-8 (counted only when the length leaves it in doubt). */
export function overRenderLimit(text: string): boolean {
  if (text.length > RENDER_MAX_BYTES) return true;
  if (text.length * 3 <= RENDER_MAX_BYTES) return false;
  return new TextEncoder().encode(text).length > RENDER_MAX_BYTES;
}

/** A file's identity for the slow list: its place and length. */
export const renderKey = (navKey: string | null, text: string) => `${navKey ?? ''}|${text.length}`;
/** Files whose parse took over PARSE_BUDGET_MS this session: they open in Source. */
export const useSlowMarkdown = create<{ slow: Record<string, true> }>(() => ({ slow: {} }));
export const markSlow = (key: string) => useSlowMarkdown.setState((s) => ({ slow: { ...s.slow, [key]: true } }));

/** Whether File View shows this Markdown text as Source with "Too large to render". */
export function useTooLargeToRender(navKey: string | null, text: string): boolean {
  const big = useMemo(() => overRenderLimit(text), [text]);
  const slow = useSlowMarkdown((s) => !!s.slow[renderKey(navKey, text)]);
  return big || slow;
}

/** 5C: a rendered diff's identity for the slow list: its file, and both sides' contents (a
 * hash, `textKey`: an edit that keeps the length is checked again). */
export const diffRenderKey = (targetKey: string, old: string, neu: string) => `diff:${targetKey}|${textKey(old)}|${textKey(neu)}`;

/** 5C (R14): whether Diff View shows this Markdown diff as Source with "Too large to render": a
 * side over RENDER_MAX_BYTES, or a diff that took over PARSE_BUDGET_MS (or gave up) this session.
 * `key`: its `diffRenderKey`, worked out once per text. */
export function useDiffTooLarge(targetKey: string, old: string, neu: string): { tooLarge: boolean; key: string } {
  const big = useMemo(() => overRenderLimit(old) || overRenderLimit(neu), [old, neu]);
  const key = useMemo(() => diffRenderKey(targetKey, old, neu), [targetKey, old, neu]);
  const slow = useSlowMarkdown((s) => !!s.slow[key]);
  return { tooLarge: big || slow, key };
}
