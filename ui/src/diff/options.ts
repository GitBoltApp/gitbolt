import type { DiffPrefs } from './diffPrefs';

/** Hunk mode's collapsed unchanged regions (spec §10.2). */
export const HUNK_REGIONS = { enabled: true, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 20 } as const;
/** Split falls back to Inline only below this width. Monaco's own 900 px would flip it in a
 * normal window, because the center panel sits beside the details panel. */
export const INLINE_BREAKPOINT_PX = 600;
export const EDITOR_FONT_SIZE = 13;

/**
 * Monaco DiffEditor options. Every diff feature stays on (the user's decision): minimap, overview
 * ruler, +/- indicators, moved-code detection, split resizing, gutter menu, revert icons, code
 * lens, sticky scroll, folding. The only fixed settings are the spec'd read-only and
 * no-language-service ones. It returns plain data (no Monaco import), so it's unit-testable.
 */
export function diffEditorOptions(p: DiffPrefs, contextMenu: boolean) {
  return {
    readOnly: true,
    automaticLayout: false,
    renderValidationDecorations: 'off' as const,
    contextmenu: contextMenu,
    fontSize: EDITOR_FONT_SIZE,
    minimap: { enabled: true },
    renderOverviewRuler: true,
    renderIndicators: true,
    renderMarginRevertIcon: true,
    renderGutterMenu: true,
    diffCodeLens: true,
    enableSplitViewResizing: true,
    useInlineViewWhenSpaceIsLimited: true,
    renderSideBySideInlineBreakpoint: INLINE_BREAKPOINT_PX,
    diffAlgorithm: 'advanced' as const,
    experimental: { showMoves: true, showEmptyDecorations: true },
    stickyScroll: { enabled: true },
    folding: true,
    renderSideBySide: p.mode === 'split',
    hideUnchangedRegions: p.mode === 'hunk' ? { ...HUNK_REGIONS } : { enabled: false },
    ignoreTrimWhitespace: p.ignoreWhitespace,
    wordWrap: p.wordWrap ? ('on' as const) : ('off' as const),
    diffWordWrap: 'inherit' as const,
  };
}

/** Options for File View's read-only editor (spec §10.1). */
export function fileViewOptions(wordWrap: boolean, contextMenu: boolean) {
  return {
    readOnly: true,
    automaticLayout: false,
    renderValidationDecorations: 'off' as const,
    contextmenu: contextMenu,
    fontSize: EDITOR_FONT_SIZE,
    minimap: { enabled: true },
    stickyScroll: { enabled: true },
    folding: true,
    wordWrap: wordWrap ? ('on' as const) : ('off' as const),
  };
}
