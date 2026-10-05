import type { Root } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified, type Processor } from 'unified';
import { emojiReady } from '../forge/emoji';
import { remarkAutolinkGuard } from './plugins/autolinkGuard';
import { remarkEmoji } from './plugins/emoji';
import { remarkHeadingIds } from './plugins/headingIds';
import { remarkReferences } from './plugins/references';
import type { MdFlavor } from './types';

const LRU_SIZE = 64;
const cache = new Map<string, Root>();
const processors: Partial<Record<MdFlavor, Processor<Root, Root, Root>>> = {};

const keyOf = (text: string, flavor: MdFlavor) => `${flavor}\0${emojiReady() ? 1 : 0}\0${text}`;

function processorFor(flavor: MdFlavor): Processor<Root, Root, Root> {
  return (processors[flavor] ??= unified().use(remarkParse).use(remarkGfm).use(remarkAutolinkGuard).use(remarkEmoji).use(remarkReferences, { flavor }).use(remarkHeadingIds).freeze() as unknown as Processor<Root, Root, Root>);
}

/** The mdast tree (GFM: tables, task lists, strikethrough, autolink literals, footnotes; our
 * emoji, references and heading-id plugins), cached by flavor, emoji state and text in a 64-entry
 * LRU. The returned tree is shared: never mutate it. */
export function parseMarkdown(text: string, flavor: MdFlavor): Root {
  const key = keyOf(text, flavor);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const p = processorFor(flavor);
  const tree = p.runSync(p.parse(text)) as Root;
  cache.set(key, tree);
  if (cache.size > LRU_SIZE) cache.delete(cache.keys().next().value!);
  return tree;
}

/** The cached tree, without parsing (and without touching the LRU order). */
export const peekParsed = (text: string, flavor: MdFlavor): Root | null => cache.get(keyOf(text, flavor)) ?? null;

/** Tests. */
export function clearParseCache(): void {
  cache.clear();
}
