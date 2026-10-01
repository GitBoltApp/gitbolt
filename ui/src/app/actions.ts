import { CircleHelp, FileText, FolderGit2, LayoutPanelLeft, Pencil, type LucideIcon } from 'lucide-react';
import type { TabState } from '../api/gen/TabState';
import type { MenuRow } from '../menu/types';
import { useRuntime, type TabRuntime } from './runtime';
import { useAppState } from './state';
import { tabStore } from './tabStores';
import type { RepoViewStore } from '../repo/store';

/**
 * The one registry of app actions: the hamburger menu (spec §6.1), the global shortcuts (§11.1,
 * `shortcuts.ts`), toolbar buttons and the palette's `>` group (§11.2) all read it. Each feature
 * registers its own actions from its own module (`app/features.ts` imports them), so no two
 * features edit one list.
 */
export type ActionGroup = 'File' | 'Edit' | 'View' | 'Repository' | 'Help';
export interface Action {
  id: string;
  label: string;
  group: ActionGroup;
  icon: LucideIcon;
  tooltip: string;
  /** `comboOf` names, e.g. `Ctrl+Shift+T`. The first is the one menus show. When several
   * usable actions share a combo, the first registered takes it. */
  shortcuts?: string[];
  /** Usable now (hidden from menus and the palette, and its shortcut passes through, when not). */
  when?: () => boolean;
  run: () => void | Promise<void>;
}

const registry = new Map<string, Action>();

// Bumped on every registration change, for views built from action ids (the toolbar) to follow a
// feature registering after they mounted (`useSyncExternalStore(subscribeActions, actionsVersion)`).
let version = 0;
const listeners = new Set<() => void>();
const changed = () => {
  version++;
  for (const l of [...listeners]) l();
};
export const actionsVersion = () => version;
export function subscribeActions(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function registerActions(list: Action[]): () => void {
  for (const a of list) if (registry.has(a.id)) throw new Error(`action ${a.id} is already registered`);
  for (const a of list) registry.set(a.id, a);
  changed();
  return () => {
    for (const a of list) if (registry.get(a.id) === a) registry.delete(a.id);
    changed();
  };
}

export const getAction = (id: string) => registry.get(id);
const usable = (a: Action) => !a.when || a.when();
/** Usable actions, in registration order. */
export const availableActions = () => [...registry.values()].filter(usable);

/** Runs `a` now, in the caller's task (a key press's effects land before the next paint);
 * errors are logged, not thrown. */
export function invoke(a: Action): void {
  const failed = (e: unknown) => console.warn(`[gitbolt] action ${a.id} failed`, e);
  try {
    void Promise.resolve(a.run()).catch(failed);
  } catch (e) {
    failed(e);
  }
}

/** Runs the action if it's usable; false if not (or unknown). */
export function runAction(id: string): boolean {
  const a = registry.get(id);
  if (!a || !usable(a)) return false;
  invoke(a);
  return true;
}

export function actionForCombo(combo: string): Action | undefined {
  return combo ? availableActions().find((a) => a.shortcuts?.includes(combo)) : undefined;
}

export const activeTab = (): TabState | null => {
  const p = useAppState.getState().profile;
  return p.tabs.find((t) => t.id === p.activeTab) ?? null;
};
export const activeRuntime = (): TabRuntime | null => {
  const t = activeTab();
  return t ? useRuntime.getState().tabs[t.id] ?? null : null;
};
/** The active tab's 1B view state (ruling R3), once its graph has loaded. */
export const activeStore = (): RepoViewStore | null => {
  const t = activeTab();
  return t ? tabStore(t.id) ?? null : null;
};

const GROUPS: Array<{ group: ActionGroup; icon: LucideIcon; tooltip: string }> = [
  { group: 'File', icon: FileText, tooltip: 'Repositories, tabs and settings' },
  { group: 'Edit', icon: Pencil, tooltip: 'Find, filter and the command palette' },
  { group: 'View', icon: LayoutPanelLeft, tooltip: 'Tabs and panels' },
  { group: 'Repository', icon: FolderGit2, tooltip: 'Actions on the current repository' },
  { group: 'Help', icon: CircleHelp, tooltip: 'About GitBolt' },
];

const QUIT_ID = 'file.quit';

/** The hamburger menu (spec §6.1): one submenu per group that has at least one usable action.
 * When several usable actions share a combo (Ctrl+W: `file.closeFile` while a file is open, else
 * `file.closeTab`), only the one `actionForCombo` would actually run shows the badge — never
 * both, so the menu never claims two rows for the one press the user has bound. */
export function hamburgerRows(): MenuRow[] {
  const all = availableActions();
  return GROUPS.flatMap(({ group, icon, tooltip }) => {
    // Quit is always the last entry of File, after a separator (K95), wherever it registered.
    const inGroup = all.filter((a) => a.group === group);
    const ordered = [...inGroup.filter((a) => a.id !== QUIT_ID), ...inGroup.filter((a) => a.id === QUIT_ID)];
    const rows: MenuRow[] = ordered.flatMap((a, i): MenuRow[] => {
      const combo = a.shortcuts?.[0];
      const shortcut = combo && actionForCombo(combo) === a ? combo : undefined;
      const row: MenuRow = { kind: 'action', id: a.id, label: a.label, icon: a.icon, tooltip: a.tooltip, shortcut, run: () => invoke(a) };
      return a.id === QUIT_ID && i > 0 ? [{ kind: 'separator' }, row] : [row];
    });
    return rows.length ? [{ kind: 'submenu' as const, id: `menu.${group}`, label: group, icon, tooltip, rows }] : [];
  });
}
