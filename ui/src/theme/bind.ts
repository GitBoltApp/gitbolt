import { useAppState } from '../app/state';
import { readThemeMirror, writeThemeMirror } from './apply';
import { useTheme, type GraphOverrides } from './store';
import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from './themes';

/**
 * Keeps the applied theme in step with the saved settings (`AppSettings.theme` and
 * `graphColorOverrides`). Call once, before the first render:
 *
 * - First paint: the localStorage mirror of the last saved theme (ruling R3), so a light-theme
 *   user never sees Default Dark while the settings load. Until they have loaded, the store's
 *   placeholder `DEFAULT_SETTINGS` is ignored.
 * - Then every settings change that affects the shown theme (its id, or its own lane overrides;
 *   anything else is skipped, so canvases don't redraw for an unrelated setting), mirrored for
 *   the next start.
 * - `?theme=<id>` overrides the saved theme for this page load only (the screenshot tests use
 *   it); it's never saved or mirrored.
 */
export function bindThemeToSettings(): () => void {
  const fromUrl = new URLSearchParams(location.search).get('theme');
  const forced: ThemeId | null = isThemeId(fromUrl) ? fromUrl : null;
  let lastKey = '';
  const apply = (id: ThemeId, overrides: GraphOverrides) => {
    const key = `${id}|${JSON.stringify(overrides[id] ?? null)}`;
    if (key === lastKey) return false;
    lastKey = key;
    useTheme.getState().set(id, overrides);
    return true;
  };

  const mirror = readThemeMirror();
  if (forced) apply(forced, {});
  else if (mirror) apply(mirror.id, mirror.graph ? { [mirror.id]: mirror.graph } : {});
  else apply(DEFAULT_THEME_ID, {});

  const sync = ({ loaded, settings }: { loaded: boolean; settings: { theme: string; graphColorOverrides?: Record<string, (string | null)[]> } }) => {
    if (!loaded) return;
    const saved: ThemeId = isThemeId(settings.theme) ? settings.theme : DEFAULT_THEME_ID;
    const overrides = (settings.graphColorOverrides ?? {}) as GraphOverrides;
    if (apply(forced ?? saved, overrides) && !forced) writeThemeMirror(saved, overrides[saved]);
  };
  sync(useAppState.getState());
  return useAppState.subscribe(sync);
}
