import { useMemo } from 'react';
import { create } from 'zustand';

/** Spec #5 §3.3: the extensions File View can show rendered. */
export const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdx'] as const;

/** Whether File View offers `Source | Rendered` for `path` (its file name has a Markdown extension). */
export function isMarkdownPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && (MARKDOWN_EXTENSIONS as readonly string[]).includes(name.slice(dot + 1).toLowerCase());
}

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
