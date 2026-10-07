import type { Profile } from '../api/gen/Profile';
import type { TabState } from '../api/gen/TabState';
import { basename } from './osPath';

/** Pure helpers over a profile's tab set (spec §6.2) and recent repos (§13). */

export const MAX_CLOSED = 20;
export const MAX_RECENT = 50;

export const newTabId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export { basename };

/** What a tab shows: the alias, else the repo's name (a linked worktree's folder name, as
 * before 2C shared one handle between them), else the folder name. */
export function tabLabel(tab: TabState, repoName?: string | null): string {
  if (tab.alias) return tab.alias;
  if (tab.kind === 'open') return 'Open repository';
  if (tab.worktree && tab.path && tab.worktree !== tab.path) return basename(tab.worktree);
  return repoName ?? (tab.path ? basename(tab.path) : 'Repository');
}

/** The worktree a tab shows: its active one, else (a tab saved before 2C, or not opened yet) its path. */
export const tabWorktree = (t: TabState): string | null => t.worktree ?? t.path;

/** A tab is one repository with an active worktree (spec #2 §11.2): `(path, worktree)`; a
 * missing worktree is the repository's own path. */
const sameTab = (t: TabState, path: string, worktree: string | null) => t.kind === 'repo' && t.path === path && tabWorktree(t) === (worktree ?? path);

const activeIndex = (p: Profile) => p.tabs.findIndex((t) => t.id === p.activeTab);

function insertAfterActive(p: Profile, tab: TabState): Profile {
  const a = activeIndex(p);
  const at = a < 0 ? p.tabs.length : a + 1;
  return { ...p, tabs: [...p.tabs.slice(0, at), tab, ...p.tabs.slice(at)], activeTab: tab.id };
}

/** Opens `path` (on `worktree`) in a new tab after the active one, or focuses the tab already
 * showing it. */
export function openRepoTab(p: Profile, path: string, worktree: string | null = null, id = newTabId()): { profile: Profile; tabId: string } {
  const existing = p.tabs.find((t) => sameTab(t, path, worktree));
  if (existing) return { profile: { ...p, activeTab: existing.id }, tabId: existing.id };
  return { profile: insertAfterActive(p, { id, kind: 'repo', path, alias: null, worktree }), tabId: id };
}

export function openBlankTab(p: Profile, id = newTabId()): { profile: Profile; tabId: string } {
  return { profile: insertAfterActive(p, { id, kind: 'open', path: null, alias: null, worktree: null }), tabId: id };
}

/** Points a tab at a repo and worktree (Open screen → repo, or canonicalizing a path: a tab
 * saved before 2C on a linked worktree becomes `(repository, that worktree)`). A duplicate of
 * the same worktree collapses. */
export function setTabRepo(p: Profile, id: string, path: string, worktree: string | null = null): Profile {
  const dup = p.tabs.find((t) => t.id !== id && sameTab(t, path, worktree));
  if (dup) return { ...p, tabs: p.tabs.filter((t) => t.id !== id), activeTab: dup.id };
  return { ...p, tabs: p.tabs.map((t) => (t.id === id ? { ...t, kind: 'repo' as const, path, worktree } : t)) };
}

/** Closes a tab; the active one hands over to its right neighbour (else its left). Repo tabs go
 * on the closed stack (Ctrl+Shift+T), newest last, at most MAX_CLOSED, by the worktree they
 * showed: reopening opens that path, and `openRepo` names its repository again. */
export function closeTab(p: Profile, id: string): Profile {
  const i = p.tabs.findIndex((t) => t.id === id);
  if (i < 0) return p;
  const tab = p.tabs[i];
  const tabs = p.tabs.filter((t) => t.id !== id);
  const shown = tabWorktree(tab);
  const closedTabs = tab.kind === 'repo' && shown
    ? [...p.closedTabs, { path: shown, alias: tab.alias, index: i }].slice(-MAX_CLOSED)
    : p.closedTabs;
  const activeTab = p.activeTab === id ? tabs[Math.min(i, tabs.length - 1)]?.id ?? null : p.activeTab;
  return { ...p, tabs, closedTabs, activeTab };
}

function closeMany(p: Profile, keep: string, closing: TabState[]): Profile {
  const next = closing.reduce((acc, t) => closeTab(acc, t.id), p);
  const activeGone = closing.some((t) => t.id === p.activeTab);
  return activeGone ? { ...next, activeTab: keep } : next;
}

export function closeOthers(p: Profile, id: string): Profile {
  return closeMany(p, id, p.tabs.filter((t) => t.id !== id));
}

export function closeToRight(p: Profile, id: string): Profile {
  const i = p.tabs.findIndex((t) => t.id === id);
  return i < 0 ? p : closeMany(p, id, p.tabs.slice(i + 1));
}

/** Reopens the last closed tab at its old position (focusing it instead if it's open again). */
export function reopenClosed(p: Profile, id = newTabId()): { profile: Profile; tabId: string } | null {
  const last = p.closedTabs.at(-1);
  if (!last) return null;
  const closedTabs = p.closedTabs.slice(0, -1);
  const existing = p.tabs.find((t) => t.kind === 'repo' && tabWorktree(t) === last.path);
  if (existing) return { profile: { ...p, closedTabs, activeTab: existing.id }, tabId: existing.id };
  const at = Math.min(last.index, p.tabs.length);
  const tab: TabState = { id, kind: 'repo', path: last.path, alias: last.alias, worktree: null };
  return { profile: { ...p, tabs: [...p.tabs.slice(0, at), tab, ...p.tabs.slice(at)], closedTabs, activeTab: id }, tabId: id };
}

export function moveTab(p: Profile, from: number, to: number): Profile {
  if (from === to || from < 0 || to < 0 || from >= p.tabs.length || to >= p.tabs.length) return p;
  const tabs = [...p.tabs];
  const [t] = tabs.splice(from, 1);
  tabs.splice(to, 0, t);
  return { ...p, tabs };
}

/** A blank (or all-space) alias clears it. */
export function renameTab(p: Profile, id: string, alias: string | null): Profile {
  const clean = alias?.trim() || null;
  return { ...p, tabs: p.tabs.map((t) => (t.id === id ? { ...t, alias: clean } : t)) };
}

export function activateTab(p: Profile, id: string): Profile {
  return p.tabs.some((t) => t.id === id) ? { ...p, activeTab: id } : p;
}

/** The tab `delta` places from the active one, wrapping (Ctrl+Tab / Ctrl+Shift+Tab). */
export function cycleTab(p: Profile, delta: number): Profile {
  const n = p.tabs.length;
  if (n === 0) return p;
  const i = Math.max(0, activeIndex(p));
  return { ...p, activeTab: p.tabs[(((i + delta) % n) + n) % n].id };
}

/** Moves `path` to the top of the recent list (spec §13): pinned entries are all kept, the rest
 * capped so the list holds at most MAX_RECENT. */
export function touchRecent(p: Profile, path: string, name: string, now = Math.floor(Date.now() / 1000)): Profile {
  const prev = p.recent.find((r) => r.path === path);
  const all = [{ path, name, pinned: prev?.pinned ?? false, openedAt: now }, ...p.recent.filter((r) => r.path !== path)];
  const pinned = all.filter((r) => r.pinned).length;
  let unpinned = 0;
  return { ...p, recent: all.filter((r) => r.pinned || ++unpinned <= MAX_RECENT - pinned) };
}

export function togglePinRecent(p: Profile, path: string): Profile {
  return { ...p, recent: p.recent.map((r) => (r.path === path ? { ...r, pinned: !r.pinned } : r)) };
}

export function removeRecent(p: Profile, path: string): Profile {
  return { ...p, recent: p.recent.filter((r) => r.path !== path) };
}
