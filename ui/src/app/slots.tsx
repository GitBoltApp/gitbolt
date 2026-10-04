import type { ComponentType } from 'react';
import { create } from 'zustand';
import type { TabState } from '../api/gen/TabState';

/**
 * The shell's named slots (ruling R10), so each later feature adds its component from its own
 * module instead of editing the layout files every lane shares:
 * - app slots, in `AppShell`: `header` (above the tabs: the tab bar), `statusBar` (below them),
 *   `overlay` (modals and dialogs: About, the profile dialog, the auth prompt, the palette);
 * - tab slots, given the tab: `toolbar` (a repo tab's top row), `banner` (between the toolbar and
 *   the panels: autostash, crash-recovery and conflict banners, spec #2 §3.7), `sidebar` (left of its center),
 *   both inside the tab's `RepoContext` and `RepoViewContext`; `graphOverlay` (floats over the
 *   graph panel, hidden with it while a file is open: the find box, spec §8.7); `openTab` (the
 *   whole page of an Open tab, spec §13); `centerOverlay` (over the whole center, the graph or an open
 *   file alike: the left flyout, spec #4 §5).
 * An empty slot renders nothing (no placeholder UI). Register at import time; `app/features.ts`
 * imports every feature module once. Like `registerActions`, a registration throws on a duplicate
 * id, so a module that registers releases them on a dev-server hot update:
 * `import.meta.hot?.dispose(registerAppSlot(…))` (see `coreActions.ts`).
 */
export type AppSlotName = 'header' | 'statusBar' | 'overlay';
export type TabSlotName = 'toolbar' | 'banner' | 'sidebar' | 'openTab' | 'graphOverlay' | 'centerOverlay';
export interface TabSlotProps { tab: TabState }

interface Entry<P> { id: string; order: number; Component: ComponentType<P> }
interface SlotState {
  app: Record<AppSlotName, Entry<object>[]>;
  tab: Record<TabSlotName, Entry<TabSlotProps>[]>;
}

const useSlots = create<SlotState>(() => ({
  app: { header: [], statusBar: [], overlay: [] },
  tab: { toolbar: [], banner: [], sidebar: [], openTab: [], graphOverlay: [], centerOverlay: [] },
}));

function add<P>(list: Entry<P>[], entry: Entry<P>): Entry<P>[] {
  if (list.some((e) => e.id === entry.id)) throw new Error(`slot entry ${entry.id} is already registered`);
  return [...list, entry].sort((a, b) => a.order - b.order);
}

/** Adds `Component` to an app slot (lower `order` first); returns its removal. */
export function registerAppSlot(slot: AppSlotName, id: string, Component: ComponentType, order = 0): () => void {
  useSlots.setState((s) => ({ app: { ...s.app, [slot]: add(s.app[slot], { id, order, Component }) } }));
  return () => useSlots.setState((s) => ({ app: { ...s.app, [slot]: s.app[slot].filter((e) => e.id !== id) } }));
}

/** Adds `Component` to a tab slot (lower `order` first); returns its removal. */
export function registerTabSlot(slot: TabSlotName, id: string, Component: ComponentType<TabSlotProps>, order = 0): () => void {
  useSlots.setState((s) => ({ tab: { ...s.tab, [slot]: add(s.tab[slot], { id, order, Component }) } }));
  return () => useSlots.setState((s) => ({ tab: { ...s.tab, [slot]: s.tab[slot].filter((e) => e.id !== id) } }));
}

export function AppSlot({ name }: { name: AppSlotName }) {
  const entries = useSlots((s) => s.app[name]);
  return entries.map(({ id, Component }) => <Component key={id} />);
}

export function TabSlot({ name, tab }: { name: TabSlotName; tab: TabState }) {
  const entries = useSlots((s) => s.tab[name]);
  return entries.map(({ id, Component }) => <Component key={id} tab={tab} />);
}

/** Whether a tab slot has anything in it (an Open tab's page, for instance). */
export const useTabSlotFilled = (name: TabSlotName) => useSlots((s) => s.tab[name].length > 0);
