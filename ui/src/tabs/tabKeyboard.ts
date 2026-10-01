/**
 * Roving tabindex on the tab strip (`role="tab"`, spec §6.2): only the active tab sits in the
 * page's normal Tab order (tabIndex 0; the rest -1). ArrowLeft/ArrowRight/Home/End move DOM
 * focus among the tabs (wrapping on the arrows) without changing which repo is active; Enter or
 * Space on the focused tab activates it. This is the standard WAI-ARIA tabs pattern, kept a pure
 * function (which tab index a key moves focus to) so `TabBar.tsx` only does the DOM/state work.
 */
export function nextTabFocus(count: number, from: number, key: string): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowRight': return (from + 1) % count;
    case 'ArrowLeft': return (from - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}
