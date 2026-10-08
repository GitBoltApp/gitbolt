import type { Code, RootContent, Table } from 'mdast';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearParseCache, parseMarkdown } from '../parse';
import { toString } from './testText';

const fm = (md: string) => parseMarkdown(md, 'github', true);
/** A front matter table's rows as `[key, value]`, each cell's text and its node types. */
const rows = (t: RootContent) => (t as Table).children.map((r) => r.children.map((c) => `${c.children.map((k) => k.type).join('+')}:${toString(c)}`));

beforeEach(() => clearParseCache());

describe('front matter (File View only)', () => {
  it('YAML at the start is a key/value table, one row per key, in order', () => {
    const [t, ...rest] = fm('---\nname: repo-tests\ndescription: Helps choose and run the tests.\n2: two\n1: one\n---\n\n# Title\n').children;
    expect(t!.type).toBe('table');
    expect((t as Table).data?.gbFrontmatter).toBe('yaml');
    expect(rows(t!)).toEqual([
      ['text:name', 'text:repo-tests'],
      ['text:description', 'text:Helps choose and run the tests.'],
      ['text:2', 'text:two'],
      ['text:1', 'text:one'],
    ]);
    expect(rest.map((n) => n.type)).toEqual(['heading']);
  });

  it('TOML (+++) is a table too', () => {
    const [t] = fm('+++\ntitle = "Release notes"\ndraft = false\nweight = 3\ndate = 2026-01-02\n+++\n\nBody.\n').children;
    expect((t as Table).data?.gbFrontmatter).toBe('toml');
    expect(rows(t!)).toEqual([['text:title', 'text:Release notes'], ['text:draft', 'text:false'], ['text:weight', 'text:3'], ['text:date', 'text:2026-01-02']]);
  });

  it('nested values show as inline code of their YAML, flow style; null is empty', () => {
    const [t] = fm('---\ntags:\n  - build\n  - test\nowner:\n  team: tools\n  size: 3\nempty:\n---\n').children;
    expect(rows(t!)).toEqual([['text:tags', 'inlineCode:[ build, test ]'], ['text:owner', 'inlineCode:{ team: tools, size: 3 }'], ['text:empty', ':']]);
  });

  it('malformed YAML, a list, or TOML that does not parse shows as a code block of its source', () => {
    for (const [md, lang, value] of [
      ['---\nname: [unclosed\n---\n', 'yaml', 'name: [unclosed'],
      ['---\n- one\n- two\n---\n', 'yaml', '- one\n- two'],
      ['---\na: 1\na: 2\n---\n', 'yaml', 'a: 1\na: 2'],
      ['+++\ntitle = \n+++\n', 'toml', 'title = '],
    ] as const) {
      const [c] = fm(md).children;
      expect(c!.type).toBe('code');
      expect([(c as Code).lang, (c as Code).value]).toEqual([lang, value]);
    }
  });

  it('runs nothing: an unknown tag is a string, and an alias bomb is a code block', () => {
    const [t] = fm('---\nrun: !!js/function "function () { return 1 }"\n---\n').children;
    expect(rows(t!)).toEqual([['text:run', 'text:function () { return 1 }']]);
    const bomb = ['a: &a [x, x, x, x, x, x, x, x, x]', ...'bcdefgh'.split('').map((k, i) => `${k}: &${k} [${Array(9).fill(`*${'abcdefg'[i]}`).join(', ')}]`)].join('\n');
    expect(fm(`---\n${bomb}\n---\n`).children[0]!.type).toBe('code');
  });

  it('values are text: no emoji, references, links or Markdown in them', () => {
    const [t] = parseMarkdown('---\nnote: "See #5, @sam and :+1: at https://example.test/x **now**"\n---\n', 'gitlab', true).children;
    expect(rows(t!)).toEqual([['text:note', 'text:See #5, @sam and :+1: at https://example.test/x **now**']]);
  });

  it('empty front matter renders nothing', () => {
    expect(fm('---\n---\n\nBody.\n').children.map((n) => n.type)).toEqual(['paragraph']);
  });

  it('a --- block later in the file, or with front matter off, parses as before', () => {
    const later = 'Intro.\n\n---\nname: x\n---\n';
    expect(fm(later)).toEqual(parseMarkdown(later, 'github'));
    expect(fm(later).children.map((n) => n.type)).toEqual(['paragraph', 'thematicBreak', 'heading']);
    expect(parseMarkdown('---\nname: x\n---\n', 'github').children.map((n) => n.type)).toEqual(['thematicBreak', 'heading']);
  });
});
