import { useEffect, useRef } from 'react';
import { zoomDirection } from './zoom';

/**
 * The app's one window-level keydown dispatcher. Every key the app takes before the page's own
 * handlers (Monaco, the lists, …) goes through it, in a fixed order of layers:
 *
 * 1. `menu`: an open menu. The context menu (`ContextMenu`) takes every key, wherever the focus
 *    is (plan 1C Task 15, Amendment 11: the diff toolbar's Open in… dropdown is this same menu
 *    now, not a dropdown of its own). Any other shown `[role="menu"]`, or a key pressed inside
 *    one, keeps the key for that menu's own handler (built in below).
 * 2. `tooltip`: a shown tooltip (`HoverTooltip`, `TooltipHost`): Esc dismisses it (WCAG 1.4.13).
 * 3. `overlay`: an editor overlay (Monaco's find widget, context menu, hovers, …) claims Esc
 *    pressed in its own area (`useEscapeOwner`), and Monaco then closes it.
 * 4. `app`: the app's actions: Esc closes the file or leaves compare mode (`useAppEscape`),
 *    F7 / Shift+F7 / Shift+↑↓ step the changes (`useChangeKeys`), Ctrl+= / - / 0 zoom.
 *
 * Zoom (H2) is the one exception to "the menu layer sees it first": it skips the menu layer
 * entirely, so it works whatever has focus, a shown menu included (`dispatch`, below).
 *
 * The first layer where a handler claims the key decides it; no lower layer sees it. Within a
 * layer every handler is offered the key (they claim disjoint keys, or, like two tooltips, both
 * act), so neither the order of the layers nor their outcome depends on which component
 * registered first.
 *
 * A handler returns:
 * - `'handled'`: it acted. The key stops here (`stopPropagation`): no lower layer, and no handler
 *   in the page, sees it. The handler decides on `preventDefault`.
 * - `'native'`: the key belongs to the element it was pressed in (a menu's own handler, Monaco's
 *   find widget). No lower layer sees it, but the event carries on to its target.
 * - nothing: not its key.
 *
 * Plan 1C's Ctrl+F search box, tab keys, … register here too, in the layer they belong to.
 */
export type KeyLayer = 'menu' | 'tooltip' | 'overlay' | 'app';
export const KEY_LAYERS: readonly KeyLayer[] = ['menu', 'tooltip', 'overlay', 'app'];
export type KeyClaim = 'handled' | 'native';
export type KeyHandler = (e: KeyboardEvent) => KeyClaim | undefined | void | false;

const handlers = new Map<KeyLayer, Set<KeyHandler>>(KEY_LAYERS.map((l) => [l, new Set()]));

const isShown = (el: Element) => el.getClientRects().length > 0;

/** Built into the menu layer: a shown menu other than the context menu (which registers its own
 * handler), or a key pressed inside one, keeps the key for that menu. */
export const shownMenuKeepsKeys: KeyHandler = (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (t?.closest('[role="menu"]') || [...document.querySelectorAll('[role="menu"]')].some(isShown)) return 'native';
};

function claimIn(layer: KeyLayer, e: KeyboardEvent): KeyClaim | null {
  let claim: KeyClaim | null = layer === 'menu' ? (shownMenuKeepsKeys(e) || null) : null;
  for (const h of [...handlers.get(layer)!]) {
    const r = h(e);
    if (r === 'handled') claim = 'handled';
    else if (r === 'native' && claim === null) claim = 'native';
  }
  return claim;
}

function dispatch(e: KeyboardEvent) {
  for (const layer of KEY_LAYERS) {
    // H2: zoom (Ctrl+=/-/0) works whatever has focus, an open menu included — it skips the menu
    // layer entirely (both the built-in `shownMenuKeepsKeys` catch-all and a menu's own handler,
    // e.g. ContextMenu's, which otherwise claims every key while open) and falls through to the
    // app layer's zoom handler below.
    if (layer === 'menu' && zoomDirection(e) !== null) continue;
    const claim = claimIn(layer, e);
    if (claim === 'handled') e.stopPropagation();
    if (claim) return;
  }
}

let installed = false;

/** Adds `handler` to `layer`; returns its removal. The dispatcher is on `window` (capture phase)
 * while any handler is registered. */
export function registerKeys(layer: KeyLayer, handler: KeyHandler): () => void {
  handlers.get(layer)!.add(handler);
  if (!installed) {
    window.addEventListener('keydown', dispatch, true);
    installed = true;
  }
  return () => {
    handlers.get(layer)!.delete(handler);
    if (installed && [...handlers.values()].every((s) => s.size === 0)) {
      window.removeEventListener('keydown', dispatch, true);
      installed = false;
    }
  };
}

/** `registerKeys` for a component, while it's mounted (and its effects live: not while a hidden
 * `<Activity>` holds it). The latest `handler` is called (no need to keep it stable), and only
 * while `on` as of the latest render: registered once, not per `on` change, so a key pressed
 * right after the render that turned it on is taken even before that render's effects run. */
export function useKeys(layer: KeyLayer, handler: KeyHandler, on = true): void {
  const latest = useRef(handler);
  latest.current = handler;
  const enabled = useRef(on);
  enabled.current = on;
  useEffect(() => registerKeys(layer, (e) => (enabled.current ? latest.current(e) : undefined)), [layer]);
}
