import type { Element, Root as HastRoot } from 'hast';
import { visit } from 'unist-util-visit';
import { describe, expect, it } from 'vitest';
import { chunkHeightOf, splitChunks } from './chunks';
import { clearParseCache, parseMarkdown } from './parse';
import { toSafeHast } from './render';

const parse = (md: string) => { clearParseCache(); return parseMarkdown(md, 'github'); };
const links = (t: HastRoot) => { const out: unknown[] = []; visit(t, 'element', (e: Element) => { if (e.tagName === 'a') out.push(e.properties.href); }); return out; };

describe('splitChunks (ruling 21)', () => {
  it('cuts at top-level blocks of about the chunk size, keeping every block once, without positions', () => {
    const md = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${'x'.repeat(500)}`).join('\n\n');
    const chunks = splitChunks(parse(md), 4_000);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.flatMap((c) => c.children).filter((n) => n.type === 'paragraph')).toHaveLength(40);
    expect(JSON.stringify(chunks)).not.toContain('"position"');
  });

  it('gives each chunk its source length, and a placeholder height from it', () => {
    const md = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${'x'.repeat(500)}`).join('\n\n');
    const chunks = splitChunks(parse(md), 4_000);
    const lengths = chunks.map((c) => c.data?.gbChars ?? 0);
    expect(lengths.every((n) => n >= 500)).toBe(true);
    expect(lengths.reduce((a, b) => a + b, 0)).toBeGreaterThan(md.length - 2 * chunks.length);
    expect(chunkHeightOf(chunks[0]!)).toBe(Math.round(lengths[0]! * 0.18));
    expect(chunkHeightOf({ type: 'root', children: [], data: { gbChars: 10 } })).toBe(40);
  });

  it('never ends a chunk inside an open HTML block', () => {
    const md = `<details>\n<summary>More</summary>\n\n${'Inside. '.repeat(400)}\n\n${'Second. '.repeat(400)}\n\n</details>\n\nAfter.`;
    const chunks = splitChunks(parse(md), 1_000);
    const at = (needle: string) => chunks.findIndex((c) => c.children.some((n) => n.type === 'html' && n.value.includes(needle)));
    expect(at('</details>')).toBe(at('<details>'));
  });

  it('carries link definitions into every chunk, and a footnote with its first reference', () => {
    const md = `See [docs][d] and a note[^n].\n\n${'filler '.repeat(800)}\n\nAgain [docs][d].\n\n[d]: https://example.org/docs\n[^n]: The note.`;
    const chunks = splitChunks(parse(md), 1_000);
    expect(chunks.length).toBe(2);
    for (const c of chunks) expect(c.children.some((n) => n.type === 'definition')).toBe(true);
    expect(chunks[0]!.children.some((n) => n.type === 'footnoteDefinition')).toBe(true);
    expect(chunks[1]!.children.some((n) => n.type === 'footnoteDefinition')).toBe(false);
    expect(links(toSafeHast(chunks[1]!).hast)).toContain('https://example.org/docs');
  });

  it('gives a short document one chunk', () => {
    expect(splitChunks(parse('# One\n\nShort.'))).toHaveLength(1);
  });
});
