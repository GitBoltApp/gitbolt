import { describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({
  api: { openIn: vi.fn(async () => null), saveProfile: vi.fn(async () => null), saveSettings: vi.fn(async () => null), appInfo: vi.fn(async () => ({ appVersion: 'x', gitVersion: 'y' })) },
  errorMessage: (e: unknown) => String(e),
}));
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}), inTauri: () => false }));

const { buildMenu } = await import('../menu/registry');
const { useAppState, EMPTY_PROFILE } = await import('../app/state');
await import('./tabMenu');
import type { MenuRow } from '../menu/types';

const labels = (rows: MenuRow[]) => rows.map((r) => (r.kind === 'separator' ? '---' : r.label));
const find = (rows: MenuRow[], label: string) => rows.find((r) => r.kind === 'action' && r.label === label) as Extract<MenuRow, { kind: 'action' }>;

describe('tab bar menu', () => {
  it('offers Reopen <name>, Open repository and Clone', () => {
    const rows = buildMenu('tabbar', null, { lastClosed: { path: '/x/proj/', alias: null }, savedGroups: [] });
    expect(labels(rows)).toEqual(['Reopen proj', '---', 'Open repository…', 'Clone repository…']);
    expect(find(rows, 'Reopen proj').shortcut).toBe('Ctrl+Shift+T');
    expect(find(rows, 'Open repository…').shortcut).toBe('Ctrl+O');
    expect(labels(buildMenu('tabbar', null, { lastClosed: { path: '/x/p', alias: 'Mine' } }))[0]).toBe('Reopen Mine');
  });

  it('disables Reopen with a reason when nothing was closed', () => {
    const rows = buildMenu('tabbar', null, { lastClosed: null });
    expect(find(rows, 'Reopen closed tab').disabledReason).toBe('No recently closed tabs');
  });
});

describe('tab menu', () => {
  it('has the spec §6.2 rows, each with an icon and a tooltip', () => {
    const rows = buildMenu('tab', { tab: { id: 'a', kind: 'repo', path: '/r', alias: null }, index: 0 }, { tabCount: 2, closedCount: 0 });
    expect(labels(rows)).toEqual(['Rename…', '---', 'Add to new group', '---', 'Close', 'Close others', 'Close to the right', '---', 'Reopen closed tab', '---', 'Copy repo path', 'Open in file manager']);
    for (const r of rows) if (r.kind !== 'separator') { expect(r.icon).toBeDefined(); expect(r.tooltip).toBeTruthy(); }
    expect(find(rows, 'Reopen closed tab').disabledReason).toBe('No recently closed tabs');
    expect(find(rows, 'Close').shortcut).toBe('Ctrl+W');
  });

  it('disables what does not apply and drops repo rows for Open tabs', () => {
    const rows = buildMenu('tab', { tab: { id: 'a', kind: 'open', path: null, alias: null }, index: 0 }, { tabCount: 1, closedCount: 3 });
    expect(find(rows, 'Close others').disabledReason).toBeTruthy();
    expect(find(rows, 'Close to the right').disabledReason).toBeTruthy();
    expect(labels(rows)).not.toContain('Copy repo path');
    expect(find(rows, 'Reopen closed tab').shortcut).toBe('Ctrl+Shift+T');
    expect(find(rows, 'Reopen closed tab').disabledReason).toBeUndefined();
  });
});

describe('tab groups in the menus', () => {
  const tab = (id: string) => ({ id, kind: 'repo' as const, path: `/${id}`, alias: null, worktree: null });
  const sub = (rows: MenuRow[], label: string) => rows.find((r) => r.kind === 'submenu' && r.label === label) as Extract<MenuRow, { kind: 'submenu' }>;
  const set = (p: Partial<typeof EMPTY_PROFILE>) => useAppState.setState({ profile: { ...EMPTY_PROFILE, id: 'default', tabs: ['a', 'b', 'c'].map(tab), activeTab: 'a', ...p } });
  const web = { id: 'g1', name: 'Web', color: 'pink', collapsed: false, tabs: ['b'] };

  it('a tab can go into a new group or an existing one, from the keyboard too; a grouped one can leave', () => {
    set({ tabGroups: [web] });
    const rows = buildMenu('tab', { tab: tab('a'), index: 0 }, { tabCount: 3, closedCount: 0 });
    expect(labels(rows).slice(0, 5)).toEqual(['Rename…', '---', 'Add to new group', 'Add to group', '---']);
    const into = sub(rows, 'Add to group');
    expect(labels(into.rows)).toEqual(['Web']);
    (into.rows[0] as Extract<MenuRow, { kind: 'action' }>).run();
    expect(useAppState.getState().profile.tabGroups[0].tabs).toEqual(['b', 'a']);
    const grouped = buildMenu('tab', { tab: tab('a'), index: 1 }, { tabCount: 3, closedCount: 0 });
    expect(labels(grouped)).toContain('Remove from group');
    expect(sub(grouped, 'Add to group')).toBeUndefined(); // no other group to move to
    find(grouped, 'Remove from group').run();
    expect(useAppState.getState().profile.tabGroups[0].tabs).toEqual(['b']);
    find(buildMenu('tab', { tab: tab('c'), index: 2 }, { tabCount: 3, closedCount: 0 }), 'Add to new group').run();
    expect(useAppState.getState().profile.tabGroups.map((g) => g.tabs)).toEqual([['b'], ['c']]);
  });

  it('the tab bar lists the saved groups to reopen, each with a delete', () => {
    const saved = [
      { id: 's1', name: 'Docs', color: 'green', tabs: [{ path: '/d', alias: null, worktree: null }, { path: '/e', alias: null, worktree: null }] },
      { id: 's2', name: '', color: 'red', tabs: [{ path: '/f', alias: null, worktree: null }] },
    ];
    set({ savedGroups: saved });
    expect(sub(buildMenu('tabbar', null, { lastClosed: null, savedGroups: [] }), 'Saved groups')).toBeUndefined();
    const rows = buildMenu('tabbar', null, { lastClosed: null, savedGroups: saved });
    expect(labels(rows)).toEqual(['Reopen closed tab', 'Saved groups', '---', 'Open repository…', 'Clone repository…']);
    const list = sub(rows, 'Saved groups').rows as Extract<MenuRow, { kind: 'action' }>[];
    expect(labels(list)).toEqual(['Docs (2 tabs)', 'Red (1 tab)']);
    expect(list[0].variants?.map((v) => v.tooltip)).toEqual(['Delete the saved group Docs']);
    list[0].run();
    const p = useAppState.getState().profile;
    expect(p.tabs.map((t) => t.path)).toEqual(['/a', '/b', '/c', '/d', '/e']);
    expect(p.tabGroups.map((g) => g.name)).toEqual(['Docs']);
    expect(p.savedGroups.map((s) => s.id)).toEqual(['s2']);
  });
});
