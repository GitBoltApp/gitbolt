/**
 * GitBolt's colours on top of the Shiki editor theme (`dark-plus`). They go into the theme Shiki
 * is created with, so every `shikiToMonaco` call (the first one, and one per newly loaded grammar)
 * defines the theme with them, before any editor exists (see `ensureTheme`).
 *
 * The values mirror the app's CSS tokens (tokens.css, the lane V block), which Monaco can't read:
 * keep them in sync.
 */
export const EDITOR_COLORS: Record<string, string> = {
  // One selection colour, focused or not (F22). dark-plus leaves the focused one to Monaco's
  // default (#264f78) and sets the unfocused one to a near-black #3a3d41, so a selection flipped
  // between blue and black as focus moved. Same as `--selection-bg`, the app's ::selection.
  'editor.selectionBackground': '#264f78',
  'editor.inactiveSelectionBackground': '#264f78',
  // Scrollbars (F31): a grey thumb only, as the app's (`--scroll-thumb-bg`,
  // `--scroll-thumb-hover-bg`); no track, no shadow.
  'scrollbarSlider.background': '#ffffff26',
  'scrollbarSlider.hoverBackground': '#ffffff40',
  'scrollbarSlider.activeBackground': '#ffffff40',
  'scrollbar.shadow': '#00000000',
  // Diff colours (F30): these override Monaco's too. Changed text gets its
  // red (#d9413d, brick) at 20%; whole lines the same faded a further 25%
  // (15%), so they're the lighter of the two. Green (#5cb85c, forest) is toned down further (H8,
  // 17.png): a whole added block carries both Monaco's line-insert and its whole-line char-insert,
  // so 10% and 12% composite to ~21%, the intended added block (20/15 composited to 32%).
  'diffEditor.insertedTextBackground': '#5cb85c1f',
  'diffEditor.removedTextBackground': '#d9413d33',
  'diffEditor.insertedLineBackground': '#5cb85c1a',
  'diffEditor.removedLineBackground': '#d9413d26',
  'diffEditorGutter.insertedLineBackground': '#5cb85c1a',
  'diffEditorGutter.removedLineBackground': '#d9413d26',
  'diffEditorOverview.insertedForeground': '#5cb85c99',
  'diffEditorOverview.removedForeground': '#d9413d99',
};

/** `theme` with `EDITOR_COLORS` layered over its own colours. */
export function withEditorColors<T extends { colors?: Record<string, string> }>(theme: T): T & { colors: Record<string, string> } {
  return { ...theme, colors: { ...theme.colors, ...EDITOR_COLORS } };
}
