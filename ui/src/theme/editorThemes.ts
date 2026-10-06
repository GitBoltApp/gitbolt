import type { DynamicImportThemeRegistration, ThemeRegistration } from 'shiki';
import { editorColors, withEditorColors } from '../diff/monaco/theme';
import { darcula } from './darcula';
import { useTheme } from './store';
import { type SHIKI_BUNDLED_THEMES, THEME_IDS, THEMES } from './themes';

/** The Shiki themes the app themes use, each imported by name: Shiki's registry (shiki/themes)
 * would bundle every theme it ships, aurora-x (GPL-3.0) among them (docs/licensing.md). */
export const SHIKI_THEMES: Record<(typeof SHIKI_BUNDLED_THEMES)[number], DynamicImportThemeRegistration> = {
  'dark-plus': () => import('shiki/themes/dark-plus.mjs'),
  'light-plus': () => import('shiki/themes/light-plus.mjs'),
  monokai: () => import('shiki/themes/monokai.mjs'),
  dracula: () => import('shiki/themes/dracula.mjs'),
  'one-dark-pro': () => import('shiki/themes/one-dark-pro.mjs'),
  'solarized-dark': () => import('shiki/themes/solarized-dark.mjs'),
  'solarized-light': () => import('shiki/themes/solarized-light.mjs'),
  'github-dark-default': () => import('shiki/themes/github-dark-default.mjs'),
  nord: () => import('shiki/themes/nord.mjs'),
};

/**
 * Every theme's Shiki registration with its per-theme overlay (monaco/theme.ts) layered on, for
 * the highlighter's `themes` option. They all load up front because `shikiToMonaco` defines
 * Monaco themes only for themes already loaded when it runs, and wraps `monaco.editor.setTheme`
 * once: a theme loaded later would never reach Monaco.
 */
export function editorThemeRegistrations(): Promise<ThemeRegistration>[] {
  return THEME_IDS.map(async (id) => {
    const def = THEMES[id];
    const base: ThemeRegistration =
      def.editorTheme === darcula.name ? darcula : (await SHIKI_THEMES[def.editorTheme as keyof typeof SHIKI_THEMES]()).default;
    return { ...withEditorColors(base, editorColors(def)), name: def.editorTheme };
  });
}

export const currentEditorTheme = (): string => THEMES[useTheme.getState().id].editorTheme;

/** Calls `setTheme` now and whenever the app theme's editor theme changes. */
export function bindEditorTheme(setTheme: (name: string) => void): () => void {
  let last = '';
  const apply = () => {
    const name = currentEditorTheme();
    if (name === last) return;
    last = name;
    setTheme(name);
  };
  apply();
  return useTheme.subscribe(apply);
}
