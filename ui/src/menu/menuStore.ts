import { create } from 'zustand';
import type { MenuRow } from './types';
import { swallowGestureClick } from '../ui/swallowClick';

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
  /** The root level's starting row id (e.g. the default opener), same idea as a submenu's own
   * `initial` (plan 1C Task 15's `openMenuAt`, converting the diff header's Open in dropdown). */
  initialRow: string | null;
  /** The root menu's accessible name: a dropdown's purpose (`openMenuAt`'s `label`, e.g. the diff
   * header's "Open in"), else null for the generic "Context menu". */
  label: string | null;
  /** The element `openMenuAt` opened the menu below (null for a context menu): a press on it while
   * the menu is open toggles the menu closed (`pressedAnchor`). */
  anchor: Element | null;
  show(rows: MenuRow[], x: number, y: number, openedAt?: number, build?: () => MenuRow[], initialRow?: string, label?: string): void;
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
  initialRow: null,
  label: null,
  anchor: null,
  show: (rows, x, y, openedAt = performance.now(), build, initialRow, label) => set((s) => ({ anchor: null, rows, x, y, openedAt, build: build ?? null, initialRow: initialRow ?? null, label: label ?? null, seq: s.seq + 1 })),
  refresh: () => {
    const { rows, build } = get();
    if (!rows || !build) return;
    const next = build();
    if (next.length > 0) set({ rows: next });
  },
  close: () => { if (get().rows) set({ rows: null, build: null, anchor: null }); },
}));

/** Runs one chosen menu row (`id`, `label`) by calling `run`. */
export type MenuRowRunner = (id: string, label: string, run: () => void) => void;
const plainRun: MenuRowRunner = (_id, _label, run) => run();
let rowRunner: MenuRowRunner = plainRun;

/** The row-run hook (R11): the context menu runs every chosen row and variant through it, so the
 * action log can record it. One runner at a time; returns its removal. */
export function setMenuRowRunner(r: MenuRowRunner): () => void {
  rowRunner = r;
  return () => { if (rowRunner === r) rowRunner = plainRun; };
}
export const runMenuRowHook: MenuRowRunner = (id, label, run) => rowRunner(id, label, run);

/** Rebuilds the open menu (`refresh`) whenever `subscribe`'s source changes: data a builder
 * reads that can arrive after the menu opened (the openers, the remotes). */
export function refreshMenuOn(subscribe: (fn: () => void) => () => void): () => void {
  return subscribe(() => useMenu.getState().refresh());
}

export type MenuEventLike = { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number; timeStamp: number };

/** `onContextMenu` handler body: builds synchronously (no backend call, spec §7) and shows. The
 * native menu is suppressed even when there are no rows. */
export function openContextMenu(e: MenuEventLike, build: () => MenuRow[]): void {
  e.preventDefault();
  e.stopPropagation();
  const rows = build();
  if (rows.length > 0) useMenu.getState().show(rows, e.clientX, e.clientY, e.timeStamp || performance.now(), build);
}

/** Opens `rows` below `el` (hamburger button, header pin button, the diff header's Open in
 * dropdown). `initial`: the row id to start focus on (the default opener); omitted starts on the
 * first enabled row, as `openContextMenu` does. `build`, as `openContextMenu`'s: re-run by
 * `refresh()` when the data it reads arrives later (fix round 1, item 2: the diff header's Open
 * in dropdown needs this too, for H32's live re-detection, not only the file menu's submenu).
 * `label`: the menu's accessible name, what the dropdown is for (the diff header's "Open in", as
 * 1B's own popup was named); omitted, it's the generic "Context menu". */
export function openMenuAt(el: Element, rows: MenuRow[], initial?: string, build?: () => MenuRow[], label?: string): boolean {
  // A press on `el` just closed this menu (toggle): the click that follows must not reopen it.
  if (swallowed === el) return false;
  if (rows.length === 0) return false;
  const r = el.getBoundingClientRect();
  useMenu.getState().show(rows, r.left, r.bottom, performance.now(), build, initial, label);
  useMenu.setState({ anchor: el });
  // Keep `aria-expanded` accurate for as long as this menu is the open one.
  el.setAttribute('aria-expanded', 'true');
  const off = useMenu.subscribe((s) => {
    if (s.anchor === el) return;
    off();
    el.setAttribute('aria-expanded', 'false');
  });
  return true;
}

/** Whether the press that is being clicked just closed `el`'s menu. A caller that does async work
 * before `openMenuAt` (the Undo caret's prepare step) checks this at click time, before it awaits. */
export function pressClosedMenu(el: Element): boolean {
  return swallowed === el;
}

let swallowed: Element | null = null;

/** Called by the open menu's outside-press dismiss: a press on the element that opened it (the
 * toggle) closes the menu and the click that follows is swallowed, so clicking the button again
 * is a toggle, not close-then-reopen. Returns whether the press was on the anchor. */
export function pressedAnchor(target: EventTarget | null): boolean {
  const a = useMenu.getState().anchor;
  if (!a || !(target instanceof Node) || !a.contains(target)) return false;
  swallowed = a;
  // The click follows the press within the same gesture; a press that never clicks (dragged off)
  // must not swallow a later open, so the mark expires with the gesture's pointerup.
  const clear = () => { setTimeout(() => { if (swallowed === a) swallowed = null; }, 0); };
  window.addEventListener('pointerup', clear, { once: true, capture: true });
  window.addEventListener('pointercancel', clear, { once: true, capture: true });
  // And the click stops there: no handler on or above the trigger runs for it (the bell's
  // mark-as-read, a card's own click), not only the reopen `swallowed` prevents.
  swallowGestureClick((e) => e.target instanceof Node && a.contains(e.target));
  return true;
}
