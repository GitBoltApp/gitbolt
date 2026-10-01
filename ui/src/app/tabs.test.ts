import { describe, expect, it } from 'vitest';
import type { Profile } from '../api/gen/Profile';
import { EMPTY_PROFILE } from './state';
import { closeOthers, closeTab, closeToRight, cycleTab, MAX_CLOSED, MAX_RECENT, moveTab, openBlankTab, openRepoTab, renameTab, reopenClosed, setTabRepo, touchRecent } from './tabs';

const withTabs = (...paths: string[]): Profile => {
  let p: Profile = { ...EMPTY_PROFILE, id: 'default' };
  paths.forEach((path, i) => { p = openRepoTab(p, path, `t${i}`).profile; });
  return p;
};
const paths = (p: Profile) => p.tabs.map((t) => t.path ?? '(open)');

describe('tab model', () => {
  it('opens after the active tab and focuses an existing tab for the same repo', () => {
    let p = withTabs('/a', '/b');
    p = { ...p, activeTab: 't0' };
    const r = openRepoTab(p, '/c', 'tc');
    expect(paths(r.profile)).toEqual(['/a', '/c', '/b']);
    expect(r.profile.activeTab).toBe('tc');
    const again = openRepoTab(r.profile, '/a', 'nope');
    expect(again.tabId).toBe('t0');
    expect(again.profile.tabs).toHaveLength(3);
  });

  it('closing the active tab activates its right neighbour and remembers it', () => {
    let p: Profile = { ...withTabs('/a', '/b', '/c'), activeTab: 't1' };
    p = closeTab(p, 't1');
    expect(paths(p)).toEqual(['/a', '/c']);
    expect(p.activeTab).toBe('t2');
    expect(p.closedTabs.at(-1)).toEqual({ path: '/b', alias: null, index: 1 });
    p = closeTab(p, 't2');
    expect(p.activeTab).toBe('t0');
  });

  it('reopens the last closed tab at its old position with its alias', () => {
    let p = renameTab(withTabs('/a', '/b', '/c'), 't1', '  Backend  ');
    expect(p.tabs[1].alias).toBe('Backend');
    p = closeTab(p, 't1');
    const r = reopenClosed(p, 'new')!;
    expect(paths(r.profile)).toEqual(['/a', '/b', '/c']);
    expect(r.profile.tabs[1]).toMatchObject({ id: 'new', alias: 'Backend' });
    expect(r.profile.closedTabs).toHaveLength(0);
    expect(reopenClosed(r.profile)).toBeNull();
  });

  it('caps the closed stack at 20, keeping the newest', () => {
    let p = withTabs(...Array.from({ length: 25 }, (_, i) => `/r${i}`));
    for (let i = 0; i < 25; i++) p = closeTab(p, `t${i}`);
    expect(p.closedTabs).toHaveLength(MAX_CLOSED);
    expect(p.closedTabs.at(-1)!.path).toBe('/r24');
  });

  it('close others and close to the right', () => {
    const p = { ...withTabs('/a', '/b', '/c', '/d'), activeTab: 't3' };
    const others = closeOthers(p, 't1');
    expect(paths(others)).toEqual(['/b']);
    expect(others.activeTab).toBe('t1');
    const right = closeToRight(p, 't1');
    expect(paths(right)).toEqual(['/a', '/b']);
    expect(right.activeTab).toBe('t1');
  });

  it('moves, renames, cycles', () => {
    let p = withTabs('/a', '/b', '/c');
    p = moveTab(p, 0, 2);
    expect(paths(p)).toEqual(['/b', '/c', '/a']);
    expect(renameTab(p, 't0', '   ').tabs.find((t) => t.id === 't0')!.alias).toBeNull();
    p = { ...p, activeTab: 't0' };
    expect(cycleTab(p, 1).activeTab).toBe('t1');
    expect(cycleTab(p, -1).activeTab).toBe('t2');
  });

  it('an Open tab becomes a repo tab, or collapses into an existing one', () => {
    let p = withTabs('/a');
    const blank = openBlankTab(p, 'o1');
    p = setTabRepo(blank.profile, 'o1', '/b');
    expect(p.tabs.find((t) => t.id === 'o1')).toMatchObject({ kind: 'repo', path: '/b' });
    const dup = setTabRepo(openBlankTab(p, 'o2').profile, 'o2', '/a');
    expect(dup.tabs.some((t) => t.id === 'o2')).toBe(false);
    expect(dup.activeTab).toBe('t0');
  });

  it('recent repos: newest first, pinned kept, deduplicated', () => {
    let p = withTabs();
    p = touchRecent(p, '/a', 'a', 1);
    p = touchRecent(p, '/b', 'b', 2);
    p = { ...p, recent: p.recent.map((r) => (r.path === '/a' ? { ...r, pinned: true } : r)) };
    p = touchRecent(p, '/a', 'a', 3);
    expect(p.recent.map((r) => r.path)).toEqual(['/a', '/b']);
    expect(p.recent[0]).toMatchObject({ pinned: true, openedAt: 3 });
  });
});

describe('tab model edges', () => {
  it('closing the last tab leaves no active tab; reopening restores it', () => {
    let p = closeTab(withTabs('/a'), 't0');
    expect(p.tabs).toHaveLength(0);
    expect(p.activeTab).toBeNull();
    p = reopenClosed(p, 'n')!.profile;
    expect(paths(p)).toEqual(['/a']);
    expect(p.activeTab).toBe('n');
  });

  it('keeps at most MAX_RECENT recents, every pinned one included', () => {
    let p = withTabs();
    p = touchRecent(p, '/pinned', 'pinned', 0);
    p = { ...p, recent: p.recent.map((r) => ({ ...r, pinned: true })) };
    for (let i = 0; i < MAX_RECENT + 5; i++) p = touchRecent(p, `/r${i}`, `r${i}`, i + 1);
    expect(p.recent).toHaveLength(MAX_RECENT);
    expect(p.recent.some((r) => r.path === '/pinned')).toBe(true);
    expect(p.recent[0].path).toBe(`/r${MAX_RECENT + 4}`);
  });
});
