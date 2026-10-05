import type { EditorDiffPrefs } from './diffPrefs';
import { DEFAULT_EDITOR_SETTINGS } from './editorSettings';

/** Hunk mode's collapsed unchanged regions (spec §10.2). */
export const HUNK_REGIONS = { enabled: true, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 20 } as const;
/** Split falls back to Inline only below this width. Monaco's own 900 px would flip it in a
 * normal window, because the center panel sits beside the details panel. */
export const INLINE_BREAKPOINT_PX = 600;
export const EDITOR_FONT_SIZE = 13;
export const EDITOR_FONT_MIN = 8;
export const EDITOR_FONT_MAX = 32;
/** The saved editor font size, whole px within 8-32 (13 for anything that isn't a number). */
export const clampEditorFont = (px: number): number => (Number.isFinite(px) ? Math.min(EDITOR_FONT_MAX, Math.max(EDITOR_FONT_MIN, Math.round(px))) : EDITOR_FONT_SIZE);
/** The app's slim scrollbars (tokens.css; F31), in Monaco's own: 10 px, no shadow. Monaco draws
 * no arrow buttons unless asked, and its colours come from the theme (monaco/theme.ts). */
/** Unicode highlighting: invisible characters stay marked (a hidden bidi or zero-width character is
 * worth seeing in a diff), but "ambiguous" ones (box drawing, curly quotes, non-Latin letters) don't.
 * Their banner ("This document contains many ambiguous unicode characters") popped in and out
 * on every reload of a changing file, such as a growing log. */
export const UNICODE_HIGHLIGHT = { ambiguousCharacters: false, invisibleCharacters: true, nonBasicASCII: false } as const;

export const EDITOR_SCROLLBAR = { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false } as const;

/**
 * Monaco DiffEditor options. Every diff feature stays on (the user's decision): minimap, overview
 * ruler, +/- indicators, moved-code detection, split resizing, code lens, folding.
 * Except the margin's revert arrow and the gutter menu that draws it in newer Monaco (the user's call: it discarded working-copy lines with no
 * tooltip; the hunk/line actions and Discard say what they do, and undo), and sticky scroll, which is the user's setting, off by default (H7,
 * editorSettings.ts). The only fixed settings are the spec'd read-only and
 * no-language-service ones. It returns plain data (no Monaco import), so it's unit-testable.
 */
export function diffEditorOptions(p: EditorDiffPrefs, contextMenu: boolean, stickyScroll = DEFAULT_EDITOR_SETTINGS.stickyScroll, fontSize = EDITOR_FONT_SIZE) {
  return {
    readOnly: true,
    automaticLayout: false,
    renderValidationDecorations: 'off' as const,
    contextmenu: contextMenu,
    fontSize: clampEditorFont(fontSize),
    scrollbar: { ...EDITOR_SCROLLBAR },
    fixedOverflowWidgets: true,
    minimap: { enabled: true },
    unicodeHighlight: { ...UNICODE_HIGHLIGHT },
    renderOverviewRuler: true,
    renderIndicators: true,
    renderMarginRevertIcon: false,
    // Monaco 0.4x+ draws its revert arrow as the gutter menu (renderMarginRevertIcon alone is the old
    // icon): both off, so no unlabeled arrow can discard working-copy lines.
    renderGutterMenu: false,
    diffCodeLens: true,
    enableSplitViewResizing: true,
    useInlineViewWhenSpaceIsLimited: true,
    renderSideBySideInlineBreakpoint: INLINE_BREAKPOINT_PX,
    diffAlgorithm: 'advanced' as const,
    experimental: { showMoves: true, showEmptyDecorations: true },
    stickyScroll: { enabled: stickyScroll },
    folding: true,
    renderSideBySide: p.mode === 'split',
    hideUnchangedRegions: p.mode === 'hunk' ? { ...HUNK_REGIONS } : { enabled: false },
    ignoreTrimWhitespace: p.ignoreWhitespace,
    wordWrap: p.wordWrap ? ('on' as const) : ('off' as const),
    diffWordWrap: 'inherit' as const,
  };
}

/** Options for File View's read-only editor (spec §10.1). */
export function fileViewOptions(wordWrap: boolean, contextMenu: boolean, stickyScroll = DEFAULT_EDITOR_SETTINGS.stickyScroll, fontSize = EDITOR_FONT_SIZE) {
  return {
    readOnly: true,
    automaticLayout: false,
    renderValidationDecorations: 'off' as const,
    contextmenu: contextMenu,
    fontSize: clampEditorFont(fontSize),
    scrollbar: { ...EDITOR_SCROLLBAR },
    fixedOverflowWidgets: true,
    minimap: { enabled: true },
    unicodeHighlight: { ...UNICODE_HIGHLIGHT },
    stickyScroll: { enabled: stickyScroll },
    folding: true,
    wordWrap: wordWrap ? ('on' as const) : ('off' as const),
  };
}
