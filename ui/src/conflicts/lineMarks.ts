// Pure parts of the merge editors' minimap / overview-ruler marks and per-line hover (editors.ts).
import type { Side } from './model';

/** Monaco's `MinimapPosition.Inline` and `OverviewRulerLane.Full`. */
const MINIMAP_INLINE = 1;
const RULER_FULL = 7;

export interface MarkColors { current: string; incoming: string; base: string }

/** The theme's conflict colours as real colour strings (Monaco can't take `var(--x)`). */
export function resolveMarkColors(root: Element = document.documentElement): MarkColors {
  const cs = getComputedStyle(root);
  const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return { current: get('--conflict-ours', '#15a0bf'), incoming: get('--conflict-theirs', '#f2ca33'), base: get('--conflict-base', '#c517b6') };
}

/** `color` dimmed (half alpha) when it's a #rrggbb; anything else is left as it is. */
export function dimmed(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}80` : color;
}

/** The minimap and overview-ruler marks of one region line. In a pane, its side's colour; in the
 * output, the base colour, bright while the conflict is unresolved and dimmer once resolved. */
export function regionMarks(colors: MarkColors, kind: Side | 'unresolved' | 'resolved') {
  const color = kind === 'current' || kind === 'incoming' ? colors[kind] : kind === 'unresolved' ? colors.base : dimmed(colors.base);
  return { minimap: { color, position: MINIMAP_INLINE }, overviewRuler: { color, position: RULER_FULL } };
}

/** Tracks the pointer's line in one pane: `onChange` runs only when the line does. */
export function createHoverTracker(onChange: (line: number | null) => void) {
  let line: number | null = null;
  const set = (next: number | null) => {
    if (next === line) return;
    line = next;
    onChange(next);
  };
  return { move: (lineNumber: number | null | undefined) => set(lineNumber ?? null), leave: () => set(null), current: () => line };
}
