import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DECORATIONS_PX, FileMarginStrip } from './fileMargin';

function fakeEditor() {
  const on: Record<string, Array<() => void>> = {};
  const sub = (name: string) => (cb: () => void) => { (on[name] ??= []).push(cb); return { dispose: () => { on[name] = on[name].filter((c) => c !== cb); } }; };
  let widget: { getDomNode(): HTMLElement } | null = null;
  const ed = {
    on,
    fire: (name: string) => on[name]?.forEach((c) => c()),
    widget: () => widget,
    scrollTop: 0,
    updateOptions: vi.fn(),
    addOverlayWidget: vi.fn((w: { getDomNode(): HTMLElement }) => { widget = w; }),
    removeOverlayWidget: vi.fn(() => { widget = null; }),
    getLayoutInfo: () => ({ decorationsLeft: 40, decorationsWidth: 260, height: 500 }),
    getOption: () => 19,
    getTopForLineNumber: (n: number) => (n - 1) * 19,
    getBottomForLineNumber: (n: number) => n * 19,
    getScrollTop: () => ed.scrollTop,
    getVisibleRanges: () => [{ startLineNumber: 2, endLineNumber: 9 }],
    onDidScrollChange: sub('scroll'),
    onDidLayoutChange: sub('layout'),
    onDidChangeModel: sub('model'),
    onDidContentSizeChange: sub('size'),
  };
  return ed;
}

describe('the file editor\'s margin strip (spec #3 §3.10: the blame gutter)', () => {
  it('reserves the strip, lays a node over it, and reports the lines with the scroll applied', () => {
    const ed = fakeEditor();
    const strip = new FileMarginStrip(ed as never);
    const m = strip.set(260)!;
    expect(ed.updateOptions).toHaveBeenLastCalledWith({ lineDecorationsWidth: 260, folding: false });
    expect(strip.options()).toEqual({ lineDecorationsWidth: 260, folding: false });
    expect(ed.widget()!.getDomNode()).toBe(m.node);
    expect(m.node.style.left).toBe('40px');
    expect(m.node.style.width).toBe('260px');
    expect(m.node.style.height).toBe('500px');
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

  /** Review Focus 3. */
  it('set(0) restores Monaco\'s own decorations width and folding, and removes the node', () => {
    const ed = fakeEditor();
    const strip = new FileMarginStrip(ed as never);
    strip.set(260);
    expect(strip.set(0)).toBeNull();
    expect(ed.updateOptions).toHaveBeenLastCalledWith({ lineDecorationsWidth: DEFAULT_DECORATIONS_PX, folding: true });
    expect(ed.removeOverlayWidget).toHaveBeenCalledTimes(1);
    expect(strip.options()).toEqual({});
    expect(ed.on.scroll).toEqual([]);
  });
});
