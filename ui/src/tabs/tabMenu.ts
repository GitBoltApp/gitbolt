import { Archive, Group, Layers, Trash2, Ungroup, type LucideIcon } from 'lucide-react';
import { create } from 'zustand';
import { errorMessage } from '../api/client';
import type { Profile } from '../api/gen/Profile';
import type { SavedTabGroup } from '../api/gen/SavedTabGroup';
import { addToGroup, deleteSavedGroup, groupOf, newGroupWith, removeFromGroup, reopenSavedGroup } from '../app/tabGroups';
import { confirmAction } from '../ui/ConfirmDialog';
import { colorLabel, groupLabel } from './groupUi';
import type { TabState } from '../api/gen/TabState';
import { copyText } from '../api/transport';
import { runAction } from '../app/actions';
import { openRepoFolder, reopenLastClosed } from '../app/coreActions';
import { useRuntime, worktreeOf } from '../app/runtime';
import { useAppState } from '../app/state';
import { guardTabClose } from '../diff/workingCopy';
import { basename, closeOthers, closeTab, closeToRight } from '../app/tabs';
import { ICONS } from '../menu/icons';
import { registerMenu } from '../menu/registry';
import type { MenuRow } from '../menu/types';
import { useToast } from '../ui/toastStore';
import { resolveChord } from '../ui/platformKeys';

/** Which tab's rename input shows (`TabBar`'s double-click / the tab menu's Rename). */
export const useTabUi = create<{ renaming: string | null; startRename(id: string): void; stopRename(): void }>((set) => ({
  renaming: null,
  startRename: (id) => set({ renaming: id }),
  stopRename: () => set({ renaming: null }),
}));

export interface TabTarget { tab: TabState; index: number }
export interface TabEnv { tabCount: number; closedCount: number }

const update = (fn: (p: Profile) => Profile) => useAppState.getState().updateProfile(fn);
const tabIds = () => useAppState.getState().profile.tabs.map((t) => t.id);

type ActionRow = Extract<MenuRow, { kind: 'action' }>;
const row = (id: string, label: string, icon: LucideIcon, tooltip: string, run: () => void, extra: Partial<ActionRow> = {}): MenuRow =>
  ({ kind: 'action', id, label, icon, tooltip, run, ...extra });

// The tab context menu (spec §6.2): Rename, Close / Close others / Close to the right, Reopen
// closed tab, and (repo tabs only) Copy repo path / Open in file manager. `GROUP_ORDER.tab`
// (menu/registry.ts) is ['edit', 'close', 'restore', 'repo'].

registerMenu<TabTarget, TabEnv>({
  id: 'tab.rename', kind: 'tab', group: 'edit', order: 0,
  rows: ({ tab }) => [row('tab.rename', 'Rename…', ICONS.rename, 'Give this tab a display name (the repository is unchanged)', () => useTabUi.getState().startRename(tab.id))],
});

// Tab groups from the keyboard as well as by drag: into a new group or an existing one, or out.
registerMenu<TabTarget, TabEnv>({
  id: 'tab.group', kind: 'tab', group: 'group', order: 0,
  rows: ({ tab }) => {
    const p = useAppState.getState().profile;
    const own = groupOf(p, tab.id);
    const others = p.tabGroups.filter((g) => g !== own);
    return [
      row('tab.newGroup', 'Add to new group', Group, 'Start a new tab group with this tab', () => update((q) => newGroupWith(q, tab.id))),
      ...(others.length ? [{
        kind: 'submenu' as const, id: 'tab.addToGroup', label: 'Add to group', icon: Layers, tooltip: 'Move this tab into a tab group',
        rows: others.map((g) => row(`tab.addToGroup.${g.id}`, groupLabel(g), Layers, `Move this tab to the end of ${groupLabel(g)}`, () => update((q) => addToGroup(q, tab.id, g.id)))),
      }] : []),
      ...(own ? [row('tab.removeFromGroup', 'Remove from group', Ungroup, `Take this tab out of ${groupLabel(own)}`, () => update((q) => removeFromGroup(q, tab.id)))] : []),
    ];
  },
});

registerMenu<TabTarget, TabEnv>({
  id: 'tab.close', kind: 'tab', group: 'close', order: 0,
  rows: ({ tab, index }, env) => [
    row('tab.close', 'Close', ICONS.close, 'Close this tab', () => guardTabClose([tab.id], () => update((p) => closeTab(p, tab.id))), { shortcut: resolveChord('Mod+W') }),
    row('tab.closeOthers', 'Close others', ICONS.closeOthers, 'Close every other tab', () => guardTabClose(tabIds().filter((id) => id !== tab.id), () => update((p) => closeOthers(p, tab.id))), env.tabCount > 1 ? {} : { disabledReason: 'This is the only tab' }),
    row('tab.closeRight', 'Close to the right', ICONS.closeRight, 'Close the tabs to the right of this one', () => guardTabClose(tabIds().slice(index + 1), () => update((p) => closeToRight(p, tab.id))), index < env.tabCount - 1 ? {} : { disabledReason: 'No tabs to the right' }),
  ],
});

registerMenu<TabTarget, TabEnv>({
  id: 'tab.reopen', kind: 'tab', group: 'restore', order: 0,
  // `reopenLastClosed` lives in `app/coreActions.ts` (the task 9 deviation): the tab menu's
  // Reopen and Ctrl+Shift+T are the one function.
  rows: (_t, env) => [row(
    'tab.reopen', 'Reopen closed tab', ICONS.reopen, 'Reopen the most recently closed tab', reopenLastClosed,
    env.closedCount > 0 ? { shortcut: resolveChord('Mod+Shift+T') } : { shortcut: resolveChord('Mod+Shift+T'), disabledReason: 'No recently closed tabs' },
  )],
});

registerMenu<TabTarget, TabEnv>({
  id: 'tab.repo', kind: 'tab', group: 'repo', order: 0,
  when: ({ tab }) => tab.kind === 'repo' && !!tab.path,
  rows: ({ tab }) => {
    const rt = useRuntime.getState().tabs[tab.id];
    const repo = rt?.repo ?? null;
    return [
      row('tab.copyPath', 'Copy repo path', ICONS.copy, `Copy "${tab.path}"`, () => {
        void copyText(tab.path!).then(() => useToast.getState().show('Copied'), (e: unknown) => useToast.getState().show(errorMessage(e)));
      }),
      row(
        'tab.openFolder', 'Open in file manager', ICONS.reveal, "Open the tab's worktree directory in the file manager",
        // The tab's active worktree, not the repository's main one (spec #2 §11.2).
        () => { if (repo) openRepoFolder(repo.id, worktreeOf(rt) ?? repo.path); },
        repo ? {} : { disabledReason: 'Still loading' },
      ),
    ];
  },
});

// The tab bar's empty-space menu: Reopen <name> (the same function as Ctrl+Shift+T) and the saved
// groups, then Open repository and Clone (the registry's own actions).
export interface TabBarEnv { lastClosed: { path: string; alias: string | null } | null; savedGroups?: SavedTabGroup[] }

registerMenu<null, TabBarEnv>({
  id: 'tabbar.reopen', kind: 'tabbar', group: 'restore', order: 0,
  rows: (_t, { lastClosed }) => [row(
    'tabbar.reopen', lastClosed ? `Reopen ${lastClosed.alias ?? basename(lastClosed.path)}` : 'Reopen closed tab', ICONS.reopen,
    'Reopen the most recently closed tab', reopenLastClosed,
    lastClosed ? { shortcut: resolveChord('Mod+Shift+T') } : { shortcut: resolveChord('Mod+Shift+T'), disabledReason: 'No recently closed tabs' },
  )],
});

// "Save and close group" keeps a group here: picking it reopens it as a group; its trash
// variant deletes it, armed on the row first.
registerMenu<null, TabBarEnv>({
  id: 'tabbar.savedGroups', kind: 'tabbar', group: 'restore', order: 1,
  when: (_t, { savedGroups }) => !!savedGroups?.length,
  rows: (_t, { savedGroups }) => [{
    kind: 'submenu', id: 'tabbar.savedGroups', label: 'Saved groups', icon: Archive, tooltip: 'Groups closed with "Save and close group"',
    rows: savedGroups!.map((s) => {
      const name = s.name || colorLabel(s.color);
      const n = s.tabs.length;
      return row(`tabbar.savedGroup.${s.id}`, `${name} (${n} tab${n === 1 ? '' : 's'})`, Layers, `Reopen ${name}: ${s.tabs.map((t) => t.alias ?? basename(t.path)).join(', ')}`,
        () => update((p) => reopenSavedGroup(p, s.id)), {
          variants: [{
            id: 'delete', icon: Trash2, tooltip: `Delete the saved group ${name}`,
            run: () => {
              void confirmAction({ arm: `Click again to delete ${name}`, danger: true, title: 'Delete saved group?', body: `Forgets ${name} and its ${n} tab${n === 1 ? '' : 's'}.`, confirmLabel: 'Delete' })
                .then((ok) => { if (ok) update((p) => deleteSavedGroup(p, s.id)); });
            },
          }],
        });
    }),
  }],
});

registerMenu<null, TabBarEnv>({
  id: 'tabbar.open', kind: 'tabbar', group: 'open', order: 0,
  rows: () => [
    row('tabbar.openRepo', 'Open repository…', ICONS.openRepo, 'Open the Open Repository screen in a new tab', () => runAction('file.openRepo'), { shortcut: resolveChord('Mod+O') }),
    row('tabbar.clone', 'Clone repository…', ICONS.clone, 'Clone a repository into a new tab', () => runAction('file.clone')),
  ],
});
