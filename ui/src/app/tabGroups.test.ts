import { describe, expect, it } from 'vitest';
import type { Profile } from '../api/gen/Profile';
import type { TabGroup } from '../api/gen/TabGroup';
import { EMPTY_PROFILE } from './state';
import {
  addToGroup, deleteGroup, deleteSavedGroup, GROUP_COLORS, groupOf, groupOnto, isTabHidden, moveGroup, newGroupWith, newTabInGroup, nextGroupColor,
  normalizeGroups, placeTab, removeFromGroup, renameGroup, reopenSavedGroup, saveAndCloseGroup, setGroupColor, stripItems, toggleGroupCollapsed, ungroup,
} from './tabGroups';
import { closeTab, cycleTab } from './tabs';

const tab = (id: string) => ({ id, kind: 'repo' as const, path: `/${id}`, alias: null, worktree: null });
const group = (id: string, tabs: string[], extra: Partial<TabGroup> = {}): TabGroup => ({ id, name: '', color: 'blue', collapsed: false, tabs, ...extra });
const profile = (ids: string[], groups: TabGroup[] = [], active = ids[0]): Profile =>
  ({ ...EMPTY_PROFILE, id: 'default', tabs: ids.map(tab), activeTab: active, tabGroups: groups });
const order = (p: Profile) => p.tabs.map((t) => t.id).join('');
const members = (p: Profile) => Object.fromEntries(p.tabGroups.map((g) => [g.id, g.tabs.join('')]));
/** The strip as rendered: `[g]` for a chip, then the visible tabs. */
const strip = (p: Profile) => stripItems(p).map((i) => (i.kind === 'chip' ? `[${i.group.id}]` : i.tab.id)).join('');

describe('making a group: a tab dropped onto another', () => {
  it('the two become a new group with the next unused colour, the dragged tab beside the target', () => {
    const p = groupOnto(profile(['a', 'b', 'c', 'd']), 'a', 'c', 'g1');
    expect(order(p)).toBe('bacd'); // came from the left: lands just before the target
    expect(p.tabGroups).toEqual([group('g1', ['a', 'c'], { color: GROUP_COLORS[0] })]);
    const q = groupOnto(p, 'd', 'b', 'g2');
    expect(order(q)).toBe('bdac'); // came from the right: just after it
    expect(q.tabGroups[1]).toEqual(group('g2', ['b', 'd'], { color: GROUP_COLORS[1] }));
  });

  it('onto a grouped tab: joins that group (leaving its own)', () => {
    const p = groupOnto(profile(['a', 'b', 'c', 'd'], [group('g1', ['a', 'b']), group('g2', ['d'], { color: 'red' })]), 'd', 'a', 'x');
    expect(order(p)).toBe('adbc');
    expect(members(p)).toEqual({ g1: 'adb' });
  });

  it('the next colour skips the ones in use and wraps once all nine are', () => {
    expect(nextGroupColor(profile(['a'], [group('g', [], { color: 'blue' }), group('h', [], { color: 'cyan' })]))).toBe('purple');
    const all = GROUP_COLORS.map((c, i) => group(`g${i}`, [], { color: c }));
    expect(nextGroupColor(profile(['a'], all))).toBe(GROUP_COLORS[all.length % GROUP_COLORS.length]);
    expect(GROUP_COLORS).toHaveLength(9);
  });

  it('from the keyboard (the tab menu): a new group of one, or added to the end of a group', () => {
    let p = newGroupWith(profile(['a', 'b', 'c']), 'b', 'g1');
    expect(members(p)).toEqual({ g1: 'b' });
    p = addToGroup(p, 'a', 'g1');
    expect(order(p)).toBe('bac');
    expect(members(p)).toEqual({ g1: 'ba' });
  });
});

describe('ungrouping and removing', () => {
  it('Ungroup keeps the tabs where they are', () => {
    const p = ungroup(profile(['a', 'b', 'c'], [group('g1', ['a', 'b'])]), 'g1');
    expect(order(p)).toBe('abc');
    expect(p.tabGroups).toEqual([]);
  });

  it('removing a middle tab moves it out, just after the group', () => {
    const p = removeFromGroup(profile(['a', 'b', 'c', 'd'], [group('g1', ['a', 'b', 'c'])]), 'b');
    expect(order(p)).toBe('acbd');
    expect(members(p)).toEqual({ g1: 'ac' });
  });

  it('closing a grouped tab drops it from its group; the last one drops the group', () => {
    let p = normalizeGroups(closeTab(profile(['a', 'b', 'c'], [group('g1', ['a', 'b'])]), 'a'));
    expect(members(p)).toEqual({ g1: 'b' });
    p = normalizeGroups(closeTab(p, 'b'));
    expect(p.tabGroups).toEqual([]);
  });

  it('Delete group closes its tabs (onto the closed stack) and hands the active tab on', () => {
    const p = deleteGroup(profile(['a', 'b', 'c', 'd'], [group('g1', ['b', 'c'])], 'b'), 'g1');
    expect(order(p)).toBe('ad');
    expect(p.tabGroups).toEqual([]);
    expect(p.activeTab).toBe('d');
    expect(p.closedTabs.map((c) => c.path)).toEqual(['/b', '/c']);
  });
});

describe('dragging a tab: where it lands and the group it lands in, in one update', () => {
  const base = () => profile(['a', 'b', 'c', 'd', 'e'], [group('g1', ['b', 'c', 'd'])]);

  it('into the span of a group joins it', () => {
    const p = placeTab(base(), 'a', { after: 'c' }, 'g1');
    expect(order(p)).toBe('bcade');
    expect(members(p)).toEqual({ g1: 'bcad' });
  });

  it('at a group\'s edge, either side: in it or out of it, as asked', () => {
    expect(members(placeTab(base(), 'a', { before: 'b' }, 'g1'))).toEqual({ g1: 'abcd' }); // its first tab
    expect(members(placeTab(base(), 'a', { before: 'b' }, null))).toEqual({ g1: 'bcd' });
    expect(members(placeTab(base(), 'e', { after: 'd' }, 'g1'))).toEqual({ g1: 'bcde' }); // its last tab
    expect(members(placeTab(base(), 'e', { after: 'd' }, null))).toEqual({ g1: 'bcd' });
  });

  it('a member leaves where it is (no move), or moved out of the span', () => {
    let p = placeTab(base(), 'd', null, null);
    expect(order(p)).toBe('abcde');
    expect(members(p)).toEqual({ g1: 'bc' });
    p = placeTab(base(), 'b', { after: 'e' }, null);
    expect(order(p)).toBe('acdeb');
    expect(members(p)).toEqual({ g1: 'cd' });
  });

  it('a member moved within its group stays in it', () => {
    const p = placeTab(base(), 'd', { before: 'b' }, 'g1');
    expect(order(p)).toBe('adbce');
    expect(members(p)).toEqual({ g1: 'dbc' });
  });

  it('a group of one goes when its tab leaves', () => {
    const p = placeTab(profile(['a', 'b', 'c'], [group('g1', ['c'])]), 'c', null, null);
    expect(order(p)).toBe('abc');
    expect(p.tabGroups).toEqual([]);
  });

  it('from one group into another: one update, with both memberships right', () => {
    const p = placeTab(profile(['a', 'b', 'c', 'd'], [group('g1', ['a', 'b']), group('g2', ['c', 'd'], { color: 'red' })]), 'b', { before: 'c' }, 'g2');
    expect(order(p)).toBe('abcd');
    expect(members(p)).toEqual({ g1: 'a', g2: 'bcd' });
  });
});

describe('moving a whole group', () => {
  const base = () => profile(['a', 'b', 'c', 'd', 'e', 'f'], [group('g1', ['b', 'c']), group('g2', ['e', 'f'])]);

  it('moves its tabs together, past single tabs', () => {
    expect(order(moveGroup(base(), 'g1', { after: 'd' }))).toBe('adbcef');
    expect(order(moveGroup(base(), 'g1', { before: 'a' }))).toBe('bcadef');
  });

  it('never lands inside another group: past it whole', () => {
    const p = moveGroup(base(), 'g1', { after: 'e' });
    expect(order(p)).toBe('adefbc');
    expect(members(p)).toEqual({ g1: 'bc', g2: 'ef' });
    expect(order(moveGroup(base(), 'g2', { before: 'c' }))).toBe('aefbcd');
  });
});

describe('collapsing', () => {
  it('a collapsed group shows only its chip; the active tab stays visible in it', () => {
    let p = profile(['a', 'b', 'c', 'd'], [group('g1', ['b', 'c'])], 'a');
    expect(strip(p)).toBe('a[g1]bcd');
    p = toggleGroupCollapsed(p, 'g1');
    expect(p.tabGroups[0].collapsed).toBe(true);
    expect(strip(p)).toBe('a[g1]d');
    expect(isTabHidden(p, 'b')).toBe(true);
    p = { ...p, activeTab: 'c' };
    expect(strip(p)).toBe('a[g1]cd');
    expect(isTabHidden(p, 'c')).toBe(false);
    expect(strip(toggleGroupCollapsed(p, 'g1'))).toBe('a[g1]bcd');
  });

  it('Ctrl+Tab skips the tabs of a collapsed group, except the active one', () => {
    const p = profile(['a', 'b', 'c', 'd'], [group('g1', ['b', 'c'], { collapsed: true })], 'a');
    expect(cycleTab(p, 1).activeTab).toBe('d');
    expect(cycleTab({ ...p, activeTab: 'd' }, -1).activeTab).toBe('a');
    // Its active tab is in the cycle, the others still aren't.
    const q = { ...p, activeTab: 'b' };
    expect(cycleTab(q, 1).activeTab).toBe('d');
    expect(cycleTab(q, -1).activeTab).toBe('a');
  });
});

describe('the group menu', () => {
  it('names, recolours, and opens a new tab at the group\'s end (expanding it)', () => {
    let p = profile(['a', 'b', 'c'], [group('g1', ['a', 'b'], { collapsed: true })]);
    p = renameGroup(setGroupColor(p, 'g1', 'green'), 'g1', '  Backend ');
    expect(p.tabGroups[0]).toMatchObject({ name: 'Backend', color: 'green' });
    const r = newTabInGroup(p, 'g1', 'n');
    expect(order(r.profile)).toBe('abnc');
    expect(r.profile.tabs[2].kind).toBe('open');
    expect(r.profile.activeTab).toBe('n');
    expect(r.profile.tabGroups[0]).toMatchObject({ tabs: ['a', 'b', 'n'], collapsed: false });
  });
});

describe('save and close, then reopen', () => {
  it('saves the group (name, colour, repos in order) and closes its tabs, not onto the closed stack', () => {
    const start = profile(['a', 'b', 'c', 'd'], [group('g1', ['b', 'c'], { name: 'Web', color: 'pink' })], 'c');
    const withAlias = { ...start, tabs: start.tabs.map((t) => (t.id === 'c' ? { ...t, alias: 'Site', worktree: '/c-wt' } : t)) };
    const p = saveAndCloseGroup(withAlias, 'g1');
    expect(order(p)).toBe('ad');
    expect(p.activeTab).toBe('d');
    expect(p.tabGroups).toEqual([]);
    expect(p.closedTabs).toEqual([]);
    expect(p.savedGroups).toEqual([{ id: 'g1', name: 'Web', color: 'pink', tabs: [{ path: '/b', alias: null, worktree: null }, { path: '/c', alias: 'Site', worktree: '/c-wt' }] }]);
  });

  it('reopening puts the tabs back as the group at the end, active on its first tab, and forgets the saved copy', () => {
    const saved = saveAndCloseGroup(profile(['a', 'b', 'c', 'd'], [group('g1', ['b', 'c'], { name: 'Web', color: 'pink', collapsed: true })]), 'g1');
    let n = 0;
    const p = reopenSavedGroup(saved, 'g1', () => `n${++n}`);
    expect(order(p)).toBe('adn1n2');
    expect(p.tabs.slice(2).map((t) => t.path)).toEqual(['/b', '/c']);
    expect(p.tabGroups).toEqual([group('g1', ['n1', 'n2'], { name: 'Web', color: 'pink' })]);
    expect(p.activeTab).toBe('n1');
    expect(p.savedGroups).toEqual([]);
  });

  it('a repo that\'s open again meanwhile isn\'t opened twice', () => {
    const saved = saveAndCloseGroup(profile(['a', 'b', 'c'], [group('g1', ['b', 'c'])]), 'g1');
    const p = reopenSavedGroup({ ...saved, tabs: [...saved.tabs, tab('b')] }, 'g1', () => 'n');
    expect(order(p)).toBe('abn');
    expect(members(p)).toEqual({ g1: 'n' });
  });

  it('a saved group can be deleted', () => {
    const saved = saveAndCloseGroup(profile(['a', 'b'], [group('g1', ['b'])]), 'g1');
    expect(deleteSavedGroup(saved, 'g1').savedGroups).toEqual([]);
  });
});

describe('normalizeGroups: the invariants after any change', () => {
  it('drops unknown tab ids and empty groups, orders members as the strip, and pulls a group together', () => {
    const p = normalizeGroups(profile(['a', 'b', 'c', 'd'], [group('g1', ['d', 'zz', 'b']), group('g2', ['nope'])]));
    expect(members(p)).toEqual({ g1: 'bd' });
    expect(order(p)).toBe('abdc');
  });

  it('is the identity (same object) when nothing needs fixing', () => {
    const p = profile(['a', 'b'], [group('g1', ['a', 'b'])]);
    expect(normalizeGroups(p)).toBe(p);
  });

  it('an old profile, without groups, loads as having none', () => {
    const old = { ...profile(['a']) } as Partial<Profile>;
    delete old.tabGroups;
    delete old.savedGroups;
    const p = normalizeGroups(old as Profile);
    expect(p.tabGroups).toEqual([]);
    expect(p.savedGroups).toEqual([]);
    expect(groupOf(p, 'a')).toBeUndefined();
  });
});
