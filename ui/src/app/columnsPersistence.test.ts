import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({ api: { saveProfile: vi.fn(async () => null), saveSettings: vi.fn(async () => null) } }));

const { columnPrefsPersistence, useColumnPrefs } = await import('../graph/columns');
const { installColumnPersistence } = await import('./columnsPersistence');
const { EMPTY_PROFILE, EMPTY_REPO_SETTINGS, useAppState } = await import('./state');

describe('column persistence (spec §8.4)', () => {
  beforeEach(() => {
    installColumnPersistence();
    useColumnPrefs.getState().reset();
    useAppState.setState({ profile: { ...EMPTY_PROFILE, id: 'default' } });
  });

  it('saves every width, SHA included, per repo, and loads them back', () => {
    const cp = useColumnPrefs.getState();
    cp.loadFor('/r');
    cp.setWidth('sha', 120);
    cp.setWidth('author', 90);
    // What `endResize` calls once a gesture changed something.
    const { prefs } = useColumnPrefs.getState();
    columnPrefsPersistence.save('/r', prefs);
    expect(useAppState.getState().profile.repos['/r'].columns).toEqual({ labels: prefs.labels, graph: null, author: 90, date: prefs.date, sha: 120 });
    useColumnPrefs.getState().reset();
    useColumnPrefs.getState().loadFor('/r');
    expect(useColumnPrefs.getState().prefs).toMatchObject({ author: 90, sha: 120 });
  });

  it('keeps the hidden columns per repo', () => {
    useColumnPrefs.getState().loadFor('/r');
    useColumnPrefs.getState().toggleHidden('sha');
    useColumnPrefs.getState().toggleHidden('author');
    expect(useAppState.getState().profile.repos['/r'].hiddenColumns).toEqual(['author', 'sha']);
    useColumnPrefs.getState().reset();
    useColumnPrefs.getState().loadFor('/r');
    expect([...useColumnPrefs.getState().hidden].sort()).toEqual(['author', 'sha']);
  });

  it('a profile switch reloads the widths from the new profile', () => {
    useAppState.setState({ profile: { ...EMPTY_PROFILE, id: 'a', repos: { '/r': { ...EMPTY_REPO_SETTINGS, columns: { labels: 100, graph: null, author: 70, date: 100, sha: 80 } } } } });
    useColumnPrefs.getState().loadFor('/r');
    expect(useColumnPrefs.getState().prefs.author).toBe(70);
    useAppState.setState({ profile: { ...EMPTY_PROFILE, id: 'b', repos: { '/r': { ...EMPTY_REPO_SETTINGS, columns: { labels: 100, graph: null, author: 95, date: 100, sha: 80 } } } } });
    useColumnPrefs.getState().loadFor('/r');
    expect(useColumnPrefs.getState().prefs.author).toBe(95);
  });
});
