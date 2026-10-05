// The Markdown parse, off the main thread (ruling 21): micromark, GFM, our plugins and heading
// slugs, then the tree cut into chunks, each posted as its own message (each its own small task on
// the main thread). Vite bundles this file as a module worker.
import type { Root } from 'mdast';
import { HAS_SHORTCODE, loadEmoji } from '../forge/emoji';
import { splitChunks } from './chunks';
import { clearParseCache, parseMarkdown } from './parse';
import type { MdFlavor } from './types';

export interface ParseRequest { id: number; text: string; flavor: MdFlavor }
export type ParseReply = { id: number; index: number; chunk: Root; last: boolean } | { id: number; error: string };

const post = (m: ParseReply) => (globalThis as unknown as { postMessage(m: unknown): void }).postMessage(m);

(globalThis as unknown as { onmessage: (e: MessageEvent<ParseRequest>) => void }).onmessage = async (e) => {
  const { id, text, flavor } = e.data;
  try {
    if (HAS_SHORTCODE.test(text)) await loadEmoji().catch(() => {});
    const chunks = splitChunks(parseMarkdown(text, flavor));
    clearParseCache(); // the main thread keeps the chunks; the worker keeps nothing
    chunks.forEach((chunk, index) => post({ id, index, chunk, last: index === chunks.length - 1 }));
  } catch (err) {
    post({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
