import { describe, expect, it, vi } from 'vitest';
import { LineGutter, type LineGutterSpec } from './lineGutter';

vi.mock('./setup', () => ({
  monaco: {
    editor: {
      MouseTargetType: { GUTTER_GLYPH_MARGIN: 2, GUTTER_LINE_NUMBERS: 3, GUTTER_LINE_DECORATIONS: 4, GUTTER_VIEW_ZONE: 5, CONTENT_TEXT: 6, CONTENT_EMPTY: 7, CONTENT_VIEW_ZONE: 8, OVERLAY_WIDGET: 12 },
      EditorOption: { lineHeight: 75 },
    },
  },
}));

type Listener = (e: unknown) => void;
function fakeEditor() {
  const on: Record<string, Listener[]> = {};
  const sub = (name: string) => (cb: Listener) => { (on[name] ??= []).push(cb); return { dispose() {} }; };
  let widget: HTMLElement | null = null;
  return {
    on,
    widget: () => widget!,
    fire: (name: string, e: unknown) => on[name]?.forEach((l) => l(e)),
    addOverlayWidget: (w: { getDomNode(): HTMLElement }) => { widget = w.getDomNode(); },
    onMouseMove: sub('move'),
    onMouseLeave: sub('leave'),
    onDidScrollChange: sub('scroll'),
    onDidChangeModel: sub('model'),
    getLayoutInfo: () => ({ glyphMarginLeft: 0, glyphMarginWidth: 18 }),
    getOption: () => 19,
    getTopForLineNumber: (n: number) => (n - 1) * 19,
    getScrollTop: () => 0,
    getDomNode: () => null,
  };
}

const move = (type: number, lineNumber: number) => ({ target: { type, position: { lineNumber } }, event: { posy: 0 } });

describe("the gutter's line button (spec #2 §7.3)", () => {
  function setup(spec: Partial<LineGutterSpec> = {}) {
    const original = fakeEditor();
    const modified = fakeEditor();
    const gutter = new LineGutter({ getOriginalEditor: () => original, getModifiedEditor: () => modified, getLineChanges: () => [] } as never);
    const onLine = vi.fn();
    gutter.set({ old: new Set([5]), new: new Set([5, 9]), staged: false, disabled: null, onLine, ...spec });
    return { gutter, original, modified, onLine };
  }

  it('shows + on a hovered changed line, in its glyph cell, and stages that line; nothing on other lines', () => {
    const { modified, onLine } = setup();
    const btn = modified.widget();
    expect(btn.hidden).toBe(true);
    modified.fire('move', move(6, 9));
    expect(btn.hidden).toBe(false);
    expect(btn.style.top).toBe(`${8 * 19}px`);
    expect(btn.getAttribute('aria-label')).toBe('Stage this line');
    expect(btn.textContent).toBe('+');
    btn.click();
    expect(onLine).toHaveBeenCalledWith('modified', 9);
    // Over the button itself, it stays; on an unchanged line, it goes.
    modified.fire('move', { target: { type: 12 }, event: { posy: 0 } });
    expect(btn.hidden).toBe(false);
    modified.fire('move', move(6, 7));
    expect(btn.hidden).toBe(true);
  });

  it("the original side's - lines get it too; a scroll hides it", () => {
    const { original, onLine } = setup();
    original.fire('move', move(3, 5));
    expect(original.widget().hidden).toBe(false);
    original.widget().click();
    expect(onLine).toHaveBeenCalledWith('original', 5);
    original.fire('scroll', {});
    expect(original.widget().hidden).toBe(true);
  });

  it('staged: a red − that unstages; a reason disables it, as its tooltip', () => {
    const { modified, onLine } = setup({ staged: true, disabled: 'Save first' });
    modified.fire('move', move(6, 5));
    const btn = modified.widget();
    expect(btn.classList.contains('unstage')).toBe(true);
    expect(btn.getAttribute('aria-label')).toBe('Unstage this line');
    expect(btn.title).toBe('Save first');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    btn.click();
    expect(onLine).not.toHaveBeenCalled();
  });

  it('cleared, nothing shows', () => {
    const { gutter, modified } = setup();
    modified.fire('move', move(6, 9));
    gutter.set(null);
    expect(modified.widget().hidden).toBe(true);
    modified.fire('move', move(6, 9));
    expect(modified.widget().hidden).toBe(true);
  });
});
