import { useEffect, type RefObject } from 'react';
import { useRepoView, useRepoViewStore, type FocusZone } from './store';

/**
 * Focus areas (spec §11.1). The zone's element takes DOM focus on every focus request for its
 * zone (`setFocus`, even when the store already names it), unless focus is already inside it.
 * `focusTarget` picks the child that should get focus: a selector, or a function of the zone's
 * element (the files zone picks the list holding the open file). Any focus inside the element moves the store's focus to it. Plan 1C's sidebar
 * and palette use the same store action (`setFocus`).
 */
export function useFocusZone(zone: FocusZone, ref: RefObject<HTMLElement | null>, focusTarget?: string | ((el: HTMLElement) => HTMLElement | null)) {
  const store = useRepoViewStore();
  const focus = useRepoView((s) => s.focus);
  const request = useRepoView((s) => s.focusRequest);
  useEffect(() => {
    const el = ref.current;
    if (focus !== zone || !el || el.contains(document.activeElement)) return;
    const target = (typeof focusTarget === 'function' ? focusTarget(el) : focusTarget ? el.querySelector<HTMLElement>(focusTarget) : null) ?? el;
    target.focus({ preventScroll: true });
  }, [focus, request, zone, ref, focusTarget]);
  return {
    'data-focus-zone': zone,
    'data-zone-focused': focus === zone,
    // DOM focus arriving in the zone: sync the store (a request, so it only moves on a change).
    onFocus: () => {
      if (store.getState().focus !== zone) store.getState().setFocus(zone);
    },
  };
}
