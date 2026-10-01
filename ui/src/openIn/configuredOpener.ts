import type { Profile } from '../api/gen/Profile';

/**
 * The opener Settings chose for "Open in…" (ruling R5): the active repository's own editor
 * setting over the profile's. An opener's id, or `custom` for the Custom command; `null` when
 * nothing was chosen (the last used opener is the default then, spec §14.5).
 */
export function configuredOpenerId(profile: Pick<Profile, 'tabs' | 'activeTab' | 'repos' | 'editor'>): string | null {
  const path = profile.tabs.find((t) => t.id === profile.activeTab)?.path;
  const choice = (path ? profile.repos[path]?.editor : null) ?? profile.editor;
  if (!choice) return null;
  return choice.kind === 'custom' ? 'custom' : choice.id;
}
