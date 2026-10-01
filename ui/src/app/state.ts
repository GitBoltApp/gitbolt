import { create } from 'zustand';
import { api } from '../api/client';
import type { AppSettings } from '../api/gen/AppSettings';
import type { Profile } from '../api/gen/Profile';
import type { ProfileMeta } from '../api/gen/ProfileMeta';
import type { RepoSettings } from '../api/gen/RepoSettings';
import type { StatePayload } from '../api/gen/StatePayload';
import { debounce } from '../util/debounce';

/**
 * Mirrors `AppSettings::default()` (Rust); replaced by the backend's copy on load. View
 * preferences (zoom, density, diff mode, whitespace, word wrap) aren't here: they stay in
 * localStorage behind 1B's seams, so they apply before the first paint (ruling R4).
 */
export const DEFAULT_SETTINGS: AppSettings = {
  version: 1, activeProfile: 'default', theme: 'default-dark', editorFontSize: 13,
  fetchIntervalSecs: 60, prune: true, commitLimit: 2000, dateFormat: 'ymd12h', gravatar: true,
};
/** Mirrors `Profile::default()` (Rust). */
export const EMPTY_PROFILE: Profile = {
  version: 1, id: '', name: '', color: '#4d88ff', tabs: [], activeTab: null, closedTabs: [], recent: [], reposFolder: null, reposFolders: null,
  editor: null, extraGitconfig: null, hostOverrides: {}, sidebarWidth: 240, sidebarNarrow: false, sidebarPanels: {}, rightPanelWidth: null, repos: {},
};
export const EMPTY_REPO_SETTINGS: RepoSettings = { pin: null, columns: null, hiddenColumns: [], sidebarSort: {}, collapsed: [], editor: null };

// UI → backend saves are debounced here too (the backend debounces disk writes on top).
const saveSettings = debounce((s: AppSettings) => api.saveSettings(s), 150);
const saveProfile = debounce((p: Profile) => api.saveProfile(p), 150);

/** Sends any pending settings and profile save now (before a profile switch, on page hide). */
export async function flushSaves(): Promise<void> {
  await Promise.all([saveSettings.flush(), saveProfile.flush()]);
}

interface AppState {
  loaded: boolean;
  /** Set once the launch repos are open: the automatic Open tab waits for it, so a `?repo=` launch doesn't also open one. */
  booted: boolean;
  setBooted(): void;
  settings: AppSettings;
  profile: Profile;
  profiles: ProfileMeta[];
  load(): Promise<void>;
  setSettings(patch: Partial<AppSettings>): void;
  setProfile(profile: Profile): void;
  updateProfile(fn: (p: Profile) => Profile): void;
  updateRepo(path: string, fn: (r: RepoSettings) => RepoSettings): void;
  createProfile(name: string, color: string): Promise<void>;
  switchProfile(id: string): Promise<void>;
  deleteProfile(id: string): Promise<void>;
  renameProfile(name: string, color: string): void;
}

const fromState = (st: StatePayload) => ({ settings: st.settings, profile: st.profile, profiles: st.profiles });

/** App settings and the active profile (spec §14.1), backed by the core's store. */
export const useAppState = create<AppState>((set, get) => ({
  loaded: false,
  booted: false,
  setBooted() {
    set({ booted: true });
  },
  settings: DEFAULT_SETTINGS,
  profile: EMPTY_PROFILE,
  profiles: [],
  async load() {
    set({ ...fromState(await api.loadState()), loaded: true });
  },
  setSettings(patch) {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    saveSettings(settings);
  },
  setProfile(profile) {
    if (profile === get().profile) return;
    set({ profile });
    saveProfile(profile);
  },
  updateProfile(fn) {
    get().setProfile(fn(get().profile));
  },
  updateRepo(path, fn) {
    get().updateProfile((p) => ({ ...p, repos: { ...p.repos, [path]: fn(p.repos[path] ?? EMPTY_REPO_SETTINGS) } }));
  },
  async createProfile(name, color) {
    await flushSaves();
    const meta = await api.createProfile(name, color);
    set({ profiles: [...get().profiles, meta] });
    await get().switchProfile(meta.id);
  },
  async switchProfile(id) {
    await flushSaves();
    set(fromState(await api.switchProfile(id)));
  },
  async deleteProfile(id) {
    set({ profiles: await api.deleteProfile(id) });
  },
  renameProfile(name, color) {
    const id = get().profile.id;
    get().updateProfile((p) => ({ ...p, name, color }));
    set({ profiles: get().profiles.map((m) => (m.id === id ? { ...m, name, color } : m)) });
  },
}));
