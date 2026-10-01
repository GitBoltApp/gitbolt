import { create } from 'zustand';
import { applyTheme, resolveColors, type ResolvedColors } from './apply';
import { DEFAULT_THEME_ID, isThemeId, THEMES, type ThemeId } from './themes';

/** Lane overrides per theme: lane index → `#rrggbb`, or null for the theme's own (AppSettings.graphColorOverrides). */
export type GraphOverrides = Partial<Record<ThemeId, (string | null)[]>>;

interface ThemeState {
  id: ThemeId;
  overrides: GraphOverrides;
  /** Bumped on every applied change. Canvas consumers depend on `colors`, which changes with it. */
  version: number;
  colors: ResolvedColors;
  set(id: ThemeId, overrides: GraphOverrides): void;
}

/**
 * The applied theme: `set` writes it onto <html> (the DOM follows through the custom
 * properties) and publishes the resolved canvas colours, which the graph canvas, the ref chips
 * and the avatars read, so a switch repaints them without a reload. `bind.ts` drives it from the
 * settings; nothing else should call `set` but tests.
 */
export const useTheme = create<ThemeState>((set, get) => ({
  id: DEFAULT_THEME_ID,
  overrides: {},
  version: 0,
  colors: resolveColors(THEMES[DEFAULT_THEME_ID]),
  set(id, overrides) {
    const def = THEMES[isThemeId(id) ? id : DEFAULT_THEME_ID];
    const colors = resolveColors(def, overrides[def.id]);
    applyTheme(document.documentElement, def, colors);
    set({ id: def.id, overrides, colors, version: get().version + 1 });
  },
}));
