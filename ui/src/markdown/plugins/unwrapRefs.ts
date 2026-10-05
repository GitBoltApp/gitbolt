import type { Element, Root as HastRoot, RootContent } from 'hast';

const NO_REFS = new Set(['a', 'code', 'pre']);
type Parent = HastRoot | Element;

/** After rehype-raw: a reference span (`data-gb-ref`) inside a raw-HTML `a`, `code` or `pre`
 * goes back to its text, as GitHub leaves it (remark only skips Markdown links and code; the
 * raw tags' contents were plain text to it). */
export function rehypeUnwrapNestedRefs() {
  const walk = (node: Parent, inside: boolean) => {
    node.children = node.children.flatMap((c): RootContent[] => {
      if (c.type !== 'element') return [c];
      if (inside && c.tagName === 'span' && c.properties.dataGbRef !== undefined) return c.children;
      walk(c, inside || NO_REFS.has(c.tagName));
      return [c];
    }) as typeof node.children;
  };
  return (tree: HastRoot) => walk(tree, false);
}
