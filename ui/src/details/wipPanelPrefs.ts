/**
 * The WIP panel's layout (K36): the Unstaged section's share of the two lists' height while both
 * are expanded, and which sections are collapsed. One localStorage key, every access in
 * try/catch (storage may be unavailable); Path/Tree is not here, it's the file list's own pref.
 */
export interface WipPanelPrefs { ratio: number; collapsed: { unstaged: boolean; staged: boolean; conflicted: boolean } }
export const WIP_PANEL = { key: 'gitbolt.wipPanel.v1', defaultRatio: 0.5, step: 0.05, minRows: 3, chromePx: 64 } as const;
export const DEFAULT_WIP_PANEL: WipPanelPrefs = { ratio: WIP_PANEL.defaultRatio, collapsed: { unstaged: false, staged: false, conflicted: false } };

/** The ratio's range: each section keeps its header and toolbar (`chromePx`) plus `minRows` rows
 * of `rowH`. Unmeasured, 0.1-0.9; when both can't fit, an even split. */
export function wipSplitBounds(heightPx: number, rowH: number): [number, number] {
  if (heightPx <= 0) return [0.1, 0.9];
  const lo = (WIP_PANEL.chromePx + WIP_PANEL.minRows * rowH) / heightPx;
  return lo >= 0.5 ? [0.5, 0.5] : [lo, 1 - lo];
}

export function loadWipPanel(): WipPanelPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(WIP_PANEL.key) ?? 'null') as Partial<WipPanelPrefs> | null;
    if (typeof raw !== 'object' || raw === null) return DEFAULT_WIP_PANEL;
    const ratio = typeof raw.ratio === 'number' && Number.isFinite(raw.ratio) ? Math.max(0.05, Math.min(0.95, raw.ratio)) : WIP_PANEL.defaultRatio;
    return { ratio, collapsed: { unstaged: raw.collapsed?.unstaged === true, staged: raw.collapsed?.staged === true, conflicted: raw.collapsed?.conflicted === true } };
  } catch {
    return DEFAULT_WIP_PANEL;
  }
}

export function saveWipPanel(p: WipPanelPrefs): void {
  try {
    localStorage.setItem(WIP_PANEL.key, JSON.stringify({ ...p, ratio: Math.round(p.ratio * 1e4) / 1e4 }));
  } catch {
    // Storage unavailable: the layout holds for this window.
  }
}
