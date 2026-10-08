import type { Root } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified, type Processor } from 'unified';
import { emojiReady } from '../forge/emoji';
import { remarkAutolinkGuard } from './plugins/autolinkGuard';
import { remarkEmoji } from './plugins/emoji';
import { remarkFrontmatterTable } from './plugins/frontmatter';
import { remarkHeadingIds } from './plugins/headingIds';
import { remarkImageAttrs } from './plugins/imageAttrs';
import { remarkReferences } from './plugins/references';
import type { MdFlavor } from './types';

const LRU_SIZE = 64;
const cache = new Map<string, Root>();
const processors: Partial<Record<string, Processor<Root, Root, Root>>> = {};

const keyOf = (text: string, flavor: MdFlavor, frontmatter: boolean) => `${flavor}\0${frontmatter ? 1 : 0}\0${emojiReady() ? 1 : 0}\0${text}`;

function processorFor(flavor: MdFlavor, frontmatter: boolean): Processor<Root, Root, Root> {
  return (processors[`${flavor}${frontmatter ? '+fm' : ''}`] ??= unified().use(remarkParse).use(frontmatter ? [[remarkFrontmatter, ['yaml', 'toml']]] : []).use(remarkGfm).use(remarkAutolinkGuard).use(flavor === 'gitlab' ? [remarkImageAttrs] : []).use(remarkEmoji).use(remarkReferences, { flavor }).use(remarkHeadingIds)
    // Last: the plugins above never see its values (no emoji, references or links in them).
    .use(frontmatter ? [remarkFrontmatterTable] : []).freeze() as unknown as Processor<Root, Root, Root>);
}

/** The mdast tree (GFM: tables, task lists, strikethrough, autolink literals, footnotes; our
 * emoji, references and heading-id plugins), cached by flavor, emoji state and text in a 64-entry
 * LRU. `frontmatter`: a file's leading YAML or TOML block is a table (`remarkFrontmatterTable`);
 * only files have one (GitHub and GitLab render it in neither descriptions nor comments). The
 * returned tree is shared: never mutate it. */
export function parseMarkdown(text: string, flavor: MdFlavor, frontmatter = false): Root {
  const key = keyOf(text, flavor, frontmatter);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const p = processorFor(flavor, frontmatter);
  const tree = p.runSync(p.parse(text)) as Root;
  cache.set(key, tree);
  if (cache.size > LRU_SIZE) cache.delete(cache.keys().next().value!);
  return tree;
}

/** The cached tree, without parsing (and without touching the LRU order). */
export const peekParsed = (text: string, flavor: MdFlavor, frontmatter = false): Root | null => cache.get(keyOf(text, flavor, frontmatter)) ?? null;

/** Tests. */
export function clearParseCache(): void {
  cache.clear();
}
