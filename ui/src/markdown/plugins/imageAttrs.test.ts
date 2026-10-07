import type { Image, Nodes, Paragraph } from 'mdast';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearParseCache, parseMarkdown } from '../parse';
import { toString } from './testText';

beforeEach(() => clearParseCache());

const images = (n: Nodes): Image[] => (n.type === 'image' ? [n] : 'children' in n ? (n.children as Nodes[]).flatMap(images) : []);
const sizeOf = (img: Image) => img.data?.hProperties ?? null;

describe('GitLab image attributes (`![a](b){width=… height=…}`)', () => {
  it('size the image right before them, and never show as text', () => {
    const tree = parseMarkdown('![image](/uploads/0123abcd0123abcd/image.png){width=900 height=575} after', 'gitlab');
    expect(images(tree).map(sizeOf)).toEqual([{ width: 900, height: 575 }]);
    expect(toString(tree)).toBe(' after');
  });

  it('take px, quotes, one dimension, a linked image and a reference image', () => {
    const tree = parseMarkdown('[![a](a.png){width=100px}](https://gitlab.example.com) ![b](b.png){height="40"} ![c][c]{ width=12 }\n\n[c]: c.png', 'gitlab');
    expect(toString(tree)).toBe('  \n'); // the paragraph, then the definition
    const p = tree.children[0] as Paragraph;
    const link = p.children[0]!;
    expect(link.type).toBe('link');
    expect(images(tree).map(sizeOf)).toEqual([{ width: 100 }, { height: 40 }]);
    const ref = p.children.find((c) => c.type === 'imageReference')!;
    expect(ref.data?.hProperties).toEqual({ width: 12 });
  });

  it('a percentage is dropped (no size), but the list still goes', () => {
    const tree = parseMarkdown('![a](a.png){width=75%}', 'gitlab');
    expect(toString(tree)).toBe('');
    expect(images(tree).map(sizeOf)).toEqual([null]);
  });

  it('stay text anywhere but right after an image: after a space, in code, or not an attribute list', () => {
    const text = '![a](a.png) {width=9}\n\n`![a](a.png){width=9}`\n\n```\n![a](a.png){width=9}\n```\n\n![a](a.png){see below}\n\n{width=9}';
    const tree = parseMarkdown(text, 'gitlab');
    expect(images(tree).map(sizeOf)).toEqual([null, null]);
    expect(toString(tree)).toBe(' {width=9}\n![a](a.png){width=9}\n![a](a.png){width=9}\n{see below}\n{width=9}');
  });

  it('are GitLab’s only: GitHub shows them as text', () => {
    const tree = parseMarkdown('![a](a.png){width=9}', 'github');
    expect(images(tree).map(sizeOf)).toEqual([null]);
    expect(toString(tree)).toBe('{width=9}');
  });
});
