import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewLine } from '../../api/gen/ReviewLine';
import { commentableIndex, type PlacedItem } from '../../forge/review/model';
import { assignItems, blockFor, blockTarget, blockTop, hoverBlock, keyboardTarget, scanBlocks, sourceLines, type SrcBlock } from './renderedBlocks';

const b = (id: number, neu: [number, number] | null, old: [number, number] | null, order = id): SrcBlock => ({ id, new: neu, old, order });

afterEach(() => { document.body.innerHTML = ''; });

describe('the rendered blocks (spec 2026-10-08 §3)', () => {
  it("reads the blocks and their lines in page order, leaving out what a review slot holds", () => {
    document.body.innerHTML = '<div id="p"><p data-src-id="1" data-src-new="1-2" data-src-old="1-1">a</p><div data-review-slot=""><p data-src-id="9" data-src-new="1-1">card</p></div><ul data-src-id="2" data-src-new="4-6"><li data-src-id="3" data-src-new="4-4">x</li></ul></div>';
    expect(scanBlocks(document.getElementById('p')!)).toEqual([b(1, [1, 2], [1, 1], 0), b(2, [4, 6], null, 1), b(3, [4, 4], null, 2)]);
  });

  it('a line sits under the innermost block holding it, on its side', () => {
    const blocks = [b(1, [1, 2], [1, 1], 0), b(2, [4, 6], [3, 5], 1), b(3, [5, 5], [4, 4], 2), b(4, null, [6, 8], 3)];
    expect(blockFor(blocks, 'new', 5)?.id).toBe(3);
    expect(blockFor(blocks, 'new', 4)?.id).toBe(2);
    expect(blockFor(blocks, 'old', 7)?.id).toBe(4);
  });

  it('of two blocks with the same lines (a list of one item), the inner one, which comes later', () => {
    expect(blockFor([b(1, [3, 3], null, 0), b(2, [3, 3], null, 1)], 'new', 3)?.id).toBe(2);
  });

  it('a line in no block (raw HTML, a definition, a blank line) sits under the last block before it; before the first, nowhere', () => {
    const blocks = [b(1, [3, 4], null, 0), b(2, [9, 9], null, 1)];
    expect(blockFor(blocks, 'new', 6)?.id).toBe(1);
    expect(blockFor(blocks, 'new', 1)).toBeNull();
    expect(blockFor(blocks, 'old', 3)).toBeNull();
  });

  it('places each thread and draft in its block, by side: a split view has the block once per column', () => {
    const at = (side: 'old' | 'new', line: number) => ({ path: 'a.md', side, line, startLine: null, outdated: false });
    const t = (id: string, side: 'old' | 'new', line: number): PlacedItem => ({ kind: 'thread', thread: { id, notes: [], resolvable: true, resolved: false }, at: at(side, line) });
    const out = assignItems([b(1, null, [1, 2], 0), b(1, [1, 3], null, 1)], [t('a', 'new', 2), t('b', 'old', 2), t('c', 'new', 3)]);
    expect([...out].map(([k, items]) => [k, items.map((i) => (i.kind === 'thread' ? i.thread.id : ''))])).toEqual([['1:new', ['a', 'c']], ['1:old', ['b']]]);
  });
});

describe('blockTop', () => {
  it("is where a note's line opens the rendered diff: its block, placed as the first change is", () => {
    const pane = document.createElement('div');
    pane.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    pane.innerHTML = '<p data-src-id="1" data-src-new="1-1"></p><p data-src-id="2" data-src-new="2-4"></p>';
    (pane.children[1] as HTMLElement).getBoundingClientRect = () => ({ top: 100 + 1500, bottom: 100 + 1540 }) as DOMRect;
    expect(blockTop(pane, { side: 'modified', line: 3 })).toBe(1500 + 20 - 300);
    expect(blockTop(pane, { side: 'original', line: 3 })).toBeNull();
  });

  it("never lands on a review slot's own block: a thread's Markdown has ids of its own", () => {
    const pane = document.createElement('div');
    pane.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    pane.innerHTML = '<p data-src-id="1" data-src-new="1-1"></p><div data-review-slot=""><p data-src-id="2" data-src-new="1-1"></p></div><p data-src-id="2" data-src-new="2-4"></p>';
    (pane.querySelector('[data-review-slot] p') as HTMLElement).getBoundingClientRect = () => ({ top: 100 + 40, bottom: 100 + 60 }) as DOMRect;
    (pane.children[2] as HTMLElement).getBoundingClientRect = () => ({ top: 100 + 1500, bottom: 100 + 1540 }) as DOMRect;
    expect(blockTop(pane, { side: 'modified', line: 3 })).toBe(1500 + 20 - 300);
  });
});

describe('a block\'s "+"', () => {
  const ctx = (o: number, n: number): ReviewLine => ({ kind: 'context', oldLine: o, newLine: n });
  const add = (o: number, n: number): ReviewLine => ({ kind: 'added', oldLine: o, newLine: n });
  const del = (o: number, n: number): ReviewLine => ({ kind: 'removed', oldLine: o, newLine: n });
  // README.md: Readme / +Second line, and further down a removed line.
  const FILE = commentableIndex({ path: 'README.md', oldPath: 'README.md', tooLarge: false, lines: [ctx(1, 1), add(2, 2), ctx(9, 10), del(10, 11)] });
  const el = (attrs: Record<string, string>) => { const e = document.createElement('p'); Object.assign(e.dataset, attrs); return e; };

  it("covers the block's new lines, clipped to the ones the forge takes", () => {
    expect(blockTarget(FILE, el({ srcId: '4', srcNew: '1-3', srcOld: '1-1' }))).toEqual({
      key: '4:new', side: 'new', anchor: { path: 'README.md', oldPath: 'README.md', start: ctx(1, 1), end: add(2, 2) }, from: 1, to: 2, label: 'Comment on lines 1–2',
    });
  });

  it("a removed block's covers its old lines", () => {
    expect(blockTarget(FILE, el({ srcId: '5', srcOld: '10-10' }))).toMatchObject({ key: '5:old', side: 'old', label: 'Comment on line 10' });
  });

  it("a split view's old column: a block ending on an unchanged line lands on the new side, in its numbers", () => {
    // Old line 9 is new line 10: the comment lands on new line 10 (its box under the new column).
    expect(blockTarget(FILE, el({ srcId: '7', srcOld: '9-9' }))).toMatchObject({ key: '7:old', side: 'new', from: 10, to: 10, label: 'Comment on line 10' });
    // Ending on the removed line: the old side, old numbers throughout.
    expect(blockTarget(FILE, el({ srcId: '8', srcOld: '9-10' }))).toMatchObject({ key: '8:old', side: 'old', from: 9, to: 10, label: 'Comment on lines 9–10' });
    // Starting on removed lines: the new side's numbers start at its first line there.
    const gone = commentableIndex({ path: 'README.md', oldPath: 'README.md', tooLarge: false, lines: [ctx(4, 1), del(5, 2), del(6, 2), ctx(7, 2)] });
    expect(blockTarget(gone, el({ srcId: '9', srcOld: '5-7' }))).toMatchObject({ side: 'new', from: 2, to: 2, label: 'Comment on line 2', anchor: { start: del(5, 2), end: ctx(7, 2) } });
  });

  it("a block that doesn't touch the MR's diff takes none", () => {
    expect(blockTarget(FILE, el({ srcId: '6', srcNew: '4-7' }))).toBeNull();
  });

  describe('hovered by the pointer', () => {
    /** `pane` with blocks at the given rects (left, top, right, bottom). */
    function placed(html: string, rects: Record<string, [number, number, number, number]>) {
      const pane = document.createElement('div');
      pane.innerHTML = html;
      document.body.append(pane);
      for (const [id, [left, top, right, bottom]] of Object.entries(rects)) {
        (pane.querySelector(`[data-src-id="${id}"]`) as HTMLElement).getBoundingClientRect = () => ({ left, top, right, bottom }) as DOMRect;
      }
      return pane;
    }
    const pick = (pane: HTMLElement, at: Element | null, x: number, y: number) => hoverBlock(FILE, pane, at, x, y)?.target.key ?? null;

    it("keeps a block's \"+\" while the pointer crosses the gutter to it, level with the block", () => {
      const pane = placed('<div class="md"><p data-src-id="1" data-src-new="1-2">a</p><p data-src-id="2" data-src-new="4-7">b</p></div>', { 1: [50, 10, 500, 30], 2: [50, 40, 500, 60] });
      const root = pane.firstElementChild!;
      expect(pick(pane, root.firstElementChild, 100, 20)).toBe('1:new');
      expect(pick(pane, root, 30, 20)).toBe('1:new');
      expect(pick(pane, pane, 5, 29)).toBe('1:new');
      // Between blocks, or level with one that takes no comment: none.
      expect(pick(pane, root, 30, 35)).toBeNull();
      expect(pick(pane, root, 30, 50)).toBeNull();
    });

    it("a list's padding beside an item is the item's, not the list's", () => {
      const pane = placed('<ul data-src-id="1" data-src-new="1-2"><li data-src-id="2" data-src-new="1-1">a</li><li data-src-id="3" data-src-new="2-2">b</li></ul>', { 1: [50, 10, 500, 50], 2: [80, 10, 500, 30], 3: [80, 30, 500, 50] });
      const ul = pane.firstElementChild!;
      expect(pick(pane, ul, 60, 40)).toBe('3:new');
      expect(pick(pane, pane, 20, 15)).toBe('2:new');
    });

    it('a card in a slot offers none', () => {
      const pane = placed('<p data-src-id="1" data-src-new="1-2">a</p><div data-review-slot=""><p id="c">card</p></div>', { 1: [50, 10, 500, 30] });
      expect(pick(pane, pane.querySelector('#c'), 100, 20)).toBeNull();
    });
  });

  describe('the comment key', () => {
    const pane = (html: string) => {
      const p = document.createElement('div');
      p.innerHTML = html;
      document.body.append(p);
      return p;
    };

    it('takes the innermost block in view that takes a comment, skipping those that take none', () => {
      const p = pane('<p data-src-id="9" data-src-new="4-7">far</p><ul data-src-id="1" data-src-new="1-2"><li data-src-id="2" data-src-new="1-1"><p data-src-id="3" data-src-new="5-5">x</p></li><li data-src-id="4" data-src-new="2-2">y</li></ul>');
      expect(keyboardTarget(FILE, p)?.key).toBe('2:new');
    });

    it("a selection in a block that takes none falls back to the nearest one around it that does", () => {
      const p = pane('<p data-src-id="8" data-src-new="1-1">first</p><ul data-src-id="1" data-src-new="2-2"><li data-src-id="2" data-src-new="2-2"><p data-src-id="3" data-src-new="5-5">inner</p></li></ul>');
      const text = p.querySelector('[data-src-id="3"]')!.firstChild!;
      window.getSelection()!.collapse(text, 1);
      expect(keyboardTarget(FILE, p)?.key).toBe('2:new');
      window.getSelection()!.removeAllRanges();
    });
  });

  it("Suggest change's text is the commented lines' source", () => {
    expect(sourceLines('a\r\nb\nc\n', 2, 3)).toBe('b\nc');
  });
});
