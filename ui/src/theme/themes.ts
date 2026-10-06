import { contrastRatio } from './contrast';
/**
 * The ten built-in themes (spec §12.1): pure data. A theme sets every colour custom property in
 * COLOR_TOKENS on :root, plus the ten graph lanes (`--graph-0..9`); non-colour tokens (fonts,
 * motion, density metrics) stay in tokens.css and density.ts. `tokens.css` carries Default Dark
 * as the first-paint values, and themes.test.ts holds the two to each other.
 */
export const THEME_IDS = ['default-dark', 'light', 'monokai', 'darcula', 'dracula', 'one-dark', 'solarized-dark', 'solarized-light', 'github-dark', 'nord'] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const DEFAULT_THEME_ID: ThemeId = 'default-dark';
export const isThemeId = (v: unknown): v is ThemeId => typeof v === 'string' && (THEME_IDS as readonly string[]).includes(v);

/** The tokens each theme states outright. */
const CORE_TOKENS = [
  // Surfaces: the graph and editor area, the sidebar, popups and dialogs, the status bar, and
  // the three bar greys (K32-K34, K65).
  'app-bg0', 'panel-bg0', 'panel-bg1', 'toolbar-bg0', 'action-bar-bg', 'tab-bar-bg', 'file-bar-bg',
  // Text: selected (the brightest), normal, secondary, disabled; and text on a saturated fill
  // (the blue buttons, the bell's badge, the checked-out check box, avatar initials).
  'text-selected', 'text-normal', 'text-secondary', 'text-disabled', 'text-on-accent',
  'stats-added', 'stats-deleted',
  'red', 'orange', 'yellow', 'green', 'blue', 'link',
  // K55 sidebar counts; K35 the checked-out row and its check box; F22 DOM text selection.
  'count-blue', 'checked-out-row', 'checked-out', 'selection-bg',
  'conflict-ours', 'conflict-theirs', 'conflict-base',
  // The WIP row's summary box (graph.css).
  'wip-input-bg', 'wip-input-border', 'wip-input-placeholder',
] as const;

/** The tokens `derive` computes from the core ones; a theme may still override any of them. */
const DERIVED_TOKENS = [
  'hover-row', 'selected-row', 'section-border', 'focus-outline',
  // graph/rowDim.ts's two levels; K62 sidebar icons.
  'text-row-dimmed', 'text-row-dimmed-branch', 'sidebar-icon', 'avatar-backdrop',
  // +/− totals (AA on panel-bg0) and the file-status colours (lane D).
  'stats-added-bright', 'stats-deleted-bright',
  'status-added', 'status-modified', 'status-deleted', 'status-renamed', 'status-conflicted',
  'scroll-thumb-bg', 'scroll-thumb-hover-bg',
  // Quiet button fills, J11's image frame, shadows and the modal backdrop.
  'control-bg', 'control-hover-bg', 'image-frame-border',
  'shadow-modal', 'shadow-popup', 'shadow-tooltip', 'backdrop',
  // The canvas: a commit node's fill and initials, and the collapse zone's shade (draw.ts).
  'node-fill', 'node-text', 'collapse-strip',
  // The tick on a filled merge-tool checkbox (checkBox.ts): white or the darkest ground, whichever
  // contrasts more with its side's fill.
  'conflict-ours-tick', 'conflict-theirs-tick',
  // The diff's colours, the editor's and the hex view's alike (diff/monaco/theme.ts, diff/hex.css):
  // changed text and whole lines in green and red, and the hatching past a side's end (Monaco's
  // own diagonal fill).
  'diff-inserted-text', 'diff-removed-text', 'diff-inserted-line', 'diff-removed-line', 'diff-diagonal-fill',
  // Settings › Accounts' forge marks: the forges' own brand colours, the same in every theme.
  'forge-gitlab', 'forge-github',
  // The MR/PR view's merged state and mentions (forge/mrview): purple.
  'purple',
  // A switch's track, on and off (ui/Switch.tsx); its knob is --text-on-accent.
  'switch-on', 'switch-off',
] as const;

/** Every colour custom property a theme sets on :root. */
export const COLOR_TOKENS = [...CORE_TOKENS, ...DERIVED_TOKENS] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];
type CoreColors = Record<(typeof CORE_TOKENS)[number], string>;
type DerivedColors = Record<(typeof DERIVED_TOKENS)[number], string>;

export interface ThemeDef {
  id: ThemeId;
  label: string;
  kind: 'dark' | 'light';
  /** Shiki theme loaded into the highlighter and handed to Monaco by name (spec §12.1). */
  editorTheme: string;
  colors: Record<ColorToken, string>;
  /** Lane colors 0–9. The user can override them per theme in Settings. */
  graph: readonly string[];
  /** Avatar initials on a lane colour, the same on every lane. Omitted: per lane, white or the
   * theme's dark ink, whichever contrasts more (apply.ts resolveColors). */
  laneText?: string;
}

/** The Shiki themes §12.1 pairs that @shikijs/themes 4.4.3 ships. Darcula isn't among them (darcula.ts);
 * GitHub Dark uses the modern `github-dark-default` palette (amendment 3, ruling R5). */
export const SHIKI_BUNDLED_THEMES = ['dark-plus', 'light-plus', 'monokai', 'dracula', 'one-dark-pro', 'solarized-dark', 'solarized-light', 'github-dark-default', 'nord'] as const;

/** `#rrggbb` at alpha `a`, written the way tokens.css writes it. */
/** A tick drawn on `fill`: white, or the theme's darkest ground, whichever contrasts more. */
function tickOn(fill: string, ground: string): string {
  return contrastRatio('#ffffff', fill) >= contrastRatio(ground, fill) ? '#ffffff' : ground;
}

function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** The diff's colours (F30, H8): the theme's green and red at fixed alphas. Changed
 * text gets its red at 20%, whole lines 15%; green is toned down further, as a whole added block
 * carries both the line and the char insert (10% and 12% composite to ~21% for an added block).
 * The hatching is Monaco's default `diffEditor.diagonalFill`. */
function diffColors(c: Pick<CoreColors, 'green' | 'red'>, light: boolean) {
  return {
    'diff-inserted-text': alpha(c.green, 0.12),
    'diff-removed-text': alpha(c.red, 0.2),
    'diff-inserted-line': alpha(c.green, 0.1),
    'diff-removed-line': alpha(c.red, 0.15),
    'diff-diagonal-fill': light ? 'rgba(34, 34, 34, 0.2)' : 'rgba(204, 204, 204, 0.2)',
  };
}

/** The derived tokens, from the core ones: tints of the text colour and the accent blue, the
 * status colours from the palette, and black shadows (lighter on a light theme). */
function derive(c: CoreColors, kind: 'dark' | 'light'): DerivedColors {
  const fg = c['text-selected'];
  const light = kind === 'light';
  return {
    'hover-row': alpha(c.blue, light ? 0.08 : 0.1),
    'selected-row': alpha(c.blue, light ? 0.16 : 0.2),
    'section-border': alpha(fg, light ? 0.12 : 0.08),
    'focus-outline': alpha(c.blue, light ? 0.5 : 0.6),
    'text-row-dimmed': alpha(fg, light ? 0.28 : 0.2),
    'text-row-dimmed-branch': alpha(fg, 0.5),
    // A step below the secondary text, so the labels beside the icons stand out.
    'sidebar-icon': alpha(fg, light ? 0.5 : 0.45),
    // Behind an avatar picture (graph nodes and the <Avatar> component alike): a light neutral on
    // every theme, so a transparent picture drawn in dark ink stays visible.
    'avatar-backdrop': '#e6e7ea',
    'stats-added-bright': c.green,
    'stats-deleted-bright': c.red,
    'status-added': c.green,
    'status-modified': c.orange,
    'status-deleted': c.red,
    'status-renamed': c.blue,
    'status-conflicted': c['conflict-base'],
    'scroll-thumb-bg': alpha(fg, light ? 0.2 : 0.15),
    'scroll-thumb-hover-bg': alpha(fg, light ? 0.32 : 0.25),
    'control-bg': alpha(fg, 0.06),
    'control-hover-bg': alpha(fg, 0.12),
    'image-frame-border': alpha(fg, light ? 0.3 : 0.22),
    'shadow-modal': light ? 'rgba(0, 0, 0, 0.2)' : 'rgba(0, 0, 0, 0.5)',
    'shadow-popup': light ? 'rgba(0, 0, 0, 0.18)' : 'rgba(0, 0, 0, 0.45)',
    'shadow-tooltip': light ? 'rgba(0, 0, 0, 0.16)' : 'rgba(0, 0, 0, 0.4)',
    backdrop: light ? 'rgba(0, 0, 0, 0.25)' : 'rgba(0, 0, 0, 0.45)',
    'node-fill': c['app-bg0'],
    'node-text': fg,
    // Black, so draw.ts's gradient can fade it to `rgba(0,0,0,0)` without a grey fringe.
    'collapse-strip': light ? 'rgba(0, 0, 0, 0.15)' : 'rgba(0, 0, 0, 0.4)',
    'conflict-ours-tick': tickOn(c['conflict-ours'], c['app-bg0']),
    'conflict-theirs-tick': tickOn(c['conflict-theirs'], c['app-bg0']),
    ...diffColors(c, light),
    'forge-gitlab': '#e2432a',
    'forge-github': '#6e5494',
    purple: light ? '#8250df' : '#a371f7',
    'switch-on': c.blue,
    'switch-off': alpha(fg, light ? 0.24 : 0.16),
  };
}

function theme(id: ThemeId, label: string, kind: 'dark' | 'light', editorTheme: string, core: CoreColors, graph: readonly string[], overrides: Partial<DerivedColors> = {}): ThemeDef {
  return { id, label, kind, editorTheme, colors: { ...core, ...derive(core, kind), ...overrides }, graph };
}

export const THEMES: Record<ThemeId, ThemeDef> = {
  // Default Dark, with the user-sampled 1C values (K32-K65): exactly today's tokens.css, every
  // token spelled out. The lanes are also the app icon's palette.
  'default-dark': {
    id: 'default-dark', label: 'Default Dark', kind: 'dark', editorTheme: 'dark-plus',
    colors: {
      'app-bg0': '#1c1e23', 'panel-bg0': '#262930', 'panel-bg1': '#30343c', 'toolbar-bg0': '#2a2e36',
      'action-bar-bg': '#33373f', 'tab-bar-bg': '#1f2228', 'file-bar-bg': '#272a31',
      'text-selected': '#ffffff', 'text-normal': 'rgba(255, 255, 255, 0.75)', 'text-secondary': 'rgba(255, 255, 255, 0.6)', 'text-disabled': 'rgba(255, 255, 255, 0.4)',
      'text-on-accent': '#ffffff',
      'stats-added': '#347d39', 'stats-deleted': '#c93c37',
      red: '#d9413d', orange: '#de9b43', yellow: '#ecb91c', green: '#5cb85c', blue: '#4d88ff', link: '#40c5ec',
      'count-blue': '#6d9deb', 'checked-out-row': '#37563e', 'checked-out': '#457c4a', 'selection-bg': '#264f78',
      'conflict-ours': '#15a0bf', 'conflict-theirs': '#f2ca33', 'conflict-base': '#c517b6',
      'wip-input-bg': '#16181c', 'wip-input-border': '#282a2d', 'wip-input-placeholder': '#6e6f71',
      'hover-row': 'rgba(77, 136, 255, 0.1)', 'selected-row': 'rgba(77, 136, 255, 0.2)', 'section-border': 'rgba(255, 255, 255, 0.08)', 'focus-outline': 'rgba(77, 136, 255, 0.6)',
      'text-row-dimmed': 'rgba(255, 255, 255, 0.2)', 'text-row-dimmed-branch': 'rgba(255, 255, 255, 0.5)', 'sidebar-icon': 'rgba(255, 255, 255, 0.45)', 'avatar-backdrop': '#e6e7ea',
      'stats-added-bright': '#5cb85c', 'stats-deleted-bright': '#f0625d',
      'status-added': '#5cb85c', 'status-modified': '#de9b43', 'status-deleted': '#d9413d', 'status-renamed': '#4d88ff', 'status-conflicted': '#b56ee6',
      'scroll-thumb-bg': 'rgba(255, 255, 255, 0.15)', 'scroll-thumb-hover-bg': 'rgba(255, 255, 255, 0.25)',
      'control-bg': 'rgba(255, 255, 255, 0.06)', 'control-hover-bg': 'rgba(255, 255, 255, 0.12)', 'image-frame-border': 'rgba(255, 255, 255, 0.22)',
      'shadow-modal': 'rgba(0, 0, 0, 0.5)', 'shadow-popup': 'rgba(0, 0, 0, 0.45)', 'shadow-tooltip': 'rgba(0, 0, 0, 0.4)', backdrop: 'rgba(0, 0, 0, 0.45)',
      'node-fill': '#1c1e23', 'node-text': '#ffffff', 'collapse-strip': 'rgba(0, 0, 0, 0.4)',
      'conflict-ours-tick': '#1c1e23', 'conflict-theirs-tick': '#1c1e23',
      'diff-inserted-text': 'rgba(92, 184, 92, 0.12)', 'diff-removed-text': 'rgba(217, 65, 61, 0.2)',
      'diff-inserted-line': 'rgba(92, 184, 92, 0.1)', 'diff-removed-line': 'rgba(217, 65, 61, 0.15)',
      'diff-diagonal-fill': 'rgba(204, 204, 204, 0.2)',
      'forge-gitlab': '#e2432a', 'forge-github': '#6e5494', purple: '#a371f7',
      'switch-on': '#4d88ff', 'switch-off': 'rgba(255, 255, 255, 0.16)',
    },
    graph: ['#15a0bf', '#0669f7', '#8e00c2', '#c517b6', '#d90171', '#cd0101', '#f25d2e', '#f2ca33', '#7bd938', '#2ece9d'],
    // White initials on every lane, its yellow included (1C's look, kept as is).
    laneText: '#ffffff',
  },
  light: theme('light', 'Light', 'light', 'light-plus', {
    'app-bg0': '#ffffff', 'panel-bg0': '#f3f4f6', 'panel-bg1': '#ffffff', 'toolbar-bg0': '#e9ebef',
    'action-bar-bg': '#e6e8ec', 'tab-bar-bg': '#d9dce2', 'file-bar-bg': '#f3f4f6',
    'text-selected': '#0b0d10', 'text-normal': 'rgba(11, 13, 16, 0.82)', 'text-secondary': 'rgba(11, 13, 16, 0.64)', 'text-disabled': 'rgba(11, 13, 16, 0.42)',
    'text-on-accent': '#ffffff',
    'stats-added': '#1a7f37', 'stats-deleted': '#cf222e',
    red: '#cf222e', orange: '#bc4c00', yellow: '#9a6700', green: '#1a7f37', blue: '#2563eb', link: '#0969da',
    'count-blue': '#2563eb', 'checked-out-row': '#d3ecd8', 'checked-out': '#2f8a3e', 'selection-bg': '#add6ff',
    'conflict-ours': '#0e7c95', 'conflict-theirs': '#a67c00', 'conflict-base': '#a8129b',
    'wip-input-bg': '#f3f4f6', 'wip-input-border': '#c9cdd4', 'wip-input-placeholder': '#767c86',
  }, ['#0e7c95', '#0558d0', '#7a00a8', '#a8129b', '#b8015f', '#b00000', '#c9431a', '#a67c00', '#4b8f1c', '#138a67']),
  monokai: theme('monokai', 'Monokai', 'dark', 'monokai', {
    'app-bg0': '#272822', 'panel-bg0': '#1e1f1c', 'panel-bg1': '#3e3d32', 'toolbar-bg0': '#414339',
    'action-bar-bg': '#3b3c35', 'tab-bar-bg': '#1e1f1c', 'file-bar-bg': '#34352f',
    'text-selected': '#ffffff', 'text-normal': 'rgba(248, 248, 242, 0.8)', 'text-secondary': 'rgba(248, 248, 242, 0.62)', 'text-disabled': 'rgba(248, 248, 242, 0.4)',
    'text-on-accent': '#272822',
    'stats-added': '#a6e22e', 'stats-deleted': '#f92672',
    red: '#f92672', orange: '#fd971f', yellow: '#e6db74', green: '#a6e22e', blue: '#66d9ef', link: '#66d9ef',
    'count-blue': '#66d9ef', 'checked-out-row': '#3d4a26', 'checked-out': '#a6e22e', 'selection-bg': '#49483e',
    'conflict-ours': '#66d9ef', 'conflict-theirs': '#e6db74', 'conflict-base': '#ae81ff',
    'wip-input-bg': '#1e1f1c', 'wip-input-border': '#414339', 'wip-input-placeholder': '#75715e',
  }, ['#66d9ef', '#a6e22e', '#f92672', '#fd971f', '#ae81ff', '#e6db74', '#38ccd1', '#f96d9a', '#8fbf2a', '#c2a6ff'], {
    'stats-deleted-bright': '#fa4a87',
  }),
  darcula: theme('darcula', 'Darcula', 'dark', 'darcula', {
    'app-bg0': '#2b2b2b', 'panel-bg0': '#313335', 'panel-bg1': '#3c3f41', 'toolbar-bg0': '#3c3f41',
    'action-bar-bg': '#45494a', 'tab-bar-bg': '#2f3133', 'file-bar-bg': '#353739',
    'text-selected': '#ffffff', 'text-normal': '#bbbbbb', 'text-secondary': '#999999', 'text-disabled': '#6e6e6e',
    'text-on-accent': '#ffffff',
    'stats-added': '#629755', 'stats-deleted': '#bc3f3c',
    red: '#e05555', orange: '#cc7832', yellow: '#ffc66d', green: '#6a8759', blue: '#4a88c7', link: '#589df6',
    'count-blue': '#589df6', 'checked-out-row': '#3b4d38', 'checked-out': '#499c54', 'selection-bg': '#214283',
    'conflict-ours': '#6897bb', 'conflict-theirs': '#bbb529', 'conflict-base': '#9876aa',
    'wip-input-bg': '#262626', 'wip-input-border': '#4a4d4f', 'wip-input-placeholder': '#787878',
  }, ['#6897bb', '#cc7832', '#6a8759', '#9876aa', '#ffc66d', '#bc3f3c', '#299999', '#bbb529', '#e8bf6a', '#629755'], {
    'stats-added-bright': '#7fb26b', 'stats-deleted-bright': '#f78181',
  }),
  dracula: theme('dracula', 'Dracula', 'dark', 'dracula', {
    'app-bg0': '#282a36', 'panel-bg0': '#21222c', 'panel-bg1': '#343746', 'toolbar-bg0': '#191a21',
    'action-bar-bg': '#343746', 'tab-bar-bg': '#21222c', 'file-bar-bg': '#2c2e3b',
    'text-selected': '#ffffff', 'text-normal': '#f8f8f2', 'text-secondary': '#bfbfbf', 'text-disabled': '#6272a4',
    'text-on-accent': '#282a36',
    'stats-added': '#50fa7b', 'stats-deleted': '#ff5555',
    red: '#ff5555', orange: '#ffb86c', yellow: '#f1fa8c', green: '#50fa7b', blue: '#bd93f9', link: '#8be9fd',
    'count-blue': '#8be9fd', 'checked-out-row': '#2f4a3a', 'checked-out': '#50fa7b', 'selection-bg': '#44475a',
    'conflict-ours': '#8be9fd', 'conflict-theirs': '#f1fa8c', 'conflict-base': '#ff79c6',
    'wip-input-bg': '#21222c', 'wip-input-border': '#44475a', 'wip-input-placeholder': '#6272a4',
  }, ['#8be9fd', '#bd93f9', '#ff79c6', '#50fa7b', '#ffb86c', '#ff5555', '#f1fa8c', '#6272f4', '#ff92df', '#69ff94']),
  'one-dark': theme('one-dark', 'One Dark', 'dark', 'one-dark-pro', {
    'app-bg0': '#282c34', 'panel-bg0': '#21252b', 'panel-bg1': '#2c313a', 'toolbar-bg0': '#21252b',
    'action-bar-bg': '#323842', 'tab-bar-bg': '#1e2227', 'file-bar-bg': '#2c313a',
    'text-selected': '#ffffff', 'text-normal': '#abb2bf', 'text-secondary': '#8b929e', 'text-disabled': '#5c6370',
    'text-on-accent': '#282c34',
    'stats-added': '#98c379', 'stats-deleted': '#e06c75',
    red: '#e06c75', orange: '#d19a66', yellow: '#e5c07b', green: '#98c379', blue: '#61afef', link: '#56b6c2',
    'count-blue': '#61afef', 'checked-out-row': '#354536', 'checked-out': '#98c379', 'selection-bg': '#3e4451',
    'conflict-ours': '#61afef', 'conflict-theirs': '#e5c07b', 'conflict-base': '#c678dd',
    'wip-input-bg': '#1d1f23', 'wip-input-border': '#3e4452', 'wip-input-placeholder': '#5c6370',
  }, ['#61afef', '#c678dd', '#e06c75', '#98c379', '#e5c07b', '#56b6c2', '#d19a66', '#be5046', '#528bff', '#7ec699']),
  'solarized-dark': theme('solarized-dark', 'Solarized Dark', 'dark', 'solarized-dark', {
    'app-bg0': '#002b36', 'panel-bg0': '#00212b', 'panel-bg1': '#073642', 'toolbar-bg0': '#00212b',
    'action-bar-bg': '#073642', 'tab-bar-bg': '#00212b', 'file-bar-bg': '#04313d',
    'text-selected': '#fdf6e3', 'text-normal': '#93a1a1', 'text-secondary': '#839496', 'text-disabled': '#586e75',
    'text-on-accent': '#ffffff',
    'stats-added': '#859900', 'stats-deleted': '#dc322f',
    red: '#dc322f', orange: '#cb4b16', yellow: '#b58900', green: '#859900', blue: '#268bd2', link: '#2aa198',
    'count-blue': '#268bd2', 'checked-out-row': '#20402a', 'checked-out': '#5f7000', 'selection-bg': '#274642',
    'conflict-ours': '#268bd2', 'conflict-theirs': '#b58900', 'conflict-base': '#d33682',
    'wip-input-bg': '#00212b', 'wip-input-border': '#0d4150', 'wip-input-placeholder': '#586e75',
  }, ['#268bd2', '#2aa198', '#859900', '#b58900', '#cb4b16', '#dc322f', '#d33682', '#6c71c4', '#5fa8e0', '#56c2b6'], {
    'stats-deleted-bright': '#e8605d',
  }),
  'solarized-light': theme('solarized-light', 'Solarized Light', 'light', 'solarized-light', {
    'app-bg0': '#fdf6e3', 'panel-bg0': '#eee8d5', 'panel-bg1': '#f5efdc', 'toolbar-bg0': '#eee8d5',
    'action-bar-bg': '#e6dfca', 'tab-bar-bg': '#ddd6c1', 'file-bar-bg': '#f3ecd8',
    'text-selected': '#002b36', 'text-normal': '#073642', 'text-secondary': '#586e75', 'text-disabled': '#93a1a1',
    'text-on-accent': '#ffffff',
    'stats-added': '#859900', 'stats-deleted': '#dc322f',
    red: '#dc322f', orange: '#cb4b16', yellow: '#b58900', green: '#859900', blue: '#268bd2', link: '#1f72ad',
    'count-blue': '#1f72ad', 'checked-out-row': '#dfe3bf', 'checked-out': '#6b7a00', 'selection-bg': '#d3cbb7',
    'conflict-ours': '#1f72ad', 'conflict-theirs': '#8c6a00', 'conflict-base': '#b52d6f',
    'wip-input-bg': '#fffbf0', 'wip-input-border': '#d3cbb7', 'wip-input-placeholder': '#839496',
  }, ['#1f72ad', '#1f7f78', '#667500', '#8c6a00', '#b0410f', '#c4282a', '#b52d6f', '#5a5fb0', '#2f5f8a', '#2e8a7a'], {
    'stats-added-bright': '#5a6800', 'stats-deleted-bright': '#b8221f', 'status-added': '#6b7a00',
  }),
  'github-dark': theme('github-dark', 'GitHub Dark', 'dark', 'github-dark-default', {
    'app-bg0': '#0d1117', 'panel-bg0': '#161b22', 'panel-bg1': '#21262d', 'toolbar-bg0': '#010409',
    'action-bar-bg': '#21262d', 'tab-bar-bg': '#010409', 'file-bar-bg': '#161b22',
    'text-selected': '#ffffff', 'text-normal': '#e6edf3', 'text-secondary': '#8d96a0', 'text-disabled': '#6e7681',
    'text-on-accent': '#ffffff',
    'stats-added': '#2ea043', 'stats-deleted': '#da3633',
    red: '#f85149', orange: '#db6d28', yellow: '#d29922', green: '#3fb950', blue: '#2f81f7', link: '#58a6ff',
    'count-blue': '#58a6ff', 'checked-out-row': '#1a3a26', 'checked-out': '#238636', 'selection-bg': '#264f78',
    'conflict-ours': '#58a6ff', 'conflict-theirs': '#d29922', 'conflict-base': '#bc8cff',
    'wip-input-bg': '#010409', 'wip-input-border': '#30363d', 'wip-input-placeholder': '#6e7681',
  }, ['#58a6ff', '#bc8cff', '#3fb950', '#db6d28', '#f85149', '#d29922', '#39c5cf', '#f778ba', '#a5d6ff', '#7ee787'], {
    'section-border': 'rgba(240, 246, 252, 0.1)',
  }),
  nord: theme('nord', 'Nord', 'dark', 'nord', {
    'app-bg0': '#2e3440', 'panel-bg0': '#3b4252', 'panel-bg1': '#434c5e', 'toolbar-bg0': '#3b4252',
    'action-bar-bg': '#434c5e', 'tab-bar-bg': '#272c36', 'file-bar-bg': '#353b48',
    'text-selected': '#eceff4', 'text-normal': '#d8dee9', 'text-secondary': '#aab2c0', 'text-disabled': '#6b7486',
    'text-on-accent': '#2e3440',
    'stats-added': '#a3be8c', 'stats-deleted': '#bf616a',
    red: '#bf616a', orange: '#d08770', yellow: '#ebcb8b', green: '#a3be8c', blue: '#88c0d0', link: '#88c0d0',
    'count-blue': '#88c0d0', 'checked-out-row': '#3e4c43', 'checked-out': '#a3be8c', 'selection-bg': '#4c566a',
    'conflict-ours': '#88c0d0', 'conflict-theirs': '#ebcb8b', 'conflict-base': '#b48ead',
    'wip-input-bg': '#272c36', 'wip-input-border': '#434c5e', 'wip-input-placeholder': '#6b7486',
  }, ['#88c0d0', '#81a1c1', '#5e81ac', '#8fbcbb', '#a3be8c', '#ebcb8b', '#d08770', '#bf616a', '#b48ead', '#eceff4'], {
    'stats-deleted-bright': '#e5a0a6', 'status-deleted': '#d8848c',
  }),
};
