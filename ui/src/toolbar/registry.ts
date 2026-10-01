import { create } from 'zustand';
import type { RepoCtx } from '../app/repoContext';

/**
 * A toolbar button, by action id (ruling R10): the action (`registerActions`) gives it its icon,
 * tooltip, shortcut and what it runs, so each feature adds its button from its own module (Search
 * with find, Actions with the palette) and nobody edits `Toolbar.tsx`. A button whose action isn't
 * registered doesn't render (no placeholder UI).
 */
export type ToolbarPlacement = 'center' | 'end';

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
  /** A hook: true while what the button starts is running for this tab (a spinner; disabled). */
  useBusy?: (ctx: RepoCtx) => boolean;
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
