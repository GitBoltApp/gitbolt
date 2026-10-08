import { create } from 'zustand';
import type { TabGroup } from '../api/gen/TabGroup';

/** The hover delay of the chip's list of tabs: the tab strip's own (a tab's path tooltip). */
export const GROUP_LIST_DELAY_MS = 400;

/** "Blue" for `blue`. */
export const colorLabel = (color: string): string => color.charAt(0).toUpperCase() + color.slice(1);

/** What a group is called: its name, else its colour. */
export const groupLabel = (g: TabGroup): string => g.name || colorLabel(g.color);

/** The chip of group `id`, in the tab strip. */
export const chipEl = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-strip-key="chip:${CSS.escape(id)}"]`);

interface GroupUi {
  /** The group whose menu (colour, name, actions) is open. */
  menu: string | null;
  /** The group whose list of tabs shows; `focus`: opened from the keyboard, on its first row. */
  list: { id: string; focus: boolean } | null;
  openMenu(id: string): void;
  closeMenu(): void;
  openList(id: string, focus?: boolean): void;
  closeList(): void;
}

/** The tab strip's group popups: one at a time. */
export const useGroupUi = create<GroupUi>((set) => ({
  menu: null,
  list: null,
  openMenu: (id) => set({ menu: id, list: null }),
  closeMenu: () => set({ menu: null }),
  openList: (id, focus = false) => set({ list: { id, focus }, menu: null }),
  closeList: () => set({ list: null }),
}));
