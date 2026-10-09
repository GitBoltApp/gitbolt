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
      case 'html': return n.value;
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

  it('word-diffs the text around inline HTML; an element (open tag to close tag) is one token (R13)', () => {
    expect(wd('Press <kbd>Ctrl</kbd> to open the old menu.', 'Press <kbd>Ctrl</kbd> to open the new menu.')).toBe('Press <kbd>Ctrl</kbd> to open the [-old-]{+new+} menu.');
    expect(wd('a <kbd>b</kbd> c', 'a <kbd>x</kbd> c')).toBe('a [-<kbd>b</kbd>-]{+<kbd>x</kbd>+} c');
    expect(wd('Line one<br>then two.', 'Line one<br>then three.')).toBe('Line one<br>then [-two-]{+three+}.');
  });

  it('a tag with no closing tag (`<name>` written as a placeholder) is a token of its own', () => {
    expect(wd('Shows "Fetching <repo>… N%" with Cancel in the bar.', 'Shows "Fetching <repo>… N%" with Cancel in the status bar.'))
      .toBe('Shows "Fetching <repo>… N%" with Cancel in the {+status +}bar.');
  });

  it('refuses private-use text and blocks over the cap', () => {
    expect(wd('a \uE000', 'b')).toBeNull();
    expect(wd('x '.repeat(6_000), 'y '.repeat(6_000))).toBeNull();
  });
});

describe('codeLines (R10)', () => {
  it("marks the changed words of each paired removed/added line (Monaco's inline diff): ranges per line", () => {
    const r = codeLines('const port = 8080;\nlisten(port);', 'const port = 9090;\nlisten(port);');
    expect(r.marks).toBe('-+ ');
    // One entry per merged line: `start-end` character ranges, `;` between lines.
    expect(r.words).toBe('13-17;13-17;');
  });

  it('pairs runs of equal length line by line; unequal runs by similarity; an unpaired line has no word marks', () => {
    expect(codeLines('a = 1\nb = 2', 'a = 3\nb = 4')).toEqual({ value: 'a = 1\nb = 2\na = 3\nb = 4', marks: '--++', words: '4-5;4-5;4-5;4-5' });
    // One removed line, two added: the similar one pairs, the new one stays a whole-line add.
    const r = codeLines('port = 8080', 'port = 9090\nhost = "example.test"');
    expect(r.marks).toBe('-++');
    expect(r.words).toBe('7-11;7-11;');
  });

  it('marks no words when a line changed whole, or nothing pairs', () => {
    expect(codeLines('alpha', 'omega').words).toBeUndefined();
    expect(codeLines('a', 'a\nb').words).toBeUndefined();
  });

  it('merges a changed code block line by line, removed before added', () => {
    expect(codeLines('const port = 8080;\nlisten(port);', 'const port = 9090;\nlisten(port);')).toMatchObject({ value: 'const port = 8080;\nconst port = 9090;\nlisten(port);', marks: '-+ ' });
    expect(codeLines('', 'a\nb')).toEqual({ value: 'a\nb', marks: '++' });
    expect(codeLines('a', 'a')).toEqual({ value: 'a', marks: ' ' });
  });

  it('keeps the last line in common when a line is added after it', () => {
    expect(codeLines('a\nb', 'a\nb\nc')).toEqual({ value: 'a\nb\nc', marks: '  +' });
    expect(codeLines('a\nb\nc', 'a\nb')).toEqual({ value: 'a\nb\nc', marks: '  -' });
    expect(codeLines('a', '')).toEqual({ value: 'a', marks: '-' });
  });
});
