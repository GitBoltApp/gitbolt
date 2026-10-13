import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { GOLDEN } from '../testing';
import type { Manifest } from './repos';
import { COMPACT_WIDTHS, DEFAULT_SETTINGS, DEMO_SETTINGS, defaultProfile, initialState } from './state';

const golden = JSON.parse(readFileSync(`${GOLDEN}/defaults.json`, 'utf8')) as { settings: Record<string, unknown>; profile: Record<string, unknown> };

test("the defaults are the core's (but for what TypeScript never sees)", () => {
  const settings = { ...golden.settings };
  delete settings.window;
  expect(DEFAULT_SETTINGS).toEqual(settings);
  const profile = { ...golden.profile };
  delete profile.forgeAccounts;
  expect(defaultProfile()).toEqual(profile);
});

const manifest: Manifest = {
  version: 1,
  repos: [
    { name: 'basic', file: 'basic.gbdemo', group: 'Playground', open: 'tab' },
    { name: 'orbital', file: 'orbital.gbdemo', group: null, open: 'active' },
    { name: 'hidden', file: 'hidden.gbdemo', group: null, open: null },
    { name: 'long_history', file: 'long_history.gbdemo', group: 'Playground', open: 'tab' },
  ],
  groups: [{ name: 'Playground', color: 'blue', collapsed: true }, { name: 'Empty', color: 'red', collapsed: false }],
};

test('opens a tab per open repo, grouped ones side by side, the active one active', () => {
  const s = initialState(manifest, 1600);
  expect(s.profile.tabs).toEqual([
    { id: 'demo-basic', kind: 'repo', path: '/demo/basic', alias: null, worktree: null },
    { id: 'demo-long_history', kind: 'repo', path: '/demo/long_history', alias: null, worktree: null },
    { id: 'demo-orbital', kind: 'repo', path: '/demo/orbital', alias: null, worktree: null },
  ]);
  expect(s.profile.activeTab).toBe('demo-orbital');
  expect(s.profile.tabGroups).toEqual([{ id: 'demo-group-1', name: 'Playground', color: 'blue', collapsed: true, tabs: ['demo-basic', 'demo-long_history'] }]);
  expect(s.profile.reposFolders).toEqual(['/demo']);
  expect(s.settings).toEqual({ ...DEFAULT_SETTINGS, ...DEMO_SETTINGS });
  expect([s.settings.fetchIntervalSecs, s.settings.gravatar, s.settings.forgeAvatars, s.settings.updateCheck]).toEqual([0, false, false, false]);
  expect(s.profiles).toEqual([{ id: 'default', name: 'Default', color: '#4d88ff' }]);
  expect([s.profile.sidebarWidth, s.profile.rightPanelWidth]).toEqual([240, null]);
});

test('a frame under 1,280 px starts with a narrower sidebar and details panel', () => {
  const s = initialState(manifest, 1000);
  expect([s.profile.sidebarWidth, s.profile.rightPanelWidth]).toEqual([COMPACT_WIDTHS.sidebarWidth, COMPACT_WIDTHS.rightPanelWidth]);
  expect(initialState(manifest, 1280).profile.sidebarWidth).toBe(240);
});
