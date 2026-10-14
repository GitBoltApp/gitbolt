// A deploy replaces the demo's hashed chunks, so a page loaded before it asks for files that are
// gone ("Unable to preload CSS for …"). Vite reports that as `vite:preloadError`: reload to pick
// up the new build, at most once every 30 seconds, so a chunk that's really missing can't loop.
const KEY = 'gitvolt.demo.staleReloadAt';
const GAP_MS = 30_000;

export function installStaleBuildReload(win: Window = window, now: () => number = Date.now): void {
  win.addEventListener('vite:preloadError', (e) => {
    try {
      const last = Number(win.sessionStorage.getItem(KEY));
      if (last && now() - last < GAP_MS) return;
      win.sessionStorage.setItem(KEY, String(now()));
    } catch {
      return;
    }
    e.preventDefault();
    win.location.reload();
  });
}

if (typeof window !== 'undefined') installStaleBuildReload();
