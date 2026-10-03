/** File History's list column width (px): persisted in localStorage like the other panel prefs,
 * every access in try/catch (storage may be unavailable). */
export const LIST_W = { min: 220, max: 640, default: 360, key: 'gitbolt.historyListWidth.v1' } as const;

export const clampListW = (w: number) => Math.max(LIST_W.min, Math.min(LIST_W.max, Math.round(w)));

export function loadListW(): number {
  try {
    const raw = localStorage.getItem(LIST_W.key);
    const w = raw === null ? NaN : Number(raw);
    return Number.isFinite(w) ? clampListW(w) : LIST_W.default;
  } catch {
    return LIST_W.default;
  }
}

export function saveListW(w: number): void {
  try { localStorage.setItem(LIST_W.key, String(clampListW(w))); } catch { /* the width still holds for this view */ }
}
