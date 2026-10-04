import { create } from 'zustand';
import { STICKY_SCROLL_NOTE } from '../diff/editorSettings';

export type SettingsSection = 'General' | 'Appearance' | 'Fetch' | 'Editor' | 'Profile' | 'Accounts' | 'Hosts' | 'Advanced' | 'Repository';
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
  { id: 'reposFolder', label: 'Default repos directory', section: 'General', keywords: 'clone destination scan your repos folder', help: 'Where Open Repository looks for your repositories, and the default destination for a clone.' },
  { id: 'dateFormat', label: 'Date format', section: 'General', keywords: 'time 24h 12h graph column', help: 'How commit dates read in the graph, the details panel, compare and find.' },
  { id: 'commitLimit', label: 'Commits loaded in the graph', section: 'General', keywords: 'window history limit', help: 'How many commits the graph loads, newest first. More is slower on a big history.' },
  { id: 'density', label: 'Density', section: 'General', keywords: 'compact standard comfortable row height spacing padding', help: 'Row height and padding of the graph and the file list.' },
  { id: 'gravatar', label: 'Load avatars from Gravatar', section: 'General', keywords: 'avatar privacy images', help: 'Looks authors up on Gravatar by a hash of their email (never the email itself). Off shows initials and makes no request.' },
  // --- 4A T11 ---
  { id: 'forgeAvatars', label: 'Load avatars from your forge accounts', section: 'General', keywords: 'avatar gitlab github forge privacy images', help: 'Looks authors up on the forges you have accounts on (GitLab by email; GitHub from its own data), before Gravatar. Off makes no request to them.' },
  // --- end 4A T11 ---
  { id: 'theme', label: 'Theme', section: 'Appearance', keywords: 'colour color scheme dark light default monokai darcula dracula one dark solarized github nord', help: 'The colours of the app and the commit graph.' },
  { id: 'graphColors', label: 'Graph lane colors', section: 'Appearance', keywords: 'colour branch lane graph palette override', help: "The commit graph's ten lane colours, for the current theme only. Clear a box to use the theme's own colour." },
  { id: 'fetchInterval', label: 'Background fetch interval', section: 'Fetch', keywords: 'auto fetch timer minutes off', help: 'Fetches the shown repository on this schedule. Off turns background fetch off.' },
  { id: 'prune', label: 'Prune deleted remote branches on fetch', section: 'Fetch', keywords: 'prune --prune remote tracking', help: 'Fetch with --prune: remote-tracking branches the remote deleted are removed.' },
  { id: 'pushFollowTags', label: 'Push tags with branches', section: 'Fetch', keywords: 'push follow-tags annotated tags release', help: 'Push with --follow-tags: pushing a branch also sends the annotated tags on its commits that the remote lacks.' },
  { id: 'editor', label: 'Default editor', section: 'Editor', keywords: 'vscode phpstorm jetbrains zed sublime open in custom command template', help: 'What Open in uses by default. Custom runs your own command; {file}, {line} and {repo} are filled in per open.' },
  { id: 'stickyScroll', label: 'Sticky scroll in the diff viewer', section: 'Editor', keywords: 'monaco pin scope header', help: STICKY_SCROLL_NOTE },
  { id: 'editorFontSize', label: 'Editor font size', section: 'Editor', keywords: 'monaco diff text size px zoom', help: 'The text size in the diff viewer and file view, 8 to 32 px. Separate from the zoom in the status bar.' },
  { id: 'extraGitconfig', label: 'Extra git config for this profile', section: 'Profile', keywords: 'include.path identity account signing', help: 'A gitconfig file added to every git command of this profile as -c include.path=… (your identity, signing key).' },
  // --- 4A T11 ---
  { id: 'forgeAccounts', label: 'Forge accounts', section: 'Accounts', keywords: 'gitlab github token personal access token pat account login keyring merge request pull request forks', help: "This profile's GitLab and GitHub accounts, one per host: GitBolt uses them for merge requests, pull requests, forks and avatars. Tokens are kept in the system keyring." },
  // --- end 4A T11 ---
  { id: 'hostOverrides', label: 'Forge type per host', section: 'Hosts', keywords: 'gitlab github self-hosted icon links', help: 'Tells GitBolt which forge a self-hosted host runs, for its remote icons and web links.' },
  { id: 'debugLogging', label: 'Debug logging', section: 'Advanced', keywords: 'log file verbose diagnostics troubleshooting', help: 'Writes more detail (debug level) to the log files. Takes effect immediately, no restart. Replaces a RUST_LOG set at launch.' },
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
