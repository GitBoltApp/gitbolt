import { create } from 'zustand';
import type { RepoCtx } from '../app/repoContext';
import type { MenuRow } from '../menu/types';

/**
 * A toolbar button, by action id (ruling R10): the action (`registerActions`) gives it its icon,
 * tooltip, shortcut and what it runs, so each feature adds its button from its own module (Search
 * with find, Actions with the palette) and nobody edits `Toolbar.tsx`. A button whose action isn't
 * registered doesn't render (no placeholder UI).
 */
export type ToolbarPlacement = 'center' | 'end';

/** What a button shows for its tab right now, when that's more than its action says: the
 * undo tooltip and its disabled reason (spec #2 §5.5). */
export interface ButtonView {
  tooltip: string;
  disabled: boolean;
  /** The caption, when it follows state. */
  label?: string;
}

/** A split button's default picker (spec #2 §12.1): a heading over radio rows. Picking sets the
 * default and closes; it runs nothing. */
export interface ToolbarPicker {
  title: string;
  options: Array<{ value: string; label: string }>;
  /** A hook: the current value. */
  useValue: () => string;
  set: (value: string) => void;
}

export interface ToolbarButton {
  /** The action it runs. */
  action: string;
  /** The short caption under its icon; the action's label otherwise. */
  label?: string;
  /** Where it sits: 'center' (the default, between the two spacers) or 'end' (the far right edge). */
  placement?: ToolbarPlacement;
  /** Left to right within its placement, lower first. */
  order: number;
  /** A split button: these action ids are its dropdown, as menu rows. */
  menu?: string[];
  /** The caret opens this picker instead of a menu. */
  picker?: ToolbarPicker;
  /** The caret's rows, built from the snapshot when it opens (Push's upstream rows). */
  menuRows?: (ctx: RepoCtx) => MenuRow[];
  /** A hook: true while what the button starts is running for this tab (a spinner; disabled). */
  useBusy?: (ctx: RepoCtx) => boolean;
  /** A hook: an op this button starts waits in the queue (spec #2 §3.6): a small badge. */
  useQueued?: (ctx: RepoCtx) => boolean;
  /** A hook: the button's tooltip and whether it's disabled, for this tab (`null`: the action's).
   * A disabled view stays hoverable, so its reason shows. */
  useView?: (ctx: RepoCtx) => ButtonView | null;
}

export const useToolbarButtons = create<{ buttons: ToolbarButton[] }>(() => ({ buttons: [] }));

/** Adds a button; returns its removal (release it on a hot update, as `registerActions`). */
export function registerToolbarButton(b: ToolbarButton): () => void {
  useToolbarButtons.setState((s) => {
    if (s.buttons.some((x) => x.action === b.action)) throw new Error(`toolbar button ${b.action} is already registered`);
    return { buttons: [...s.buttons, b].sort((x, y) => x.order - y.order) };
  });
  return () => useToolbarButtons.setState((s) => ({ buttons: s.buttons.filter((x) => x !== b) }));
}
