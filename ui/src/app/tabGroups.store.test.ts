import { describe, expect, it, vi } from 'vitest';
import type { Profile } from '../api/gen/Profile';

const saved: Profile[] = [];
let stored: unknown = null;
vi.mock('../api/client', () => ({
  api: {
    saveProfile: vi.fn(async (p: Profile) => { saved.push(p); }),
    saveSettings: vi.fn(async () => null),
    loadState: vi.fn(async () => stored),
  },
}));

const { EMPTY_PROFILE, DEFAULT_SETTINGS, flushSaves, useAppState } = await import('./state');
const { closeTab } = await import('./tabs');

const tab = (id: string) => ({ id, kind: 'repo' as const, path: `/${id}`, alias: null, worktree: null });

describe('the app state keeps the groups in step with the tabs', () => {
  it('a tab closed by any path leaves its group, and the save carries the groups', async () => {
    useAppState.setState({ profile: { ...EMPTY_PROFILE, id: 'default', tabs: ['a', 'b'].map(tab), activeTab: 'a', tabGroups: [{ id: 'g', name: 'Web', color: 'blue', collapsed: true, tabs: ['a', 'b'] }] } });
    useAppState.getState().updateProfile((p) => closeTab(p, 'a'));
    expect(useAppState.getState().profile.tabGroups).toEqual([{ id: 'g', name: 'Web', color: 'blue', collapsed: true, tabs: ['b'] }]);
    await flushSaves();
    expect(saved.at(-1)?.tabGroups[0].tabs).toEqual(['b']);
  });

  it('an old profile (no groups in it) loads with none', async () => {
    const old: Record<string, unknown> = { ...EMPTY_PROFILE, id: 'default', tabs: [tab('a')], activeTab: 'a' };
    delete old.tabGroups;
    delete old.savedGroups;
    stored = { settings: DEFAULT_SETTINGS, profile: old, profiles: [] };
    await useAppState.getState().load();
    expect(useAppState.getState().profile.tabGroups).toEqual([]);
    expect(useAppState.getState().profile.savedGroups).toEqual([]);
  });
});
