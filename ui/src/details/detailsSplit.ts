/**
 * The details panel's split between the header+message and the file list (feedback F13): the
 * top section's share of the panel's height.
 *
 * - `default`: about 25 % top, 75 % file list; `min`/`max` bound the ratio itself.
 * - `topExtraPx`: what the top keeps beyond the header (its padding and a couple of message
 *   lines); `bottomPx`: the least the file list keeps.
 * - Persisted in localStorage (`key`), like the diff prefs: per browser profile, surviving a
 *   reload, with every access in try/catch (storage may be unavailable).
 */
export const SPLIT = { default: 0.25, min: 0.1, max: 0.75, step: 0.02, topExtraPx: 56, bottomPx: 160, key: 'gitbolt.detailsSplit.v1' } as const;

export const clampSplit = (r: number) => Math.max(SPLIT.min, Math.min(SPLIT.max, r));

/** The ratio's range for a panel `panelPx` tall whose header is `headerPx`: the header plus
 * `topExtraPx` above, `bottomPx` below. Unmeasured (0), the plain range. Never empty: when both
 * can't fit, the file list wins. */
export function splitBounds(panelPx: number, headerPx: number): [number, number] {
  if (panelPx <= 0) return [SPLIT.min, SPLIT.max];
  const hi = Math.min(SPLIT.max, 1 - SPLIT.bottomPx / panelPx);
  const lo = Math.max(SPLIT.min, (headerPx + SPLIT.topExtraPx) / panelPx);
  return [Math.min(lo, hi), hi];
}

export function loadSplit(): number {
  try {
    const raw = localStorage.getItem(SPLIT.key);
    const r = raw === null ? NaN : Number(raw);
    return Number.isFinite(r) ? clampSplit(r) : SPLIT.default;
  } catch {
    return SPLIT.default;
  }
}

export function saveSplit(r: number): void {
  try {
    localStorage.setItem(SPLIT.key, String(Math.round(r * 1e4) / 1e4));
  } catch {
    // Storage unavailable: the ratio still holds for this panel.
  }
}
