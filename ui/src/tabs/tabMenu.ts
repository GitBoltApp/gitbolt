import type { LucideIcon } from 'lucide-react';
import { create } from 'zustand';
import { errorMessage } from '../api/client';
import type { Profile } from '../api/gen/Profile';
import type { TabState } from '../api/gen/TabState';
import { copyText } from '../api/transport';
import { openRepoFolder, reopenLastClosed } from '../app/coreActions';
import { useRuntime } from '../app/runtime';
import { useAppState } from '../app/state';
import { closeOthers, closeTab, closeToRight } from '../app/tabs';
import { ICONS } from '../menu/icons';
import { registerMenu } from '../menu/registry';
import type { MenuRow } from '../menu/types';
import { useToast } from '../ui/toast';

/** Which tab's rename input shows (`TabBar`'s double-click / the tab menu's Rename). */
export const useTabUi = create<{ renaming: string | null; startRename(id: string): void; stopRename(): void }>((set) => ({
  renaming: null,
  startRename: (id) => set({ renaming: id }),
  stopRename: () => set({ renaming: null }),
}));

export interface TabTarget { tab: TabState; index: number }
export interface TabEnv { tabCount: number; closedCount: number }

const update = (fn: (p: Profile) => Profile) => useAppState.getState().updateProfile(fn);

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

registerMenu<TabTarget, TabEnv>({
  id: 'tab.close', kind: 'tab', group: 'close', order: 0,
  rows: ({ tab, index }, env) => [
    row('tab.close', 'Close', ICONS.close, 'Close this tab', () => update((p) => closeTab(p, tab.id)), { shortcut: 'Ctrl+W' }),
    row('tab.closeOthers', 'Close others', ICONS.closeOthers, 'Close every other tab', () => update((p) => closeOthers(p, tab.id)), env.tabCount > 1 ? {} : { disabledReason: 'This is the only tab' }),
    row('tab.closeRight', 'Close to the right', ICONS.closeRight, 'Close the tabs to the right of this one', () => update((p) => closeToRight(p, tab.id)), index < env.tabCount - 1 ? {} : { disabledReason: 'No tabs to the right' }),
  ],
});

registerMenu<TabTarget, TabEnv>({
  id: 'tab.reopen', kind: 'tab', group: 'restore', order: 0,
  // `reopenLastClosed` lives in `app/coreActions.ts` (the task 9 deviation): the tab menu's
  // Reopen and Ctrl+Shift+T are the one function.
  rows: (_t, env) => [row(
    'tab.reopen', 'Reopen closed tab', ICONS.reopen, 'Reopen the most recently closed tab', reopenLastClosed,
    env.closedCount > 0 ? { shortcut: 'Ctrl+Shift+T' } : { shortcut: 'Ctrl+Shift+T', disabledReason: 'No recently closed tabs' },
  )],
});

registerMenu<TabTarget, TabEnv>({
  id: 'tab.repo', kind: 'tab', group: 'repo', order: 0,
  when: ({ tab }) => tab.kind === 'repo' && !!tab.path,
  rows: ({ tab }) => {
    const repo = useRuntime.getState().tabs[tab.id]?.repo ?? null;
    return [
      row('tab.copyPath', 'Copy repo path', ICONS.copy, `Copy "${tab.path}"`, () => {
        void copyText(tab.path!).then(() => useToast.getState().show('Copied'), (e: unknown) => useToast.getState().show(errorMessage(e)));
      }),
      row(
        'tab.openFolder', 'Open in file manager', ICONS.reveal, "Open the repository's folder in the file manager",
        () => { if (repo) openRepoFolder(repo.id, repo.path); },
        repo ? {} : { disabledReason: 'Still loading' },
      ),
    ];
  },
});
