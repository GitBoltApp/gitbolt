import { create } from 'zustand';
import type { MenuRow } from './types';

interface MenuState {
  rows: MenuRow[] | null;
  x: number;
  y: number;
  /** `performance.now()`-based time of the triggering event (latency budget, spec §7). */
  openedAt: number;
  /** Bumped by every `show`: a `refresh` keeps it, so the menu knows to keep its place. */
  seq: number;
  /** The builder the rows came from, re-run by `refresh`. */
  build: (() => MenuRow[]) | null;
  show(rows: MenuRow[], x: number, y: number, openedAt?: number, build?: () => MenuRow[]): void;
  /** Re-runs the open menu's builder in place (e.g. the openers arrived): the rows update,
   * the open submenus and the active rows stay. */
  refresh(): void;
  close(): void;
}

export const useMenu = create<MenuState>((set, get) => ({
  rows: null,
  x: 0,
  y: 0,
  openedAt: 0,
  seq: 0,
  build: null,
  show: (rows, x, y, openedAt = performance.now(), build) => set((s) => ({ rows, x, y, openedAt, build: build ?? null, seq: s.seq + 1 })),
  refresh: () => {
    const { rows, build } = get();
    if (!rows || !build) return;
    const next = build();
    if (next.length > 0) set({ rows: next });
  },
  close: () => { if (get().rows) set({ rows: null, build: null }); },
}));

/** Rebuilds the open menu (`refresh`) whenever `subscribe`'s source changes: data a builder
 * reads that can arrive after the menu opened (the openers, the remotes). */
export function refreshMenuOn(subscribe: (fn: () => void) => () => void): () => void {
  return subscribe(() => useMenu.getState().refresh());
}

type MenuEventLike = { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number; timeStamp: number };

/** `onContextMenu` handler body: builds synchronously (no backend call, spec §7) and shows. The
 * native menu is suppressed even when there are no rows. */
export function openContextMenu(e: MenuEventLike, build: () => MenuRow[]): void {
  e.preventDefault();
  e.stopPropagation();
  const rows = build();
  if (rows.length > 0) useMenu.getState().show(rows, e.clientX, e.clientY, e.timeStamp || performance.now(), build);
}

/** Opens `rows` below `el` (hamburger button, header pin button). */
export function openMenuAt(el: Element, rows: MenuRow[]): void {
  const r = el.getBoundingClientRect();
  if (rows.length > 0) useMenu.getState().show(rows, r.left, r.bottom);
}
