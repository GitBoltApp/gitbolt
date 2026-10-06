import type { Definition, Heading, List, Nodes, Root, Table } from 'mdast';
import { visit } from 'unist-util-visit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { splitChunks } from '../chunks';
import { clearParseCache, parseMarkdown } from '../parse';
import { plainText } from './blocks';
import { diffMarkdown, diffTrees } from './diffTree';
import type { DiffBlockNode } from './nodes';

const d = (a: string, b: string) => { clearParseCache(); return diffMarkdown(a, b, 'github'); };
/** Every mark in document order: blocks by kind, words by text, items and rows, code line marks. */
function summary(root: Root): string[] {
  const out: string[] = [];
  visit(root, (n: Nodes) => {
    if (n.type === 'diffBlock') out.push(`${n.mark}:${n.children.map((c) => c.type).join(',')}`);
    else if (n.type === 'diffPair') out.push('pair');
    else if (n.type === 'diffIns') out.push(`ins:${plainText(n)}`);
    else if (n.type === 'diffDel') out.push(`del:${plainText(n)}`);
    else if (n.type === 'listItem' && n.data?.gbDiff) out.push(`item:${n.data.gbDiff}:${plainText(n)}`);
    else if (n.type === 'tableRow' && n.data?.gbDiff) out.push(`row:${n.data.gbDiff}`);
    else if (n.type === 'code' && n.data?.gbLines) out.push(`lines:${n.data.gbLines}`);
  });
  return out;
}

describe('diffMarkdown (5C)', () => {
  it('a changed heading and paragraph show their word changes in changed blocks', () => {
    const r = d('# Setup guide\n\nRun the tool once.\n', '# Install guide\n\nRun the tool twice.\n');
    expect(summary(r.root)).toEqual(['changed:heading', 'del:Setup', 'ins:Install', 'changed:paragraph', 'del:once', 'ins:twice']);
    expect(r.changes).toBe(2);
    expect(r.root.data?.gbChanges).toBe(2);
  });

  it('an added list item is marked in place, inside the one list', () => {
    const r = d('- install\n- configure\n', '- install\n- configure\n- verify\n');
    expect(summary(r.root)).toEqual(['item:added:verify']);
    expect(r.root.children[0]!.type).toBe('list');
  });

  it('an ordered list keeps its numbers: a removed item keeps its old one (R12)', () => {
    const list = d('1. alpha\n2. beta\n3. gamma\n', '1. alpha\n2. gamma\n').root.children[0] as List;
    expect(list.children.map((i) => [plainText(i), i.data?.gbDiff ?? null, i.data?.gbValue])).toEqual([['alpha', null, 1], ['beta', 'removed', 2], ['gamma', null, 2]]);
  });

  it('a ticked task counts as a changed item', () => {
    expect(summary(d('- [ ] run the tests\n', '- [x] run the tests\n').root)).toEqual(['item:changed:run the tests']);
  });

  it('a changed code block merges its lines (R10)', () => {
    expect(summary(d('```ts\nconst port = 8080;\n```\n', '```ts\nconst port = 9090;\n```\n').root)).toEqual(['changed:code', 'lines:-+']);
  });

  it('a changed diagram shows old and new side by side (R11)', () => {
    expect(summary(d('```mermaid\ngraph TD\n  A-->B\n```\n', '```mermaid\ngraph TD\n  A-->C\n```\n').root)).toEqual(['pair', 'removed:code', 'added:code']);
  });

  it('a changed table row diffs its cells; the header stays first (R12)', () => {
    const r = d('| Step | Time |\n|---|---|\n| build | 3 ms |\n', '| Step | Time |\n|---|---|\n| build | 5 ms |\n| test | 1 ms |\n');
    expect(summary(r.root)).toEqual(['row:changed', 'del:3', 'ins:5', 'row:added']);
    expect(plainText((r.root.children[0] as Table).children[0]!)).toBe('Step\nTime');
  });

  it('diffs inside a blockquote', () => {
    expect(summary(d('> One.\n>\n> Two cats.\n', '> One.\n>\n> Two dogs.\n').root)).toEqual(['changed:paragraph', 'del:cats', 'ins:dogs']);
  });

  it('a whitespace-only change marks nothing (R5)', () => {
    const r = d('Some  text\nwrapped here.\n', 'Some text wrapped\nhere.\n');
    expect(summary(r.root)).toEqual([]);
    expect(r.changes).toBe(0);
  });

  it('an added file is all added; a deleted one all removed (R6)', () => {
    expect(summary(d('', '# A\n\nB.\n').root)).toEqual(['added:heading', 'added:paragraph']);
    expect(summary(d('# A\n\nB.\n', '').root)).toEqual(['removed:heading', 'removed:paragraph']);
  });

  it('keeps a <details> block whole: removed and added together (R13)', () => {
    const r = d('<details>\n<summary>More</summary>\n\nOld text.\n\n</details>\n', '<details>\n<summary>More</summary>\n\nNew text.\n\n</details>\n');
    expect(summary(r.root)).toEqual(['removed:html,paragraph,html', 'added:html,paragraph,html']);
  });

  it('a removed heading gives up its anchor to the new document', () => {
    const r = d('## Old part\n\nText.\n', 'Text.\n');
    const h = (r.root.children[0] as DiffBlockNode).children[0] as Heading;
    expect(h.type).toBe('heading');
    expect(h.data?.hProperties?.id).toBeUndefined();
  });

  it("keeps the old side's definitions a removed block refers to", () => {
    const r = d('See [the docs][d].\n\n[d]: https://docs.example/old\n', 'Nothing here.\n');
    expect(r.root.children.filter((n): n is Definition => n.type === 'definition').map((n) => n.url)).toEqual(['https://docs.example/old']);
  });

  it('gives every top-level node a position, so splitChunks sizes its chunks', () => {
    const big = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${'x'.repeat(500)}`).join('\n\n');
    const r = d(big, big.replace('Paragraph 7 ', 'Paragraph seven '));
    expect(r.root.children.every((n) => n.position?.end.offset !== undefined)).toBe(true);
    expect(splitChunks(r.root, 4_000).length).toBeGreaterThan(3);
  });

  it('never changes the parsed trees (they are shared through the parse cache)', () => {
    clearParseCache();
    const a = parseMarkdown('# T\n\n1. a\n2. b\n\n```ts\nx\n```\n\n## Gone\n', 'github');
    const b = parseMarkdown('# T2\n\n1. a\n2. c\n\n```ts\ny\n```\n', 'github');
    const before = JSON.stringify([a, b]);
    diffTrees(a, b);
    expect(JSON.stringify([a, b])).toBe(before);
  });

  describe('each change counts once, on its innermost marked node', () => {
    it('a word change in a one-paragraph list item marks the item, its paragraph inline', () => {
      const r = d('- install the tool\n- configure\n', '- install the app\n- configure\n');
      expect(summary(r.root)).toEqual(['item:changed:install the toolapp', 'del:tool', 'ins:app']);
      expect((r.root.children[0] as List).children[0]!.children.map((k) => k.type)).toEqual(['paragraph']);
      expect(r.root.data?.gbChanges).toBe(1);
    });

    it('a changed task item keeps its checkbox and counts once', () => {
      const r = d('- [ ] Write docs\n- [x] Ship\n', '- [ ] Write the docs\n- [x] Ship\n');
      expect(summary(r.root)).toEqual(['item:changed:Write the docs', 'ins:the ']);
      expect((r.root.children[0] as List).children[0]!.checked).toBe(false);
      expect(r.root.data?.gbChanges).toBe(1);
    });

    it('a word change inside a blockquote', () => {
      const r = d('> Two cats.\n', '> Two dogs.\n');
      expect(summary(r.root)).toEqual(['changed:paragraph', 'del:cats', 'ins:dogs']);
      expect(r.root.data?.gbChanges).toBe(1);
    });

    it('an added list item', () => {
      expect(d('- install\n- configure\n', '- install\n- configure\n- verify\n').root.data?.gbChanges).toBe(1);
    });

    it('a removed blockquote of two paragraphs is one change', () => {
      const r = d('Keep.\n\n> One.\n>\n> Two.\n', 'Keep.\n');
      expect(summary(r.root)).toEqual(['removed:blockquote']);
      expect(r.root.data?.gbChanges).toBe(1);
    });

    it('a word change in a nested list marks only the inner item', () => {
      const r = d('- outer\n  - inner old word\n', '- outer\n  - inner new word\n');
      expect(summary(r.root)).toEqual(['item:changed:inner oldnew word', 'del:old', 'ins:new']);
      expect(r.root.data?.gbChanges).toBe(1);
    });

    it('a ticked task is one change, on the item', () => {
      expect(d('- [ ] run the tests\n', '- [x] run the tests\n').root.data?.gbChanges).toBe(1);
    });
  });

  describe('definitions and changes nothing inside shows', () => {
    const notes = (r: ReturnType<typeof d>) => r.root.children.filter((n) => n.type === 'footnoteDefinition');
    const noteOf = (r: ReturnType<typeof d>) => (r.root.children.find((n) => n.type === 'diffBlock') as DiffBlockNode | undefined)?.note;

    it("a footnote's changed text is one change, word-diffed inside it", () => {
      const r = d('Text.[^1]\n\n[^1]: The old note.\n', 'Text.[^1]\n\n[^1]: The new note.\n');
      expect(summary(r.root)).toEqual(['changed:paragraph', 'del:old', 'ins:new']);
      expect(notes(r)).toHaveLength(1);
      expect(r.changes).toBe(1);
    });

    it('an added footnote is marked added; a removed one removed, with its reference', () => {
      const added = d('Text.\n', 'Text.[^n]\n\n[^n]: A note.\n');
      expect(summary(added.root)).toEqual(['changed:paragraph', 'ins:', 'added:paragraph']);
      expect(added.changes).toBe(2);
      const removed = d('Gone.[^n]\n\n[^n]: A note.\n', 'Other text.\n');
      expect(summary(removed.root)).toEqual(['removed:paragraph', 'added:paragraph', 'removed:paragraph']);
      expect(notes(removed)).toHaveLength(1);
    });

    it("a footnote nothing references isn't marked or counted (it doesn't render)", () => {
      const r = d('Text.\n\n[^n]: Old.\n', 'Text.\n\n[^n]: New.\n');
      expect(summary(r.root)).toEqual([]);
      expect(r.changes).toBe(0);
    });

    it("a link definition's changed URL marks its uses: the old link removed, the new one added", () => {
      const r = d('See [the docs][d] and [more][d].\n\n- [item][d]\n\n[d]: https://docs.example/old\n', 'See [the docs][d] and [more][d].\n\n- [item][d]\n\n[d]: https://docs.example/new\n');
      expect(summary(r.root)).toEqual(['changed:paragraph', 'del:the docs', 'ins:the docs', 'del:more', 'ins:more', 'item:changed:itemitem', 'del:item', 'ins:item']);
      expect(r.changes).toBe(2);
      const dels: string[] = [];
      visit(r.root, 'diffDel', (n) => { for (const k of n.children) if (k.type === 'link') dels.push(k.url); });
      expect(dels).toEqual(['https://docs.example/old', 'https://docs.example/old', 'https://docs.example/old']);
      expect(r.root.children.filter((n): n is Definition => n.type === 'definition').map((n) => n.url)).toEqual(['https://docs.example/new']);
    });

    it("an ordered list's start number: one change, marked with a note", () => {
      const r = d('3. alpha\n4. beta\n', '5. alpha\n6. beta\n');
      expect(summary(r.root)).toEqual(['changed:list']);
      expect(noteOf(r)).toBe('Start number changed');
      expect(r.changes).toBe(1);
    });

    it("a table's alignment: one change, marked with a note", () => {
      const r = d('| a | b |\n|---|---|\n| 1 | 2 |\n', '| a | b |\n|:--|--:|\n| 1 | 2 |\n');
      expect(summary(r.root)).toEqual(['changed:table']);
      expect(noteOf(r)).toBe('Alignment changed');
      expect(r.changes).toBe(1);
    });

    it("a code block's info string: one change, marked with a note", () => {
      const r = d('```ts title=a.ts\nx\n```\n', '```ts title=b.ts\nx\n```\n');
      expect(summary(r.root)).toEqual(['changed:code', 'lines: ']);
      expect(noteOf(r)).toBe('Code block info changed: title=a.ts → title=b.ts');
      expect(r.changes).toBe(1);
    });
  });

  describe('CRLF line endings', () => {
    const doc = '# Guide\n\nRun the tool once.\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\n<div>\n<p>Raw</p>\n</div>\n\n- one\n- two\n';
    const crlf = (s: string) => s.replace(/\n/g, '\r\n');

    it('an LF to CRLF change marks nothing', () => {
      const r = d(doc, crlf(doc));
      expect(summary(r.root)).toEqual([]);
      expect(r.changes).toBe(0);
    });

    it('a CRLF document with one word changed shows exactly that change', () => {
      const r = d(crlf(doc), crlf(doc.replace('once', 'twice')));
      expect(summary(r.root)).toEqual(['changed:paragraph', 'del:once', 'ins:twice']);
      expect(r.changes).toBe(1);
    });

    it('a CRLF code block with one line changed merges only that line', () => {
      const r = d(crlf(doc), crlf(doc.replace('const b = 2;', 'const b = 3;')));
      expect(summary(r.root)).toEqual(['changed:code', 'lines: -+']);
      const code = (r.root.children.find((n) => n.type === 'diffBlock') as DiffBlockNode).children[0] as { value: string };
      expect(code.value).not.toContain('\r');
    });
  });

  describe('one deadline for the whole diff (R14)', () => {
    afterEach(() => vi.restoreAllMocks());
    /** A clock that moves 1 ms on every read, so time spent is the number of reads. */
    const ticking = () => { let t = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => t++); };

    it('the budget is shared by every nested alignment, not restarted for each', () => {
      // 40 changed lists: each list's own alignment is quick, but together they read the clock far
      // more than 200 times.
      const doc = (w: string) => Array.from({ length: 40 }, (_, i) => `Para ${i}.\n\n- item ${w} ${i}\n- more ${i}\n- last ${i}`).join('\n\n');
      clearParseCache();
      const a = parseMarkdown(doc('one'), 'github');
      const b = parseMarkdown(doc('two'), 'github');
      ticking();
      expect(diffTrees(a, b, { timeout: 200 }).gaveUp).toBe(true);
      vi.restoreAllMocks();
      expect(diffTrees(a, b, { timeout: 200 }).gaveUp).toBe(false);
    });

    it('a pathological gap (many similar paragraphs reordered) gives up', () => {
      const paras = Array.from({ length: 300 }, (_, i) => `The service restarts the worker ${i} after the queue drains and the lease ends.`);
      clearParseCache();
      const a = parseMarkdown(paras.join('\n\n'), 'github');
      const b = parseMarkdown([...paras].reverse().join('\n\n'), 'github');
      ticking();
      expect(diffTrees(a, b, { timeout: 500 }).gaveUp).toBe(true);
    });

    it('a word diff past the deadline gives up', () => {
      clearParseCache();
      const a = parseMarkdown('Run the tool once.\n', 'github');
      const b = parseMarkdown('Run the tool twice.\n', 'github');
      ticking();
      expect(diffTrees(a, b, { timeout: 3 }).gaveUp).toBe(true);
    });

    it('a changed fence over WORD_DIFF_MAX_CHARS is removed and added, not line-diffed', () => {
      const body = Array.from({ length: 10_000 }, (_, i) => `line ${i} ${'x'.repeat(12)}`).join('\n');
      const fence = (b: string) => '```txt\n' + b + '\n```\n';
      clearParseCache();
      // A deadline no loaded machine reaches: the outcome is the size cap's, never the clock's
      // (a line diff would give one changed block with '-' and '+' lines).
      const r = diffTrees(parseMarkdown(fence(body), 'github'), parseMarkdown(fence(body.replace('line 5000 ', 'line five ')), 'github'), { timeout: 600_000 });
      expect(body.length).toBeGreaterThan(200_000);
      expect(r.gaveUp).toBe(false);
      expect(summary(r.root)).toEqual(['removed:code', 'added:code']);
      expect(r.changes).toBe(2);
    });
  });

  it('reports a gave-up alignment instead of a tree', () => {
    clearParseCache();
    expect(diffTrees(parseMarkdown('One.', 'github'), parseMarkdown('Two.', 'github'), { timeout: -1 }).gaveUp).toBe(true);
  });
});
