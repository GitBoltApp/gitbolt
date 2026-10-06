// The Markdown parse, off the main thread (ruling 21): micromark, GFM, our plugins and heading
// slugs, then the tree cut into chunks, each posted as its own message (each its own small task on
// the main thread). Vite bundles this file as a module worker. 5C: a `diff` request diffs two
// texts the same way.
import type { Root } from 'mdast';
import { HAS_SHORTCODE, loadEmoji } from '../forge/emoji';
import { splitChunks } from './chunks';
import { diffChunks } from './diff/diffChunks';
import { clearParseCache, parseMarkdown } from './parse';
import type { MdFlavor } from './types';

export type ParseRequest =
  | { id: number; kind?: 'parse'; text: string; flavor: MdFlavor }
  /** 5C: the rendered diff of `old` → `text`. */
  | { id: number; kind: 'diff'; old: string; text: string; flavor: MdFlavor };
/** `tooLarge`: a diff whose alignment gave up (the view falls back to Source, R14). */
export type ParseReply = { id: number; index: number; chunk: Root; last: boolean } | { id: number; error: string; tooLarge?: true };

const post = (m: ParseReply) => (globalThis as unknown as { postMessage(m: unknown): void }).postMessage(m);

(globalThis as unknown as { onmessage: (e: MessageEvent<ParseRequest>) => void }).onmessage = async (e) => {
  const r = e.data;
  const { id } = r;
  try {
    if (HAS_SHORTCODE.test(r.text) || (r.kind === 'diff' && HAS_SHORTCODE.test(r.old))) await loadEmoji().catch(() => {});
    const chunks = r.kind === 'diff' ? diffChunks(r.old, r.text, r.flavor) : splitChunks(parseMarkdown(r.text, r.flavor));
    clearParseCache(); // the main thread keeps the chunks; the worker keeps nothing
    if (!chunks) { post({ id, error: 'too large', tooLarge: true }); return; }
    chunks.forEach((chunk, index) => post({ id, index, chunk, last: index === chunks.length - 1 }));
  } catch (err) {
    post({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
