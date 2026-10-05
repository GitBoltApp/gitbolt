import type { Nodes } from 'mdast';

/** Tests only: a tree's text, blocks on their own lines. */
export function toString(node: Nodes): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if (!('children' in node)) return '';
  const sep = node.type === 'root' ? '\n' : '';
  return (node.children as Nodes[]).map(toString).join(sep);
}
