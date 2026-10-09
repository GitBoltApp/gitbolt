import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./setup', () => ({
  monaco: {
    editor: {
      MouseTargetType: { GUTTER_GLYPH_MARGIN: 2, GUTTER_LINE_NUMBERS: 3, GUTTER_LINE_DECORATIONS: 4, GUTTER_VIEW_ZONE: 5, CONTENT_TEXT: 6, CONTENT_EMPTY: 7, CONTENT_VIEW_ZONE: 8, OVERLAY_WIDGET: 12 },
      EditorOption: { lineHeight: 75 },
    },
  },
}));

const { GLYPH_TIP, NO_COMMENT_CLASS, NO_COMMENT_TIP, NO_COMMENT_TIP_DELAY_MS, ReviewGutter } = await import('./reviewGutter');
const { showTooltip, useTooltip } = await import('../../ui/tooltipStore');

type Listener = (e: unknown) => void;
function fakeEditor() {
  const on: Record<string, Listener[]> = {};
  const sub = (name: string) => (cb: Listener) => { (on[name] ??= []).push(cb); return { dispose() { on[name] = on[name]!.filter((l) => l !== cb); } }; };
  let widget: HTMLElement | null = null;
  const ed = {
    decorations: [] as unknown[],
    widget: () => widget!,
    fire: (name: string, e: unknown) => on[name]?.forEach((l) => l(e)),
    /** What `getTargetAtClientPoint` answers. */
    target: vi.fn((_x: number, _y: number): unknown => null),
    addOverlayWidget: (w: { getDomNode(): HTMLElement }) => { widget = w.getDomNode(); },
    removeOverlayWidget: () => { widget = null; },
    hasWidget: () => widget !== null,
    listeners: () => Object.values(on).reduce((n, l) => n + l.length, 0),
    onMouseMove: sub('move'),
    onMouseLeave: sub('leave'),
    onDidScrollChange: sub('scroll'),
    onDidChangeModel: sub('model'),
    getLayoutInfo: () => ({ glyphMarginLeft: 0, glyphMarginWidth: 18 }),
    getOption: () => 19,
    getTopForLineNumber: (n: number) => (n - 1) * 19,
    getScrollTop: () => 0,
    getDomNode: () => null,
    getTargetAtClientPoint: (x: number, y: number) => ed.target(x, y),
    createDecorationsCollection: () => ({ set: (d: unknown[]) => { ed.decorations = d; }, clear: () => { ed.decorations = []; } }),
  };
  return ed;
}

const move = (type: number, lineNumber: number) => ({ target: { type, position: { lineNumber } }, event: { posy: 0 } });
const drag = (lo: number, hi: number) => [{ range: { startLineNumber: lo, startColumn: 1, endLineNumber: hi, endColumn: 1 }, options: { isWholeLine: true, className: 'review-drag', marginClassName: 'review-drag' } }];

function setup() {
  const original = fakeEditor();
  const modified = fakeEditor();
  const gutter = new ReviewGutter({ getOriginalEditor: () => original, getModifiedEditor: () => modified, getLineChanges: () => [] } as never);
  const onPick = vi.fn();
  gutter.set({ old: new Set([5, 6]), new: new Set([1, 2, 3, 9]), onPick });
  return { gutter, original, modified, onPick };
}

describe("review mode's gutter (spec 2026-10-08 §2)", () => {
  it('disposed (no review), its + and its listeners leave the editors', () => {
    const { gutter, original, modified } = setup();
    expect(modified.listeners()).toBe(4);
    gutter.dispose();
    expect([original.hasWidget(), modified.hasWidget(), original.listeners(), modified.listeners()]).toEqual([false, false, 0, 0]);
  });

  it("its + says what it does in the app's tooltip (no native title), gone with the pointer or the +", () => {
    const { modified } = setup();
    const btn = modified.widget();
    modified.fire('move', move(6, 9));
    expect(btn.hasAttribute('title')).toBe(false);
    fireEvent.mouseEnter(btn);
    expect(useTooltip.getState().tip?.text).toBe(GLYPH_TIP);
    fireEvent.mouseLeave(btn);
    expect(useTooltip.getState().tip).toBeNull();
    fireEvent.mouseEnter(btn);
    modified.fire('move', move(6, 4));
    expect(useTooltip.getState().tip).toBeNull();
  });

  it('shows a + on a hovered line that takes a comment, in its glyph cell; nothing on the others', () => {
    const { modified } = setup();
    const btn = modified.widget();
    expect(btn.hidden).toBe(true);
    modified.fire('move', move(6, 9));
    expect(btn.hidden).toBe(false);
    expect(btn.style.top).toBe(`${8 * 19}px`);
    expect(btn.getAttribute('aria-label')).toBe('Comment on this line');
    expect(btn.textContent).toBe('+');
    modified.fire('move', move(6, 7));
    expect(btn.hidden).toBe(true);
  });

  it('a click comments on that line', () => {
    const { modified, onPick } = setup();
    modified.fire('move', move(6, 9));
    fireEvent.mouseDown(modified.widget(), { button: 0 });
    fireEvent.mouseUp(window);
    expect(onPick).toHaveBeenCalledWith('modified', 9, 9);
  });

  it('a drag picks the lines it goes over, highlighted as it goes; the + stays where it started', () => {
    const { modified, onPick } = setup();
    modified.fire('move', move(3, 1));
    const btn = modified.widget();
    fireEvent.mouseDown(btn, { button: 0 });
    expect(modified.decorations).toEqual(drag(1, 1));
    modified.target.mockReturnValue({ type: 6, position: { lineNumber: 3 } });
    fireEvent.mouseMove(window, { clientX: 10, clientY: 60 });
    expect(modified.decorations).toEqual(drag(1, 3));
    modified.fire('move', move(6, 2));
    expect(btn.style.top).toBe('0px');
    fireEvent.mouseUp(window);
    expect(onPick).toHaveBeenCalledWith('modified', 1, 3);
    expect(modified.decorations).toEqual([]);
  });

  it('Esc ends a drag with nothing picked', () => {
    const { modified, onPick } = setup();
    modified.fire('move', move(6, 2));
    fireEvent.mouseDown(modified.widget(), { button: 0 });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.mouseUp(window);
    expect(onPick).not.toHaveBeenCalled();
    expect(modified.decorations).toEqual([]);
  });

  it('a press while a drag is under way (its mouseup lost) ends it first: nothing of it stays on the window', () => {
    const { modified, onPick } = setup();
    modified.fire('move', move(6, 9));
    fireEvent.mouseDown(modified.widget(), { button: 0 });
    fireEvent.mouseDown(modified.widget(), { button: 0 });
    fireEvent.mouseUp(window);
    expect(onPick.mock.calls).toEqual([['modified', 9, 9]]);
    // No drag left listening: Esc is the page's again.
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    window.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(false);
  });

  it("Split's old editor takes one too, and its drag stays on the old side", () => {
    const { original, modified, onPick } = setup();
    original.fire('move', move(3, 5));
    fireEvent.mouseDown(original.widget(), { button: 0 });
    original.target.mockReturnValue({ type: 6, position: { lineNumber: 6 } });
    fireEvent.mouseMove(window, { clientX: 1, clientY: 1 });
    fireEvent.mouseUp(window);
    expect(onPick).toHaveBeenCalledWith('original', 5, 6);
    expect(modified.target).not.toHaveBeenCalled();
  });

  it("Inline: an old line in a deleted-lines block takes one, and its drag picks the block's old lines, unhighlighted", () => {
    const original = Object.assign(fakeEditor(), { getModel: () => ({ getLineContent: (n: number) => `old ${n}` }) });
    const modified = fakeEditor();
    // Old lines 5-6 deleted: Monaco draws them in a zone after new line 4, 100 px down the editor.
    const root = document.createElement('div');
    root.innerHTML = '<div class="view-zones"><div class="line-delete" monaco-view-zone="z1"><div class="view-line">old 5</div><div class="view-line">old 6</div></div></div>';
    vi.spyOn(root.querySelector('.line-delete')!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 400, 38));
    Object.assign(modified, { getDomNode: () => root });
    const gutter = new ReviewGutter({ getOriginalEditor: () => original, getModifiedEditor: () => modified, getLineChanges: () => [{ originalStartLineNumber: 5, originalEndLineNumber: 6, modifiedStartLineNumber: 4, modifiedEndLineNumber: 0 }] } as never);
    const onPick = vi.fn();
    gutter.set({ old: new Set([5, 6]), new: new Set(), onPick });
    const zone = { type: 5, detail: { viewZoneId: 'z1', afterLineNumber: 4 } };
    modified.fire('move', { target: zone, event: { posy: 105 } });
    const btn = modified.widget();
    expect([btn.hidden, btn.style.top]).toEqual([false, '100px']);
    fireEvent.mouseDown(btn, { button: 0 });
    modified.target.mockReturnValue(zone);
    fireEvent.mouseMove(window, { clientX: 10, clientY: 125 });
    fireEvent.mouseUp(window);
    expect(onPick).toHaveBeenCalledWith('original', 5, 6);
    expect([original.decorations, modified.decorations]).toEqual([[], []]);
  });

  it('cleared, nothing shows, and a drag under way ends', () => {
    const { gutter, modified, onPick } = setup();
    modified.fire('move', move(6, 9));
    fireEvent.mouseDown(modified.widget(), { button: 0 });
    gutter.set(null);
    expect(modified.widget().hidden).toBe(true);
    fireEvent.mouseUp(window);
    expect(onPick).not.toHaveBeenCalled();
    modified.fire('move', move(6, 9));
    expect(modified.widget().hidden).toBe(true);
  });
});

describe("the gutter beside a folded thread's icon", () => {
  it('no + on a line with an icon: the icon has it', () => {
    const { gutter, modified } = setup();
    gutter.occupied = (side, line) => side === 'modified' && line === 9;
    modified.fire('move', move(2, 9));
    expect(modified.widget().hidden).toBe(true);
    modified.fire('move', move(2, 3));
    expect(modified.widget().hidden).toBe(false);
  });

  it("a press on the icon released on its line is the icon's click; dragged off it, it picks the lines as from the +", () => {
    const { gutter, modified, onPick } = setup();
    const click = vi.fn();
    expect(gutter.press('modified', 1, click)).toBe(true);
    // Not a drag yet: nothing highlighted.
    expect(modified.decorations).toEqual([]);
    fireEvent.mouseUp(window);
    expect([click.mock.calls.length, onPick.mock.calls.length]).toEqual([1, 0]);
    gutter.press('modified', 1, click);
    modified.target.mockReturnValue({ type: 6, position: { lineNumber: 3 } });
    fireEvent.mouseMove(window, { clientX: 10, clientY: 60 });
    expect(modified.decorations).toEqual(drag(1, 3));
    fireEvent.mouseUp(window);
    expect(onPick).toHaveBeenCalledWith('modified', 1, 3);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("on a line that takes no comment, the press is only ever a click; with no review there's no press", () => {
    const { gutter, modified, onPick } = setup();
    const click = vi.fn();
    gutter.press('modified', 7, click);
    modified.target.mockReturnValue({ type: 6, position: { lineNumber: 9 } });
    fireEvent.mouseMove(window, { clientX: 10, clientY: 60 });
    fireEvent.mouseUp(window);
    expect([click.mock.calls.length, onPick.mock.calls.length]).toEqual([1, 0]);
    gutter.set(null);
    expect(gutter.press('modified', 1, click)).toBe(false);
  });
});

describe('the glyph margin at a line that takes no comment', () => {
  /** The modified editor with a node (an editor's `.monaco-editor`), 40 px down the window. */
  function withRoot() {
    const s = setup();
    const root = document.createElement('div');
    root.className = 'monaco-editor';
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 40, 600, 400));
    Object.assign(s.modified, { getDomNode: () => root });
    useTooltip.setState({ tip: null });
    return { ...s, root };
  }
  const tip = () => useTooltip.getState().tip;
  const rest = () => vi.advanceTimersByTime(NO_COMMENT_TIP_DELAY_MS);
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("shows once the pointer rests there (the graph's 500 ms): a sweep down the margin shows none", () => {
    const { modified } = withRoot();
    expect(NO_COMMENT_TIP_DELAY_MS).toBe(500);
    modified.fire('move', move(2, 4));
    vi.advanceTimersByTime(NO_COMMENT_TIP_DELAY_MS - 100);
    expect(tip()).toBeNull();
    // On to the next line: it waits again from there.
    modified.fire('move', move(2, 5));
    vi.advanceTimersByTime(NO_COMMENT_TIP_DELAY_MS - 100);
    expect(tip()).toBeNull();
    // A move within the line doesn't restart it.
    modified.fire('move', move(2, 5));
    vi.advanceTimersByTime(100);
    expect(tip()?.text).toBe(NO_COMMENT_TIP);
  });

  it("the + and a folded thread's icon keep their tooltips at once", () => {
    const { modified } = withRoot();
    modified.fire('move', move(2, 9));
    fireEvent.mouseEnter(modified.widget());
    expect(tip()?.text).toBe(GLYPH_TIP);
  });

  it("says why in the app's tooltip, beside its glyph cell, with a not-allowed pointer; gone on a line with a +", () => {
    const { modified, root } = withRoot();
    modified.fire('move', move(2, 7));
    expect(root.classList.contains(NO_COMMENT_CLASS)).toBe(true);
    rest();
    expect(tip()).toMatchObject({ text: NO_COMMENT_TIP, placement: 'right' });
    expect([tip()!.rect.left, tip()!.rect.top, tip()!.rect.width, tip()!.rect.height]).toEqual([100, 40 + 6 * 19, 18, 19]);
    expect(root.classList.contains(NO_COMMENT_CLASS)).toBe(true);
    expect(modified.widget().hidden).toBe(true);
    modified.fire('move', move(2, 9));
    expect(tip()).toBeNull();
    expect(root.classList.contains(NO_COMMENT_CLASS)).toBe(false);
    expect(modified.widget().hidden).toBe(false);
  });

  it('only in the glyph margin: not over the line numbers or the text of such a line', () => {
    const { modified } = withRoot();
    modified.fire('move', move(3, 7));
    modified.fire('move', move(6, 7));
    modified.fire('move', move(7, 7));
    rest();
    expect(tip()).toBeNull();
    modified.fire('move', move(2, 7));
    modified.fire('move', move(3, 7));
    rest();
    expect(tip()).toBeNull();
  });

  it("not at a folded thread's icon, whose own tooltip stays", () => {
    const { gutter, modified } = withRoot();
    gutter.occupied = (side, line) => side === 'modified' && line === 8;
    modified.fire('move', move(2, 8));
    rest();
    expect(tip()).toBeNull();
    // From a line with no comment (its tooltip shown) onto the icon: the icon's tooltip comes
    // first, then the move.
    modified.fire('move', move(2, 7));
    rest();
    showTooltip(document.body, 'Thread by Grace Hopper: Why?', 0, 'right');
    modified.fire('move', move(2, 8));
    rest();
    expect(tip()?.text).toBe('Thread by Grace Hopper: Why?');
  });

  it('not while a drag is under way: a press takes it away, and the lines it goes over show none', () => {
    const { gutter, modified } = withRoot();
    modified.fire('move', move(2, 7));
    rest();
    expect(tip()?.text).toBe(NO_COMMENT_TIP);
    gutter.press('modified', 7, vi.fn());
    expect(tip()).toBeNull();
    modified.fire('move', move(2, 4));
    rest();
    expect(tip()).toBeNull();
    fireEvent.mouseUp(window);
    // Pending when a press comes: it never shows.
    modified.fire('move', move(2, 4));
    gutter.press('modified', 4, vi.fn());
    rest();
    expect(tip()).toBeNull();
    fireEvent.mouseUp(window);
    modified.fire('move', move(2, 5));
    rest();
    expect(tip()?.text).toBe(NO_COMMENT_TIP);
  });

  it('gone when the pointer leaves the editor, on a scroll, and with the review', () => {
    const { gutter, modified, root } = withRoot();
    const out = { event: { browserEvent: { relatedTarget: null } } };
    modified.fire('move', move(2, 7));
    rest();
    modified.fire('leave', out);
    expect(tip()).toBeNull();
    // Pending: a leave or a scroll cancels it.
    modified.fire('move', move(2, 7));
    modified.fire('leave', out);
    rest();
    expect(tip()).toBeNull();
    modified.fire('move', move(2, 7));
    modified.fire('scroll', {});
    rest();
    expect(tip()).toBeNull();
    // Still on that line after the scroll: it comes back with the next move.
    modified.fire('move', move(2, 7));
    rest();
    expect(tip()?.text).toBe(NO_COMMENT_TIP);
    gutter.set(null);
    expect([tip(), root.classList.contains(NO_COMMENT_CLASS)]).toEqual([null, false]);
    modified.fire('move', move(2, 7));
    rest();
    expect(tip()).toBeNull();
  });
});
