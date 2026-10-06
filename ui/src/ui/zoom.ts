import { create } from 'zustand';
import { registerKeys } from './keyRouter';
import { registerKeyHints } from '../shortcuts/hints';

/**
 * App zoom (spec §12.2): Ctrl+= / Ctrl++ zoom in, Ctrl+- out, Ctrl+0 resets, through the stepped
 * levels below. The webview's own zoom does the scaling (`setZoom`, which CEF turns into
 * `SetZoomLevel`); Chrome's own zoom accelerators stay off (`zoom_hotkeys_enabled` is false in the
 * CEF runtime), so these keys are the app's alone.
 *
 * Chrome keeps a zoom level per origin in its profile. GitBolt's saved step is the source of
 * truth: it's re-applied at startup, 100% included.
 *
 * The saved step stays in localStorage (plan 1C ruling R4), so it applies before the first paint;
 * `useZoom` mirrors it for the status bar.
 */
export const ZOOM_STEPS = [80, 90, 100, 110, 120, 130, 140, 150, 175, 200, 250, 300] as const;
export const ZOOM_STORAGE_KEY = 'gitbolt.zoom.v1';

/** The step after `current` in direction `dir` (1 in, -1 out), clamped at both ends; `0` resets
 * to 100. A value between steps moves to the nearest step in that direction. */
export function nextZoom(current: number, dir: 1 | -1 | 0): number {
  if (dir === 0) return 100;
  if (dir === 1) return ZOOM_STEPS.find((s) => s > current) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((s) => s < current) ?? ZOOM_STEPS[0];
}

/** A stored value → its step; anything that isn't one of the steps is `null`. */
export function parseZoom(raw: string | null): number | null {
  const n = Number(raw);
  return raw !== null && (ZOOM_STEPS as readonly number[]).includes(n) ? n : null;
}

/** The zoom a keydown asks for: 1 (in), -1 (out), 0 (reset), or null for any other key. Shift is
 * allowed, since Ctrl++ is Ctrl+Shift+= on most layouts. */
export function zoomDirection(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'metaKey'>): 1 | -1 | 0 | null {
  if (!e.ctrlKey || e.altKey || e.metaKey) return null;
  if (e.key === '=' || e.key === '+' || e.code === 'NumpadAdd') return 1;
  if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') return -1;
  if (e.key === '0' || e.code === 'Numpad0') return 0;
  return null;
}

/** Marks a file's or a diff's body: there, the zoom keys and Ctrl+wheel change its text size
 * instead (diff/fontZoom.ts), and the app zoom leaves them alone. */
export const FONT_ZOOM_ATTR = 'data-font-zoom';
export const inFontZoomPanel = (t: EventTarget | null): boolean => t instanceof Element && t.closest(`[${FONT_ZOOM_ATTR}]`) !== null;

const load = (): number => {
  try {
    return parseZoom(globalThis.localStorage.getItem(ZOOM_STORAGE_KEY)) ?? 100;
  } catch {
    return 100;
  }
};

const save = (pct: number) => {
  try {
    globalThis.localStorage.setItem(ZOOM_STORAGE_KEY, String(pct));
  } catch {
    // Blocked or full storage: the zoom lasts as long as the window.
  }
};

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Sets the webview's zoom. Outside Tauri (the browser e2e harness) there's no webview to zoom:
 * a no-op, and `html[data-zoom]` (set for both) is what the tests read. */
export function applyWebviewZoom(pct: number): void {
  if (!inTauri()) return;
  void import('@tauri-apps/api/webview')
    .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(pct / 100))
    .catch((e: unknown) => console.warn('[gitbolt] zoom failed', e));
}

/**
 * The current zoom step, for what shows it (the status bar, spec §6.5). The step itself still
 * lives in localStorage (ruling R4: it must apply before the first paint); this only mirrors it.
 */
export const useZoom = create<{ zoom: number }>(() => ({ zoom: load() }));

let applyZoom: (pct: number) => void = applyWebviewZoom;

function show(pct: number) {
  useZoom.setState({ zoom: pct });
  document.documentElement.dataset.zoom = String(pct);
  applyZoom(pct);
}

/** Zooms to `pct` (one of `ZOOM_STEPS`) and saves it: the status bar's step list (spec §12.3). */
export function setZoom(pct: number): void {
  show(pct);
  save(pct);
}

/**
 * Installs the zoom keys and the Ctrl+wheel guard on `window`, and applies the saved step. The
 * keys are app actions in the key router (`keyRouter.ts`, capture phase), so the editor never
 * sees them, and (H2) they work even with a menu open: the router routes zoom past the menu
 * layer, the one exception to "an open menu takes every key first". Ctrl+wheel (and a touchpad
 * pinch, which arrives as one) is cancelled so the webview never zooms itself; a component with
 * its own Ctrl+wheel (the image diff) still gets the event. Returns the uninstaller.
 */
export function installZoom(apply: (pct: number) => void = applyWebviewZoom): () => void {
  applyZoom = apply;
  show(load());
  const onKeyDown = (e: KeyboardEvent) => {
    const dir = zoomDirection(e);
    // Over a file's or a diff's body, the keys size its text (diff/fontZoom.ts).
    if (dir === null || inFontZoomPanel(e.target)) return;
    e.preventDefault();
    setZoom(nextZoom(useZoom.getState().zoom, dir));
    return 'handled' as const;
  };
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey) e.preventDefault();
  };
  const offKeys = registerKeys('app', onKeyDown);
  window.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => {
    applyZoom = applyWebviewZoom;
    offKeys();
    window.removeEventListener('wheel', onWheel, { capture: true });
  };
}

// Shown in the Keyboard Shortcuts panel (Ctrl+/); metadata only.
registerKeyHints([
  { id: 'key.zoomIn', section: 'Navigation', label: 'Zoom in', keys: ['Ctrl+='], source: 'ui/zoom.ts' },
  { id: 'key.zoomOut', section: 'Navigation', label: 'Zoom out', keys: ['Ctrl+-'], source: 'ui/zoom.ts' },
  { id: 'key.zoomReset', section: 'Navigation', label: 'Reset zoom', keys: ['Ctrl+0'], source: 'ui/zoom.ts' },
]);
