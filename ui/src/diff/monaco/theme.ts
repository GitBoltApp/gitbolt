import { DEFAULT_THEME_ID, THEMES, type ThemeDef } from '../../theme/themes';

/**
 * GitBolt's colours on top of a Shiki editor theme, per app theme (plan 1D ruling R6). They go into
 * the themes Shiki is created with, so every `shikiToMonaco` call (the first one, and one per newly
 * loaded grammar) defines each theme with them, before any editor exists (see `ensureTheme`).
 *
 * They derive from the app theme's tokens, which Monaco can't read from CSS: the background,
 * gutter and minimap are `app-bg0`, the selection is `selection-bg`, the scrollbar thumbs are the
 * scroll-thumb tokens, and the diff colours are the theme's `green` and `red` at fixed alphas.
 */

/** `#rrggbb` or `rgba(r, g, b, a)` → `#rrggbb` or `#rrggbbaa` (what Monaco's theme colours take). */
function toHex(c: string): string {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(c);
  if (!m) return c.toLowerCase();
  const h = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${h(+m[1])}${h(+m[2])}${h(+m[3])}${m[4] === undefined || +m[4] >= 1 ? '' : h(+m[4] * 255)}`;
}

/** `colour` (opaque) at an 8-bit alpha, as two hex digits. */
const at = (colour: string, a: string) => `${toHex(colour).slice(0, 7)}${a}`;

/** The overlay for one app theme. */
export function editorColors(def: ThemeDef): Record<string, string> {
  const c = def.colors;
  const bg = toHex(c['app-bg0']);
  const sel = toHex(c['selection-bg']);
  return {
    // One selection colour, focused or not (F22): dark-plus sets the unfocused one to a near-black,
    // so a selection flipped colour as focus moved. Same as `--selection-bg`, the app's ::selection.
    // K34: the editor's background is the app's --app-bg0, not the Shiki theme's
    // own; the gutter and minimap follow it.
    'editor.background': bg,
    'editorGutter.background': bg,
    'minimap.background': bg,
    'editor.selectionBackground': sel,
    'editor.inactiveSelectionBackground': sel,
    // Scrollbars (F31): a thumb only, as the app's (`--scroll-thumb-bg`, `--scroll-thumb-hover-bg`);
    // no track, no shadow.
    'scrollbarSlider.background': toHex(c['scroll-thumb-bg']),
    'scrollbarSlider.hoverBackground': toHex(c['scroll-thumb-hover-bg']),
    'scrollbarSlider.activeBackground': toHex(c['scroll-thumb-hover-bg']),
    'scrollbar.shadow': '#00000000',
    // Diff colours (F30): these override Monaco's too. Changed text
    // gets its red at 20%, whole lines 15%; green is toned down further (H8, 17.png): a whole added
    // block carries both Monaco's line-insert and its whole-line char-insert, so 10% and 12%
    // composite to ~21%, the intended added block.
    'diffEditor.insertedTextBackground': at(c.green, '1f'),
    'diffEditor.removedTextBackground': at(c.red, '33'),
    'diffEditor.insertedLineBackground': at(c.green, '1a'),
    'diffEditor.removedLineBackground': at(c.red, '26'),
    'diffEditorGutter.insertedLineBackground': at(c.green, '1a'),
    'diffEditorGutter.removedLineBackground': at(c.red, '26'),
    'diffEditorOverview.insertedForeground': at(c.green, '99'),
    'diffEditorOverview.removedForeground': at(c.red, '99'),
  };
}

/** Default Dark's overlay: today's editor, exactly. */
export const EDITOR_COLORS: Record<string, string> = editorColors(THEMES[DEFAULT_THEME_ID]);

/** `theme` with `overlay` (default: Default Dark's) layered over its own colours. */
export function withEditorColors<T extends { colors?: Record<string, string> }>(theme: T, overlay: Record<string, string> = EDITOR_COLORS): T & { colors: Record<string, string> } {
  return { ...theme, colors: { ...theme.colors, ...overlay } };
}
