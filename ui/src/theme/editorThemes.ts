import type { ThemeRegistration } from 'shiki';
import { bundledThemes } from 'shiki/themes';
import { editorColors, withEditorColors } from '../diff/monaco/theme';
import { darcula } from './darcula';
import { useTheme } from './store';
import { THEME_IDS, THEMES } from './themes';

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
      def.editorTheme === darcula.name ? darcula : (await bundledThemes[def.editorTheme as keyof typeof bundledThemes]()).default;
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
