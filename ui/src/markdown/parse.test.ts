import { beforeEach, describe, expect, it } from 'vitest';
import { clearParseCache, parseMarkdown, peekParsed } from './parse';

beforeEach(() => clearParseCache());

describe('parseMarkdown (spec #5 §3.1)', () => {
  it('gives the GFM tree, cached by flavor and text', () => {
    const a = parseMarkdown('| a |\n|---|\n| 1 |\n\n- [x] done\n\n~~old~~', 'github');
    expect(a.children.map((n) => n.type)).toEqual(['table', 'list', 'paragraph']);
    expect(parseMarkdown('| a |\n|---|\n| 1 |\n\n- [x] done\n\n~~old~~', 'github')).toBe(a);
    expect(parseMarkdown('| a |\n|---|\n| 1 |\n\n- [x] done\n\n~~old~~', 'gitlab')).not.toBe(a);
    expect(peekParsed('never parsed', 'github')).toBeNull();
  });

  it('keeps 64 trees and drops the least recently used', () => {
    const first = parseMarkdown('doc 0', 'github');
    for (let i = 1; i < 64; i++) parseMarkdown(`doc ${i}`, 'github');
    expect(parseMarkdown('doc 0', 'github')).toBe(first); // touched: now the newest
    parseMarkdown('doc 64', 'github'); // evicts doc 1
    expect(peekParsed('doc 0', 'github')).toBe(first);
    expect(peekParsed('doc 1', 'github')).toBeNull();
  });
});
