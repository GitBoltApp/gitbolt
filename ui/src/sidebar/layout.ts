/** Pure layout for the sidebar's stacked panels (spec §6.4). Panels keep their fixed order; a
 * collapsed panel is just its header, in place; the expanded ones share the rest of the height. */
export const HEADER_H = 26;
export const ROW_H = 24;
export const MIN_ROWS = 3;
/** The least an expanded panel can be: its header plus about three rows. */
export const MIN_PANEL_H = HEADER_H + MIN_ROWS * ROW_H;
/** Tree rows (K61): no caret, so every row starts with a 13px icon slot; a depth step is the slot
 * plus the 6px gap, which puts a child's icon exactly under its parent's name. */
export const ICON_W = 13;
export const ROW_GAP = 6;
export const ROW_PAD = 8;
export const INDENT_STEP = ICON_W + ROW_GAP;
/** Left padding of a tree row at `depth` (1-based); folder and leaf rows share it, so their icons align. */
export const rowIndent = (depth: number) => ROW_PAD + (Math.max(1, depth) - 1) * INDENT_STEP;
const DEFAULT_WEIGHT = 200;

export interface PanelSpec { id: string; collapsed: boolean; /** Last resized height, if any. */ weight?: number }

/**
 * Heights (px, one per panel, same order) for `avail` px of vertical space. Collapsed panels get
 * the header height; expanded ones split what is left in proportion to their weights (a panel
 * never resized takes the average of those that were), none below MIN_PANEL_H. If even the
 * minimums don't fit, the expanded panels share the space evenly (down to a header each). Otherwise the
 * heights sum to exactly `avail`.
 */
export function layoutPanels(avail: number, panels: PanelSpec[]): number[] {
  const open = panels.filter((p) => !p.collapsed);
  const space = Math.max(0, avail - (panels.length - open.length) * HEADER_H);
  const known = open.filter((p) => p.weight !== undefined).map((p) => p.weight!);
  const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : DEFAULT_WEIGHT;
  const w = (p: PanelSpec) => p.weight ?? fallback;
  const heights = new Map<string, number>();
  if (open.length) {
    if (space <= open.length * MIN_PANEL_H) {
      // Too short for the minimums: shrink the expanded panels evenly (never under a header) so
      // the stack still fits exactly; only a panel's own body scrolls.
      let left = space;
      open.forEach((p, i) => {
        const h = i === open.length - 1 ? Math.max(HEADER_H, left) : Math.max(HEADER_H, Math.floor(left / (open.length - i)));
        left -= h;
        heights.set(p.id, h);
      });
    }
    else {
      // Pin panels whose proportional share is under the minimum; share the rest among the others.
      let free = open.slice();
      let left = space;
      for (;;) {
        const total = free.reduce((a, p) => a + w(p), 0);
        const small = free.filter((p) => (left * w(p)) / total < MIN_PANEL_H);
        if (!small.length) {
          let used = 0;
          free.forEach((p, i) => {
            const h = i === free.length - 1 ? left - used : Math.floor((left * w(p)) / total);
            used += h;
            heights.set(p.id, h);
          });
          break;
        }
        for (const p of small) { heights.set(p.id, MIN_PANEL_H); left -= MIN_PANEL_H; }
        free = free.filter((p) => !small.includes(p));
        if (!free.length) break;
      }
    }
  }
  return panels.map((p) => (p.collapsed ? HEADER_H : heights.get(p.id)!));
}

/** For each panel, the index of the panel its bottom divider trades height with: the next
 * expanded panel below an expanded one (collapsed headers in between are skipped), else null. */
export function dividerTargets(panels: PanelSpec[]): (number | null)[] {
  return panels.map((p, i) => {
    if (p.collapsed) return null;
    const j = panels.findIndex((q, k) => k > i && !q.collapsed);
    return j < 0 ? null : j;
  });
}

/** Moves a divider by `delta` px (positive = down): `upper` grows, `lower` shrinks by the same
 * amount, clamped so neither goes under MIN_PANEL_H. Returns the new [upper, lower]. */
export function resizePair(upper: number, lower: number, delta: number): [number, number] {
  const d = Math.max(MIN_PANEL_H - upper, Math.min(lower - MIN_PANEL_H, Math.round(delta)));
  return [upper + d, lower - d];
}
