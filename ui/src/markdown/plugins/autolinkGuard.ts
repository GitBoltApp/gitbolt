import type { Root, Text } from 'mdast';
import type { Extension, Transform } from 'mdast-util-from-markdown';
import type { Processor } from 'unified';
import { visit } from 'unist-util-visit';

/** Tokens (runs without ASCII whitespace) longer than this aren't autolinked. */
export const MAX_AUTOLINK_TOKEN = 1024;

const hasLongToken = (s: string): boolean => {
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) run = 0;
    else if (++run > MAX_AUTOLINK_TOKEN) return true;
  }
  return false;
};

/** The transform with every text node holding an over-long token hidden from it. */
const guard = (inner: Transform): Transform => (tree) => {
  const hidden: Text[] = [];
  visit(tree as Root, 'text', (n: Text) => {
    if (hasLongToken(n.value)) { hidden.push(n); (n as { type: string }).type = 'gbLongText'; }
  });
  try { return inner(tree); } finally { for (const n of hidden) n.type = 'text'; }
};

type Ext = Extension | Ext[];
const swap = (list: Ext[]): Ext[] => list.map((e) => (Array.isArray(e) ? swap(e) : e.enter && 'literalAutolink' in e.enter && e.transforms ? { ...e, transforms: e.transforms.map(guard) } : e));

/** Use right after remark-gfm. GFM's autolink-literal transform (mdast-util-gfm-autolink-literal
 * 2.0.1) is quadratic in a token's length: its email regex restarts after every `.` or `-` of a
 * run and scans to the run's end (40 000 dots: about 14 s). This keeps it off text nodes with a
 * token over `MAX_AUTOLINK_TOKEN` characters, so its cost stays under (text length × that bound);
 * such a node's URLs stay text. The micromark-level autolinks are untouched. */
export function remarkAutolinkGuard(this: Processor) {
  const data = this.data() as { fromMarkdownExtensions?: Ext[] };
  if (data.fromMarkdownExtensions) data.fromMarkdownExtensions = swap(data.fromMarkdownExtensions);
}
