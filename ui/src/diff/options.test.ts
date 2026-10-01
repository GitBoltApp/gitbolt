import { describe, expect, it } from 'vitest';
import { clampEditorFont, diffEditorOptions, EDITOR_SCROLLBAR, fileViewOptions, HUNK_REGIONS, INLINE_BREAKPOINT_PX } from './options';

describe('Monaco options', () => {
  it('keeps every diff feature on but sticky scroll, which is off by default (H7)', () => {
    const o = diffEditorOptions({ mode: 'split', ignoreWhitespace: false, wordWrap: false }, true);
    expect(o.minimap).toEqual({ enabled: true });
    expect([o.renderOverviewRuler, o.renderIndicators, o.renderMarginRevertIcon, o.renderGutterMenu, o.enableSplitViewResizing, o.useInlineViewWhenSpaceIsLimited, o.diffCodeLens, o.folding]).toEqual([true, true, true, true, true, true, true, true]);
    expect(o.experimental).toEqual({ showMoves: true, showEmptyDecorations: true });
    expect(o.stickyScroll).toEqual({ enabled: false });
    expect(o.renderSideBySideInlineBreakpoint).toBe(INLINE_BREAKPOINT_PX);
    expect([o.readOnly, o.automaticLayout, o.renderValidationDecorations]).toEqual([true, false, 'off']);
  });

  it('maps the modes and toggles', () => {
    const hunk = diffEditorOptions({ mode: 'hunk', ignoreWhitespace: true, wordWrap: true }, false);
    expect([hunk.renderSideBySide, hunk.hideUnchangedRegions, hunk.ignoreTrimWhitespace, hunk.wordWrap, hunk.contextmenu]).toEqual([false, { ...HUNK_REGIONS }, true, 'on', false]);
    expect(HUNK_REGIONS).toEqual({ enabled: true, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 20 });
    const inline = diffEditorOptions({ mode: 'inline', ignoreWhitespace: false, wordWrap: false }, true);
    expect([inline.renderSideBySide, inline.hideUnchangedRegions, inline.ignoreTrimWhitespace, inline.wordWrap]).toEqual([false, { enabled: false }, false, 'off']);
    expect(diffEditorOptions({ mode: 'split', ignoreWhitespace: false, wordWrap: false }, true).renderSideBySide).toBe(true);
    expect(fileViewOptions(true, true)).toMatchObject({ readOnly: true, wordWrap: 'on', minimap: { enabled: true }, contextmenu: true });
  });

  it('sticky scroll follows its setting in both editors (H7)', () => {
    const p = { mode: 'inline', ignoreWhitespace: false, wordWrap: false } as const;
    expect(diffEditorOptions(p, true, true).stickyScroll).toEqual({ enabled: true });
    expect(diffEditorOptions(p, true, false).stickyScroll).toEqual({ enabled: false });
    expect(fileViewOptions(false, true).stickyScroll).toEqual({ enabled: false });
    expect(fileViewOptions(false, true, true).stickyScroll).toEqual({ enabled: true });
  });

  it("both editors use the app's slim, shadowless scrollbars (no arrows: Monaco's default)", () => {
    expect(EDITOR_SCROLLBAR).toEqual({ verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false });
    expect(diffEditorOptions({ mode: 'inline', ignoreWhitespace: false, wordWrap: false }, true).scrollbar).toEqual(EDITOR_SCROLLBAR);
    expect(fileViewOptions(false, true).scrollbar).toEqual(EDITOR_SCROLLBAR);
  });
});

describe('editor font size', () => {
  it('clamps to 8-32 whole px, 13 for a non-number, and reaches both editors', () => {
    expect([clampEditorFont(4), clampEditorFont(13.4), clampEditorFont(99), clampEditorFont(Number.NaN)]).toEqual([8, 13, 32, 13]);
    expect(diffEditorOptions({ mode: 'split', ignoreWhitespace: false, wordWrap: false }, true, false, 16).fontSize).toBe(16);
    expect(fileViewOptions(false, true, false, 99).fontSize).toBe(32);
    expect(fileViewOptions(false, true).fontSize).toBe(13);
  });
});
