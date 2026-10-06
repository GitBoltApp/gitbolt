import { useLayoutEffect, useState, type RefObject } from 'react';
import { INLINE_BREAKPOINT_PX } from './options';

/**
 * Whether `pane` is narrower than the text diff's Split breakpoint (`INLINE_BREAKPOINT_PX`, as
 * Monaco's `useInlineViewWhenSpaceIsLimited`): the rendered Markdown diff's Split then shows
 * Inline, as the text diff's does. Watched only while `watch` holds; a pane with no width yet
 * (hidden, or not laid out) isn't narrow.
 */
export function useNarrowPane(pane: RefObject<HTMLElement | null>, watch: boolean): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = pane.current;
    if (!watch || !el) return;
    const check = () => { const w = el.clientWidth; setNarrow(w > 0 && w < INLINE_BREAKPOINT_PX); };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pane, watch]);
  return narrow;
}
