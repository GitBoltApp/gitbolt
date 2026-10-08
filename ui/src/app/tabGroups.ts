import type { Profile } from '../api/gen/Profile';
import type { SavedTabGroup } from '../api/gen/SavedTabGroup';
import type { TabGroup } from '../api/gen/TabGroup';
import type { TabState } from '../api/gen/TabState';
import { closeTab, newTabId, tabWorktree } from './tabs';

/**
 * Pure helpers over a profile's tab groups (Firefox-style). The strip's order is `profile.tabs`;
 * a group's `tabs` mirror it, and a group's tabs are always next to each other. Every helper
 * returns a profile that keeps that (`normalizeGroups`, which the app state also applies to any
 * change, so a tab closed by any path leaves its group).
 */

/** Firefox's nine, in its order: a new group takes the first one no open group uses. */
export const GROUP_COLORS = ['blue', 'purple', 'cyan', 'orange', 'yellow', 'pink', 'green', 'gray', 'red'] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

export const newGroupId = (): string => `g${newTabId()}`;

/** Where a tab or a group goes: right before or right after a tab. */
export type Place = { before: string } | { after: string };

const groups = (p: Profile): TabGroup[] => p.tabGroups ?? [];

export const groupOf = (p: Profile, tabId: string): TabGroup | undefined => groups(p).find((g) => g.tabs.includes(tabId));
export const groupById = (p: Profile, id: string): TabGroup | undefined => groups(p).find((g) => g.id === id);

export function nextGroupColor(p: Profile): GroupColor {
  const used = new Set(groups(p).map((g) => g.color));
  return GROUP_COLORS.find((c) => !used.has(c)) ?? GROUP_COLORS[groups(p).length % GROUP_COLORS.length];
}

/** A tab the strip doesn't show: in a collapsed group, and not the active tab. */
export function isTabHidden(p: Profile, tabId: string): boolean {
  return tabId !== p.activeTab && !!groupOf(p, tabId)?.collapsed;
}

export type StripItem = { kind: 'chip'; group: TabGroup } | { kind: 'tab'; tab: TabState; group: TabGroup | undefined; hidden: boolean };

/** What the strip shows, in order: each group's chip before its first tab, then the tabs that
 * aren't hidden (`withHidden`: the hidden ones too, flagged, which the strip keeps laid out at
 * no width so collapsing and expanding can animate). */
export function stripItems(p: Profile, withHidden = false): StripItem[] {
  const out: StripItem[] = [];
  for (const t of p.tabs) {
    const g = groupOf(p, t.id);
    if (g && g.tabs[0] === t.id) out.push({ kind: 'chip', group: g });
    const hidden = isTabHidden(p, t.id);
    if (!hidden || withHidden) out.push({ kind: 'tab', tab: t, group: g, hidden });
  }
  return out;
}

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The invariants, restored: groups list only open tabs, in strip order, each tab in at most one
 * group; empty groups go; a group whose tabs got split up is pulled together at its first tab.
 * Returns `p` itself when nothing needed fixing (no needless save).
 */
export function normalizeGroups(p: Profile): Profile {
  const open = new Set(p.tabs.map((t) => t.id));
  const taken = new Set<string>();
  let changed = p.tabGroups === undefined || p.savedGroups === undefined;
  const fixed: TabGroup[] = [];
  for (const g of groups(p)) {
    const want = new Set(g.tabs.filter((id) => open.has(id) && !taken.has(id)));
    const tabs = p.tabs.map((t) => t.id).filter((id) => want.has(id));
    tabs.forEach((id) => taken.add(id));
    if (!tabs.length) { changed = true; continue; }
    if (!sameIds(tabs, g.tabs)) changed = true;
    fixed.push(sameIds(tabs, g.tabs) ? g : { ...g, tabs });
  }
  // Contiguity: each group's tabs, all at its first tab's place.
  const byId = new Map(p.tabs.map((t) => [t.id, t]));
  const groupFor = new Map(fixed.flatMap((g) => g.tabs.map((id) => [id, g] as const)));
  const done = new Set<string>();
  const tabs: TabState[] = [];
  for (const t of p.tabs) {
    const g = groupFor.get(t.id);
    if (!g) { tabs.push(t); continue; }
    if (done.has(g.id)) continue;
    done.add(g.id);
    tabs.push(...g.tabs.map((id) => byId.get(id)!));
  }
  if (!sameIds(tabs.map((t) => t.id), p.tabs.map((t) => t.id))) changed = true;
  if (!changed) return p;
  return { ...p, tabs, tabGroups: fixed, savedGroups: p.savedGroups ?? [] };
}

const mapGroup = (p: Profile, id: string, fn: (g: TabGroup) => TabGroup): Profile =>
  ({ ...p, tabGroups: groups(p).map((g) => (g.id === id ? fn(g) : g)) });

/** `p` with `tabId` in no group. */
const leave = (p: Profile, tabId: string): Profile =>
  ({ ...p, tabGroups: groups(p).map((g) => (g.tabs.includes(tabId) ? { ...g, tabs: g.tabs.filter((id) => id !== tabId) } : g)) });

/** `tabId` moved to `at` in the strip (membership untouched). */
function moveTo(p: Profile, tabId: string, at: Place): Profile {
  const t = p.tabs.find((x) => x.id === tabId);
  if (!t) return p;
  const rest = p.tabs.filter((x) => x.id !== tabId);
  const ref = rest.findIndex((x) => x.id === ('before' in at ? at.before : at.after));
  if (ref < 0) return p;
  const i = 'before' in at ? ref : ref + 1;
  return { ...p, tabs: [...rest.slice(0, i), t, ...rest.slice(i)] };
}

/** Adds `tabId` to group `id` (leaving any other), keeping the members in strip order. */
const join = (p: Profile, tabId: string, id: string): Profile =>
  mapGroup(leave(p, tabId), id, (g) => ({ ...g, tabs: [...g.tabs, tabId] }));

/**
 * A tab dragged to `at` (null: it stays where it is), in group `group` (null: in none), as one
 * update: leaving one group and joining another is a single change, so the strip never shows the
 * step between. At a group's edge, the strip's drag decides which side of it the tab is on.
 */
export function placeTab(p: Profile, tabId: string, at: Place | null, group: string | null): Profile {
  const moved = at ? moveTo(p, tabId, at) : p;
  if (!moved.tabs.some((t) => t.id === tabId)) return p;
  return normalizeGroups(group && groupById(moved, group) ? join(moved, tabId, group) : leave(moved, tabId));
}

/**
 * A tab dropped onto another (the middle of it): it goes right beside the target, on the side it
 * came from, and joins the target's group, or the two make a new one with the next colour.
 */
export function groupOnto(p: Profile, tabId: string, targetId: string, id = newGroupId()): Profile {
  const from = p.tabs.findIndex((t) => t.id === tabId);
  const to = p.tabs.findIndex((t) => t.id === targetId);
  if (from < 0 || to < 0 || from === to) return p;
  // Not normalized until it has joined: beside a grouped target, it's inside that group's span.
  const left = leave(moveTo(p, tabId, from < to ? { before: targetId } : { after: targetId }), tabId);
  const placed = { ...left, tabGroups: groups(left).filter((g) => g.tabs.length) };
  const target = groupOf(placed, targetId);
  if (target) return normalizeGroups(join(placed, tabId, target.id));
  const g: TabGroup = { id, name: '', color: nextGroupColor(placed), collapsed: false, tabs: [tabId, targetId] };
  return normalizeGroups({ ...placed, tabGroups: [...groups(placed), g] });
}

/** The tab menu's "Add to new group": a group of one. */
export function newGroupWith(p: Profile, tabId: string, id = newGroupId()): Profile {
  if (!p.tabs.some((t) => t.id === tabId)) return p;
  const left = normalizeGroups(leave(p, tabId));
  return normalizeGroups({ ...left, tabGroups: [...groups(left), { id, name: '', color: nextGroupColor(left), collapsed: false, tabs: [tabId] }] });
}

/** The tab menu's "Add to group": the tab moves to the group's end. */
export function addToGroup(p: Profile, tabId: string, id: string): Profile {
  const g = groupById(p, id);
  if (!g || g.tabs.includes(tabId)) return p;
  return normalizeGroups(join(moveTo(p, tabId, { after: g.tabs.at(-1)! }), tabId, id));
}

/** "Remove from group": the tab moves out, right after the group. */
export function removeFromGroup(p: Profile, tabId: string): Profile {
  const g = groupOf(p, tabId);
  if (!g) return p;
  const last = g.tabs.at(-1)!;
  const moved = last === tabId ? p : moveTo(p, tabId, { after: last });
  return normalizeGroups(leave(moved, tabId));
}

/** A whole group dragged to `at`: never into another group, so past that one whole. */
export function moveGroup(p: Profile, id: string, at: Place): Profile {
  const g = groupById(p, id);
  if (!g) return p;
  const refId = 'before' in at ? at.before : at.after;
  if (g.tabs.includes(refId)) return p;
  const other = groupOf(p, refId);
  const ref = other ? ('before' in at ? other.tabs[0] : other.tabs.at(-1)!) : refId;
  const mine = new Set(g.tabs);
  const moving = p.tabs.filter((t) => mine.has(t.id));
  const rest = p.tabs.filter((t) => !mine.has(t.id));
  const r = rest.findIndex((t) => t.id === ref);
  if (r < 0) return p;
  const i = 'before' in at ? r : r + 1;
  return normalizeGroups({ ...p, tabs: [...rest.slice(0, i), ...moving, ...rest.slice(i)] });
}

export const ungroup = (p: Profile, id: string): Profile => ({ ...p, tabGroups: groups(p).filter((g) => g.id !== id) });

export const toggleGroupCollapsed = (p: Profile, id: string): Profile => mapGroup(p, id, (g) => ({ ...g, collapsed: !g.collapsed }));

export const setGroupColor = (p: Profile, id: string, color: string): Profile => mapGroup(p, id, (g) => ({ ...g, color }));

export const renameGroup = (p: Profile, id: string, name: string): Profile => mapGroup(p, id, (g) => ({ ...g, name: name.trim() }));

/** "New tab in group": an Open tab at the group's end, active; the group expands. */
export function newTabInGroup(p: Profile, id: string, tabId = newTabId()): { profile: Profile; tabId: string } {
  const g = groupById(p, id);
  if (!g) return { profile: p, tabId };
  const at = p.tabs.findIndex((t) => t.id === g.tabs.at(-1)) + 1;
  const tab: TabState = { id: tabId, kind: 'open', path: null, alias: null, worktree: null };
  const tabs = [...p.tabs.slice(0, at), tab, ...p.tabs.slice(at)];
  return { profile: mapGroup({ ...p, tabs, activeTab: tabId }, id, (x) => ({ ...x, collapsed: false, tabs: [...x.tabs, tabId] })), tabId };
}

/** "Delete group": its tabs close (onto the closed stack, as any closed tab), then the group goes. */
export function deleteGroup(p: Profile, id: string): Profile {
  const g = groupById(p, id);
  if (!g) return p;
  return normalizeGroups(ungroup(g.tabs.reduce(closeTab, p), id));
}

/**
 * "Save and close group": the group (name, colour, its repo tabs in order) goes on the saved list
 * and its tabs close, without going on the closed stack (the saved group is how they come back).
 * The active tab, if it was one of them, hands over to the tab after the group, else the one
 * before.
 */
export function saveAndCloseGroup(p: Profile, id: string): Profile {
  const g = groupById(p, id);
  if (!g) return p;
  const mine = new Set(g.tabs);
  const first = p.tabs.findIndex((t) => mine.has(t.id));
  const tabs = p.tabs.filter((t) => !mine.has(t.id));
  const saved: SavedTabGroup = {
    id: g.id, name: g.name, color: g.color,
    tabs: p.tabs.filter((t) => mine.has(t.id) && t.kind === 'repo' && t.path).map((t) => ({ path: t.path!, alias: t.alias, worktree: t.worktree ?? null })),
  };
  const activeTab = p.activeTab && mine.has(p.activeTab) ? tabs[Math.min(first, tabs.length - 1)]?.id ?? null : p.activeTab;
  const savedGroups = saved.tabs.length ? [...(p.savedGroups ?? []), saved] : p.savedGroups ?? [];
  return normalizeGroups({ ...p, tabs, activeTab, tabGroups: groups(p).filter((x) => x.id !== id), savedGroups });
}

/**
 * Reopens a saved group at the end of the strip, expanded, on its first tab, and drops it from
 * the saved list. A repo open again meanwhile stays where it is (one tab per repo and worktree).
 */
export function reopenSavedGroup(p: Profile, savedId: string, mkId: () => string = newTabId): Profile {
  const s = (p.savedGroups ?? []).find((x) => x.id === savedId);
  if (!s) return p;
  const savedGroups = (p.savedGroups ?? []).filter((x) => x !== s);
  const isOpen = (path: string, worktree: string | null) => p.tabs.some((t) => t.kind === 'repo' && t.path === path && tabWorktree(t) === (worktree ?? path));
  const fresh: TabState[] = s.tabs.filter((t) => !isOpen(t.path, t.worktree)).map((t) => ({ id: mkId(), kind: 'repo', path: t.path, alias: t.alias, worktree: t.worktree }));
  if (!fresh.length) return { ...p, savedGroups };
  const id = groupById(p, s.id) ? newGroupId() : s.id;
  const g: TabGroup = { id, name: s.name, color: s.color, collapsed: false, tabs: fresh.map((t) => t.id) };
  return normalizeGroups({ ...p, tabs: [...p.tabs, ...fresh], activeTab: fresh[0].id, tabGroups: [...groups(p), g], savedGroups });
}

export const deleteSavedGroup = (p: Profile, savedId: string): Profile => ({ ...p, savedGroups: (p.savedGroups ?? []).filter((s) => s.id !== savedId) });
