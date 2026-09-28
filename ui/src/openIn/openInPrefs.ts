/**
 * The last opener used by "Open in…" (feedback H9), the default next time. The settings seam
 * until plan 1C's settings screen: localStorage, every access in try/catch (storage may be
 * unavailable), per browser profile.
 */
export const OPEN_IN_KEY = 'gitbolt.openIn.v1';

export function loadLastOpener(): string | null {
  try {
    const raw = localStorage.getItem(OPEN_IN_KEY);
    const last: unknown = raw === null ? null : (JSON.parse(raw) as { last?: unknown }).last;
    return typeof last === 'string' ? last : null;
  } catch {
    return null;
  }
}

export function saveLastOpener(id: string): void {
  try {
    localStorage.setItem(OPEN_IN_KEY, JSON.stringify({ last: id }));
  } catch {
    // Storage unavailable: the choice lasts for this session only.
  }
}
