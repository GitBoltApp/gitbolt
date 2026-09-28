import { create } from 'zustand';

/**
 * The shared imperative tooltip (plan 1C Task 10): one `<TooltipHost />` element per page,
 * driven from anywhere with `showTooltip`/`hideTooltip`. For controls that are built from data
 * rather than wrapped one by one (the context menu's rows and variant buttons). Components
 * that wrap a trigger use `HoverTooltip`/`useHoverTooltip`, which looks and places the same.
 *
 * `placement`: `'below'` (flipped above at the window's bottom), or `'right'`/`'left'` (beside
 * the target, flipped to the other side at the window's edge), so a menu row's tooltip never
 * covers the rows under it.
 */
export type TooltipPlacement = 'below' | 'right' | 'left';
export interface Tip { text: string; rect: DOMRect; placement: TooltipPlacement }

export const useTooltip = create<{ tip: Tip | null }>(() => ({ tip: null }));

let timer: ReturnType<typeof setTimeout> | undefined;

/** Shows `text` next to `target`: immediately by default (the app-wide rule, spec §7), after
 * `delay` ms if given. */
export function showTooltip(target: Element, text: string, delay = 0, placement: TooltipPlacement = 'below'): void {
  clearTimeout(timer);
  const show = () => useTooltip.setState({ tip: { text, rect: target.getBoundingClientRect(), placement } });
  if (delay > 0) timer = setTimeout(show, delay);
  else show();
}

export function hideTooltip(): void {
  clearTimeout(timer);
  if (useTooltip.getState().tip) useTooltip.setState({ tip: null });
}
