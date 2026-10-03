import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LINE_NUMBER_CHARS, FileMarginStrip, NUMBER_GAP_PX } from './fileMargin';

const font = { fontSize: 12, lineHeight: 18, maxDigitWidth: 7 };

function fakeEditor() {
  const chars = (): number => ed.updateOptions.mock.calls.findLast(([o]) => o.lineNumbersMinChars !== undefined)?.[0].lineNumbersMinChars ?? DEFAULT_LINE_NUMBER_CHARS;
  const on: Record<string, Array<() => void>> = {};
  const sub = (name: string) => (cb: () => void) => { (on[name] ??= []).push(cb); return { dispose: () => { on[name] = on[name].filter((c) => c !== cb); } }; };
  let widget: { getDomNode(): HTMLElement } | null = null;
  const ed = {
    on,
    fire: (name: string) => on[name]?.forEach((c) => c()),
    widget: () => widget,
    scrollTop: 0,
    updateOptions: vi.fn((_o: { lineNumbersMinChars?: number; glyphMargin?: boolean }) => {}),
    addOverlayWidget: vi.fn((w: { getDomNode(): HTMLElement }) => { widget = w; }),
    removeOverlayWidget: vi.fn(() => { widget = null; }),
    lines: 120,
    editorWidth: 2000,
    // Monaco's own sizing: the line-number column is `lineNumbersMinChars` digit cells.
    getLayoutInfo: () => ({ width: ed.editorWidth, glyphMarginLeft: 0, lineNumbersLeft: 0, lineNumbersWidth: Math.round(chars() * font.maxDigitWidth), height: 500 }),
    getModel: () => ({ getLineCount: () => ed.lines }),
    getTopForLineNumber: (n: number) => (n - 1) * 19,
    getBottomForLineNumber: (n: number) => n * 19,
    getScrollTop: () => ed.scrollTop,
    getVisibleRanges: () => [{ startLineNumber: 2, endLineNumber: 9 }],
    onDidScrollChange: sub('scroll'),
    onDidLayoutChange: sub('layout'),
    onDidChangeModel: sub('model'),
    onDidChangeModelContent: sub('content'),
    onDidChangeConfiguration: sub('config'),
    onDidContentSizeChange: sub('size'),
  };
  return ed;
}

describe('the file editor\'s margin strip (spec #3 §3.10: the blame gutter)', () => {
  it('widens the line-number column, lays a node over its left part (left of the numbers), and reports the lines with the scroll applied', () => {
    const ed = fakeEditor();
    const strip = new FileMarginStrip(ed as never, () => font);
    const m = strip.set(260)!;
    // 268 px (strip + gap) in 7 px digits, plus the 3 digits of line 120.
    const chars = Math.ceil((260 + NUMBER_GAP_PX) / 7) + 3;
    expect(ed.updateOptions).toHaveBeenLastCalledWith({ lineNumbersMinChars: chars, glyphMargin: false });
    expect(strip.options()).toEqual({ lineNumbersMinChars: chars, glyphMargin: false });
    expect(ed.widget()!.getDomNode()).toBe(m.node);
    expect(m.node.style.left).toBe('0px');
    expect(m.node.style.width).toBe(`${Math.round(chars * 7) - 21 - NUMBER_GAP_PX}px`);
    expect(m.node.style.height).toBe('500px');
    expect(m.metrics()).toEqual({ lineHeight: 18, fontSize: 12 });
    ed.scrollTop = 38;
    expect(m.lineTop(3)).toBe(0);
    expect(m.lineBottom(3)).toBe(19);
    expect(m.visibleLines()).toEqual({ first: 2, last: 9 });
    const cb = vi.fn();
    const off = m.onChange(cb);
    ed.fire('scroll');
    ed.fire('model');
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    ed.fire('scroll');
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('a model with another digit count refits the column; the same one changes nothing', () => {
    const ed = fakeEditor();
    const strip = new FileMarginStrip(ed as never, () => font);
    strip.set(260);
    const calls = ed.updateOptions.mock.calls.length;
    ed.lines = 999;
    ed.fire('config');
    expect(ed.updateOptions.mock.calls.length).toBe(calls);
    ed.lines = 1000;
    ed.fire('model');
    expect(ed.updateOptions).toHaveBeenLastCalledWith({ lineNumbersMinChars: Math.ceil((260 + NUMBER_GAP_PX) / 7) + 4 });
  });

  it('caps the strip at its share of the editor, refitting as the editor resizes', () => {
    const ed = fakeEditor();
    ed.editorWidth = 500;
    const strip = new FileMarginStrip(ed as never, () => font);
    strip.set(200, 0.35);
    // 175 px (35% of 500) + the gap, then the 3 digits.
    expect(ed.updateOptions).toHaveBeenLastCalledWith({ lineNumbersMinChars: Math.ceil((175 + NUMBER_GAP_PX) / 7) + 3, glyphMargin: false });
    ed.editorWidth = 1000;
    ed.fire('layout');
    expect(ed.updateOptions).toHaveBeenLastCalledWith({ lineNumbersMinChars: Math.ceil((200 + NUMBER_GAP_PX) / 7) + 3 });
  });

  /** Review Focus 3. */
  it('set(0) restores Monaco\'s own line-number column and glyph margin, and removes the node', () => {
    const ed = fakeEditor();
    const strip = new FileMarginStrip(ed as never, () => font);
    strip.set(260);
    expect(strip.set(0)).toBeNull();
    expect(ed.updateOptions).toHaveBeenLastCalledWith({ lineNumbersMinChars: DEFAULT_LINE_NUMBER_CHARS, glyphMargin: true });
    expect(ed.removeOverlayWidget).toHaveBeenCalledTimes(1);
    expect(strip.options()).toEqual({});
    expect(ed.on.scroll).toEqual([]);
  });
});
