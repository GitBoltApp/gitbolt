import { create } from 'zustand';
import { STICKY_SCROLL_NOTE } from '../diff/editorSettings';

export type SettingsSection = 'General' | 'Fetch' | 'Editor' | 'Profile' | 'Hosts' | 'Repository';
export interface SettingDef {
  id: string;
  label: string;
  section: SettingsSection;
  keywords: string;
  /** The instant tooltip on the setting's label. */
  help?: string;
}

/** Settings 1C renders (1B/1D append theirs); the palette's `#` group searches these. */
export const SETTINGS: readonly SettingDef[] = [
  { id: 'reposFolder', label: 'Default repos folder', section: 'General', keywords: 'clone destination scan your repos', help: 'Where Open Repository looks for your repositories, and the default destination for a clone.' },
  { id: 'dateFormat', label: 'Date format', section: 'General', keywords: 'time 24h 12h graph column', help: 'How commit dates read in the graph, the details panel, compare and find.' },
  { id: 'commitLimit', label: 'Commits loaded in the graph', section: 'General', keywords: 'window history limit', help: 'How many commits the graph loads, newest first. More is slower on a big history.' },
  { id: 'density', label: 'Density', section: 'General', keywords: 'compact standard comfortable row height spacing padding', help: 'Row height and padding of the graph and the file list.' },
  { id: 'gravatar', label: 'Load avatars from Gravatar', section: 'General', keywords: 'avatar privacy images', help: 'Looks authors up on Gravatar by a hash of their email (never the email itself). Off shows initials and makes no request.' },
  { id: 'fetchInterval', label: 'Background fetch interval', section: 'Fetch', keywords: 'auto fetch timer minutes off', help: 'Fetches the shown repository on this schedule. Off turns background fetch off.' },
  { id: 'prune', label: 'Prune deleted remote branches on fetch', section: 'Fetch', keywords: 'prune --prune remote tracking', help: 'Fetch with --prune: remote-tracking branches the remote deleted are removed.' },
  { id: 'editor', label: 'Default editor', section: 'Editor', keywords: 'vscode phpstorm jetbrains zed sublime open in custom command template', help: 'What Open in uses by default. Custom runs your own command; {file}, {line} and {repo} are filled in per open.' },
  { id: 'stickyScroll', label: 'Sticky scroll in the diff viewer', section: 'Editor', keywords: 'monaco pin scope header', help: STICKY_SCROLL_NOTE },
  { id: 'extraGitconfig', label: 'Extra git config for this profile', section: 'Profile', keywords: 'include.path identity account signing', help: 'A gitconfig file added to every git command of this profile as -c include.path=… (your identity, signing key).' },
  { id: 'hostOverrides', label: 'Forge type per host', section: 'Hosts', keywords: 'gitlab github self-hosted icon links', help: 'Tells GitBolt which forge a self-hosted host runs, for its remote icons and web links.' },
  { id: 'repoEditor', label: 'Editor for this repository', section: 'Repository', keywords: 'override open in', help: "Overrides the profile's default editor for this repository only." },
];

/** The fetch interval the scheduler runs: 0 (or less, or not a number) is off; anything else is
 * between a minute and a day, so a hand-edited settings file can't make it hammer a remote. */
export function clampFetchInterval(secs: number): number {
  if (!(secs > 0)) return 0;
  return Math.min(86_400, Math.max(60, Math.round(secs)));
}

interface SettingsUi {
  open: boolean;
  focus: string | null;
  /** The tab shown: kept for the session (the dialog remounts on each open), set by a deep link. */
  section: SettingsSection;
  show(focus?: string): void;
  setSection(s: SettingsSection): void;
  close(): void;
}

export const useSettingsUi = create<SettingsUi>((set) => ({
  open: false,
  focus: null,
  section: 'General',
  show: (focus) => set((st) => ({ open: true, focus: focus ?? null, section: SETTINGS.find((d) => d.id === focus)?.section ?? st.section })),
  setSection: (section) => set({ section }),
  close: () => set({ open: false, focus: null }),
}));
