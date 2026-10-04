import type { ComponentType, LazyExoticComponent } from 'react';
import { create } from 'zustand';

/**
 * The left flyout (spec #4 §5): one panel per repository tab, opening just right of the left
 * sidebar, over the graph (which stays usable beside it), width-limited and resizable within
 * bounds, closed by Esc or ×. The MR/PR view (4B) and Create MR/PR (4C) are flyouts: a feature
 * registers its component under a kind at import time, and anything opens it in a tab with props.
 * Opening another replaces the open one. `FlyoutFrame` is its frame; `FlyoutHost` (the tab slot
 * `centerOverlay`) places it and owns Esc, the resize handle and the focus.
 */
export interface FlyoutProps<P> { tabId: string; props: P; close(): void }
export type FlyoutComponent<P> = ComponentType<FlyoutProps<P>> | LazyExoticComponent<ComponentType<FlyoutProps<P>>>;
export interface OpenFlyout { kind: string; props: unknown; seq: number }

/** Its width bounds (px); the profile's `flyoutWidth`, else `default`, is the preferred one. */
export const FLYOUT_W = { min: 360, default: 560, max: 760 } as const;
/** What the center keeps beside it, so the graph stays usable. */
export const CENTER_KEEP = 240;

const components = new Map<string, FlyoutComponent<unknown>>();
const useFlyouts = create<{ byTab: Record<string, OpenFlyout> }>(() => ({ byTab: {} }));
/** Where the focus was when each tab's flyout opened. */
const returnTo = new Map<string, HTMLElement>();
let seq = 0;
const hotReloading = () => import.meta.env.DEV && import.meta.env.MODE !== 'test';

/** Registers `Component` as flyout `kind`; returns its removal. */
export function registerFlyout<P>(kind: string, Component: FlyoutComponent<P>): () => void {
  if (components.has(kind) && !hotReloading()) throw new Error(`flyout ${kind} is already registered`);
  components.set(kind, Component as FlyoutComponent<unknown>);
  return () => {
    if (components.get(kind) === (Component as unknown)) components.delete(kind);
  };
}

export const flyoutComponent = (kind: string): FlyoutComponent<unknown> | undefined => components.get(kind);

/** Opens flyout `kind` in tab `tabId` (a fresh mount), replacing the one open there. */
export function openFlyout<P>(tabId: string, kind: string, props: P): void {
  if (!components.has(kind)) throw new Error(`no flyout ${kind}`);
  const active = document.activeElement;
  if (!useFlyouts.getState().byTab[tabId] && active instanceof HTMLElement && active !== document.body) returnTo.set(tabId, active);
  useFlyouts.setState((s) => ({ byTab: { ...s.byTab, [tabId]: { kind, props, seq: ++seq } } }));
}

/** Closes it; the focus goes back where it was when it opened, if it was inside the flyout. */
export function closeFlyout(tabId: string): void {
  if (!useFlyouts.getState().byTab[tabId]) return;
  const inside = document.activeElement instanceof Element && document.activeElement.closest('[data-flyout]') !== null;
  useFlyouts.setState((s) => {
    const byTab = { ...s.byTab };
    delete byTab[tabId];
    return { byTab };
  });
  const back = returnTo.get(tabId);
  returnTo.delete(tabId);
  if (inside && back?.isConnected) back.focus({ preventScroll: true });
}

export const flyoutOf = (tabId: string): OpenFlyout | null => useFlyouts.getState().byTab[tabId] ?? null;
export const useFlyout = (tabId: string): OpenFlyout | null => useFlyouts((s) => s.byTab[tabId] ?? null);

/** Its width for a `preferred` one (null: the default) in a center `room` px wide: within
 * FLYOUT_W and leaving CENTER_KEEP px beside it; in a center too narrow for both, the least of
 * FLYOUT_W.min and the room. */
export function flyoutWidth(preferred: number | null, room: number): number {
  const want = Math.min(FLYOUT_W.max, Math.max(FLYOUT_W.min, preferred ?? FLYOUT_W.default));
  const fits = Math.min(want, room - CENTER_KEEP);
  return Math.round(Math.max(fits, Math.min(FLYOUT_W.min, room)));
}
