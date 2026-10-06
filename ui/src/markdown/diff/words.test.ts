import type { Paragraph, PhrasingContent } from 'mdast';
import { describe, expect, it } from 'vitest';
import { clearParseCache, parseMarkdown } from '../parse';
import { codeLines, inlineDiff } from './words';

const inline = (md: string) => { clearParseCache(); return (parseMarkdown(md, 'github').children[0] as Paragraph).children; };
/** Merged inline content as a compact string: [-removed-], {+added+}, *em*, **strong**, links, images, `code`. */
function show(nodes: readonly PhrasingContent[]): string {
  return nodes.map((n) => {
    switch (n.type) {
      case 'text': return n.value;
      case 'diffDel': return `[-${show(n.children)}-]`;
      case 'diffIns': return `{+${show(n.children)}+}`;
      case 'emphasis': return `*${show(n.children)}*`;
      case 'strong': return `**${show(n.children)}**`;
      case 'link': return `[${show(n.children)}](${n.url})`;
      case 'image': return `![${n.alt ?? ''}](${n.url})`;
      case 'inlineCode': return `\`${n.value}\``;
      default: return `<${n.type}>`;
    }
  }).join('');
}
const wd = (a: string, b: string) => { const r = inlineDiff(inline(a), inline(b)); return r && show(r); };

describe('inlineDiff (5C: diffWordsWithSpace)', () => {
  it('marks removed and added words; the common ones come from the new side', () => {
    expect(wd('Run the tool once to warm the cache.', 'Run the tool twice to warm the cache.')).toBe('Run the tool [-once-]{+twice+} to warm the cache.');
  });

  it('keeps the formatting of each part', () => {
    expect(wd('Use **fast** mode for *small* repos.', 'Use **safe** mode for *small* repos.')).toBe('Use [-**fast**-]{+**safe**+} mode for *small* repos.');
    expect(wd('See [the guide](a.md) now.', 'See [the new guide](a.md) now.')).toBe('See [the ](a.md){+[new ](a.md)+}[guide](a.md) now.');
  });

  it('treats inline code and images as whole tokens: a changed image shows old next to new (R7)', () => {
    expect(wd('See ![diagram](img/old.png) and `a()`.', 'See ![diagram](img/new.png) and `a()`.')).toBe('See [-![diagram](img/old.png)-]{+![diagram](img/new.png)+} and `a()`.');
  });

  it('marks no whitespace-only part', () => {
    expect(wd('one two', 'one  two')).toBe('one  two');
  });

  it('refuses inline HTML, private-use text, and blocks over the cap', () => {
    expect(wd('a <kbd>b</kbd>', 'a <kbd>c</kbd>')).toBeNull();
    expect(wd('a \uE000', 'b')).toBeNull();
    expect(wd('x '.repeat(6_000), 'y '.repeat(6_000))).toBeNull();
  });
});

describe('codeLines (R10)', () => {
  it('merges a changed code block line by line, removed before added', () => {
    expect(codeLines('const port = 8080;\nlisten(port);', 'const port = 9090;\nlisten(port);')).toEqual({ value: 'const port = 8080;\nconst port = 9090;\nlisten(port);', marks: '-+ ' });
    expect(codeLines('', 'a\nb')).toEqual({ value: 'a\nb', marks: '++' });
    expect(codeLines('a', 'a')).toEqual({ value: 'a', marks: ' ' });
  });
});
