import type { Root } from 'mdast';
import { findAndReplace } from 'mdast-util-find-and-replace';
import { emojify } from '../../forge/emoji';

/** `:shortcode:` → the emoji, through the gemoji map (forge/emoji.ts, with U+FE0F where needed).
 * Only text nodes are visited, so inline code and code blocks keep their shortcodes; an unknown
 * shortcode, or any before the map has loaded, stays as text. */
export function remarkEmoji() {
  return (tree: Root) => {
    findAndReplace(tree, [/:[a-z0-9_+-]+:/gi, (whole: string) => { const e = emojify(whole); return e === whole ? false : e; }]);
  };
}
