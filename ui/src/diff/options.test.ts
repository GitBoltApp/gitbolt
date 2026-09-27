import { describe, expect, it } from 'vitest';
import { diffEditorOptions, fileViewOptions, HUNK_REGIONS, INLINE_BREAKPOINT_PX } from './options';

describe('Monaco options', () => {
  it('keeps every diff feature on', () => {
    const o = diffEditorOptions({ mode: 'split', ignoreWhitespace: false, wordWrap: false }, true);
    expect(o.minimap).toEqual({ enabled: true });
    expect([o.renderOverviewRuler, o.renderIndicators, o.renderMarginRevertIcon, o.renderGutterMenu, o.enableSplitViewResizing, o.useInlineViewWhenSpaceIsLimited, o.diffCodeLens, o.folding]).toEqual([true, true, true, true, true, true, true, true]);
    expect(o.experimental).toEqual({ showMoves: true, showEmptyDecorations: true });
    expect(o.stickyScroll).toEqual({ enabled: true });
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
});
