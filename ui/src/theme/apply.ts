import { contrastRatio } from './contrast';
import { COLOR_TOKENS, isThemeId, THEMES, type ThemeDef, type ThemeId } from './themes';

/** What the canvases draw with: the theme's node and shade colours and its lanes, the user's
 * overrides for this theme applied; and the initials colour for each lane (avatars). */
export interface ResolvedColors { nodeFill: string; nodeText: string; collapseStrip: string; graph: string[]; laneText: string[] }

const HEX = /^#[0-9a-f]{6}$/i;
export const isHexColor = (v: unknown): v is string => typeof v === 'string' && HEX.test(v);

/** The theme's canvas colors with the user's lane overrides for this theme applied (invalid entries ignored). */
export function resolveColors(def: ThemeDef, override?: readonly (string | null)[]): ResolvedColors {
  const graph = def.graph.map((c, i) => {
    const o = override?.[i];
    return isHexColor(o) ? o.toLowerCase() : c;
  });
  // White or the theme's dark ink, whichever reads better on the lane (a pastel lane takes dark).
  const ink = def.kind === 'dark' ? def.colors['app-bg0'] : def.colors['text-selected'];
  const laneText = graph.map((c) => def.laneText ?? (contrastRatio('#ffffff', c) >= contrastRatio(ink, c) ? '#ffffff' : ink));
  return { nodeFill: def.colors['node-fill'], nodeText: def.colors['node-text'], collapseStrip: def.colors['collapse-strip'], graph, laneText };
}

/** Writes the theme onto `root` as inline custom properties (which win over tokens.css). */
export function applyTheme(root: HTMLElement, def: ThemeDef, colors: ResolvedColors): void {
  for (const t of COLOR_TOKENS) root.style.setProperty(`--${t}`, def.colors[t]);
  colors.graph.forEach((c, i) => root.style.setProperty(`--graph-${i}`, c));
  root.style.colorScheme = def.kind;
  root.dataset.theme = def.id;
}

/**
 * The first-paint mirror (ruling R3): the saved theme and its own lane overrides, kept in
 * localStorage so they apply before the backend's settings arrive, the way zoom and density do
 * (1C R4). `AppSettings.theme` stays the source of truth; this only shadows it. It also carries
 * the theme's `kind` and `app-bg0` (`bg`) for index.html's inline script, which paints them
 * before any CSS or module script runs (no dark flash for a light theme, review I1).
 */
export const THEME_STORAGE_KEY = 'gitbolt.theme.v1';
export interface ThemeMirror { id: ThemeId; graph?: (string | null)[] }

export function readThemeMirror(): ThemeMirror | null {
  try {
    const v = JSON.parse(globalThis.localStorage.getItem(THEME_STORAGE_KEY) ?? 'null') as { id?: unknown; graph?: unknown } | null;
    if (!v || !isThemeId(v.id)) return null;
    return { id: v.id, graph: Array.isArray(v.graph) ? v.graph.map((c) => (isHexColor(c) ? c : null)) : undefined };
  } catch {
    return null;
  }
}

export function writeThemeMirror(id: ThemeId, graph: readonly (string | null)[] | undefined): void {
  try {
    const { kind, colors } = THEMES[id];
    globalThis.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ id, kind, bg: colors['app-bg0'], ...(graph && { graph }) }));
  } catch {
    // Blocked or full storage: the next start paints Default Dark until the settings load.
  }
}
