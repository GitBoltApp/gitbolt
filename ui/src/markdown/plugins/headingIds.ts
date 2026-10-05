import GithubSlugger from 'github-slugger';
import type { Nodes, Root } from 'mdast';
import { visit } from 'unist-util-visit';

const textOf = (n: Nodes): string => ('value' in n && typeof n.value === 'string' ? n.value : 'children' in n ? (n.children as Nodes[]).map(textOf).join('') : '');

/** Headings get GitHub's slugs, over the whole document at parse time, so a document rendered in
 * chunks (Task 12) keeps unique ids. The sanitizer prefixes them `user-content-`. */
export function remarkHeadingIds() {
  return (tree: Root) => {
    const slugger = new GithubSlugger();
    visit(tree, 'heading', (h) => {
      h.data = { ...h.data, hProperties: { ...(h.data?.hProperties ?? {}), id: slugger.slug(textOf(h)) } };
    });
  };
}
