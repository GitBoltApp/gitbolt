import type { Parent, Root, Text } from 'mdast';
import { visit } from 'unist-util-visit';

/** `{width=900 height=575}`: name=value pairs (a value bare or in double quotes), nothing else. */
const ATTRS = /^\{[ \t]*((?:[a-z]+=(?:"[^"\n]*"|[^\s"{}]+)[ \t]*)+)\}/i;
const PAIR = /([a-z]+)=(?:"([^"\n]*)"|([^\s"{}]+))/gi;
/** Pixels, as `<img width height>` takes them; a percentage (or anything else) gives no size. */
const PX = /^(\d{1,5})(?:px)?$/i;

/** GitLab's image attributes (GitLab Flavored Markdown): an attribute list written right after
 * an image, `![a](b.png){width=900 height=575}`, sizes it like `<img width height>` and isn't
 * shown. Only text right after an image counts: code is its own node type, so code never does. */
export function remarkImageAttrs() {
  return (tree: Root) => {
    visit(tree, (node) => {
      if (!('children' in node)) return;
      const kids = (node as Parent).children;
      for (let i = 0; i + 1 < kids.length; i++) {
        const img = kids[i]!;
        const next = kids[i + 1]!;
        if ((img.type !== 'image' && img.type !== 'imageReference') || next.type !== 'text') continue;
        const m = ATTRS.exec(next.value);
        if (!m) continue;
        const size: Record<string, number> = {};
        for (const [, name, quoted, bare] of m[1]!.matchAll(PAIR)) {
          const key = name!.toLowerCase();
          const px = PX.exec(quoted ?? bare ?? '');
          if ((key === 'width' || key === 'height') && px) size[key] = Number(px[1]);
        }
        if (Object.keys(size).length > 0) img.data = { ...img.data, hProperties: { ...img.data?.hProperties, ...size } };
        const rest = next.value.slice(m[0].length);
        if (rest) (next as Text).value = rest;
        else kids.splice(i + 1, 1);
      }
    });
  };
}
