// The demo's settings and profile, in memory (spec decision 3: they reset with the page): a fresh
// install's (the core's AppSettings::default and first profile; state.test.ts checks them against
// golden/defaults.json), with what the demo changes, and the manifest's repos open as tabs.
import type { AppSettings } from '../../api/gen/AppSettings';
import type { Profile } from '../../api/gen/Profile';
import type { ProfileMeta } from '../../api/gen/ProfileMeta';
import type { TabGroup } from '../../api/gen/TabGroup';
import type { TabState } from '../../api/gen/TabState';
import { demoRoot } from './paths';
import type { Manifest, ManifestRepo } from './repos';

export const DEFAULT_SETTINGS: AppSettings = {
  version: 2,
  activeProfile: 'default',
  theme: 'default-dark',
  editorFontSize: 13,
  fetchIntervalSecs: 60,
  prune: true,
  commitLimit: 2000,
  dateFormat: 'ymd12h',
  gravatar: true,
  debugLogging: false,
  syncButton: 'fetchAll',
  pushFollowTags: true,
  forgeAvatars: true,
  updateCheck: true,
  updatePrereleases: false,
  updateArchMethod: null,
  graphColorOverrides: {},
};

export function defaultProfile(): Profile {
  return {
    version: 1, id: 'default', name: 'Default', color: '#4d88ff', tabs: [], activeTab: null, tabGroups: [], savedGroups: [], closedTabs: [], recent: [],
    reposFolder: null, reposFolders: null, editor: null, extraGitconfig: null, hostOverrides: {}, sidebarWidth: 240, sidebarNarrow: false, sidebarPanels: {},
    rightPanelWidth: null, flyoutWidth: null, repos: {},
  };
}

/** No background fetch, and nothing that would reach another origin (avatars, the update check). */
export const DEMO_SETTINGS = { fetchIntervalSecs: 0, gravatar: false, forgeAvatars: false, updateCheck: false } satisfies Partial<AppSettings>;

/** Under this frame width the demo starts narrower, so the graph keeps its room down to 960 px. */
export const COMPACT_BELOW = 1280;
/** Above the sidebar's minimum (160, Sidebar.tsx) and the details panel's (280, RepoView.tsx). */
export const COMPACT_WIDTHS = { sidebarWidth: 190, rightPanelWidth: 300 } as const;

export interface DemoState {
  settings: AppSettings;
  profile: Profile;
  profiles: ProfileMeta[];
  /** The repos `watchRepo` asked for: the ones a write's events refresh. */
  watched: Set<number>;
}

const tabId = (name: string) => `demo-${name}`;

/** `width`: the demo frame's, at load. */
export function initialState(manifest: Manifest, width: number): DemoState {
  const open = manifest.repos.filter((r) => r.open !== null);
  // A group's tabs stay side by side, where its first one is.
  const ordered: ManifestRepo[] = [];
  for (const r of open) {
    if (ordered.includes(r)) continue;
    ordered.push(...(r.group === null ? [r] : open.filter((x) => x.group === r.group)));
  }
  const tabs: TabState[] = ordered.map((r) => ({ id: tabId(r.name), kind: 'repo', path: demoRoot(r.name, 'repo'), alias: null, worktree: null }));
  const active = ordered.find((r) => r.open === 'active') ?? ordered[0];
  const tabGroups: TabGroup[] = manifest.groups
    .map((g, i) => ({ id: `demo-group-${i + 1}`, name: g.name, color: g.color, collapsed: g.collapsed, tabs: ordered.filter((r) => r.group === g.name).map((r) => tabId(r.name)) }))
    .filter((g) => g.tabs.length > 0);
  const base = defaultProfile();
  const profile: Profile = { ...base, tabs, activeTab: active ? tabId(active.name) : null, tabGroups, reposFolders: ['/demo'], ...(width < COMPACT_BELOW ? COMPACT_WIDTHS : {}) };
  return { settings: { ...DEFAULT_SETTINGS, ...DEMO_SETTINGS }, profile, profiles: [{ id: base.id, name: base.name, color: base.color }], watched: new Set() };
}
