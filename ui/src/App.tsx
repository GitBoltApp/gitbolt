import { useEffect, useState } from 'react';
import { api, errorMessage } from './api/client';
import { AppShell } from './app/AppShell';
import { installColumnPersistence } from './app/columnsPersistence';
import { installOpenRequests, openPendingRequests } from './app/instance';
import { type ActivityEntry, useOps } from './app/ops';
import { openPathInTab } from './app/runtime';
import { useGitCheck } from './errors/gitCheck';
import { flushSaves, useAppState } from './app/state';
import './graph/graph.css';

declare global {
  /** A test hook (harmless in production): e2e flushes the debounced saves before a reload, and
   * reads the activity log (K30: background fetches show nowhere else). */
  interface Window { __gb?: { flush: () => Promise<void>; setSettings: (patch: object) => void; activity: () => ActivityEntry[] } }
}

let booted: Promise<void> | null = null;

/**
 * Loads the settings and the active profile (its tabs come back, spec §6.2), then opens the
 * launch repos: `?repo=` (repeatable; how Playwright opens repos), else the app's
 * GITBOLT_OPEN / argv. Each opens in a new tab after the active one, or focuses the tab already
 * showing it. A later launch's path (the single-instance guard: queued, then `openRequested`)
 * opens the same way, once boot is done, including one forwarded before this page listened. Once per page (StrictMode runs effects twice).
 */
function boot(): Promise<void> {
  booted ??= (async () => {
    installColumnPersistence();
    installOpenRequests();
    // Test hook for the e2e harness (the dev server, or the `--mode e2e` build the suite serves);
    // compiled out of the release bundle.
    if (import.meta.env.DEV || import.meta.env.MODE === 'e2e') window.__gb = { flush: flushSaves, setSettings: (patch) => useAppState.getState().setSettings(patch), activity: () => useOps.getState().activity };
    window.addEventListener('pagehide', () => { void flushSaves(); });
    // The backend outlives a webview reload: forget what the previous page watched, before this
    // one watches its active tab (spec §4.4: only the active tab is watched).
    await api.unwatchAll().catch((e: unknown) => console.warn('[gitbolt] unwatchAll failed', errorMessage(e)));
    await useAppState.getState().load();
    // git too old or missing blocks the app (spec §5.5): the shell shows that screen, and no repo opens.
    await useGitCheck.getState().check();
    if (useGitCheck.getState().problem) return;
    const fromUrl = new URLSearchParams(location.search).getAll('repo');
    const paths = fromUrl.length ? fromUrl : [await api.launchRepo()].filter((p): p is string => !!p);
    for (const p of paths) await openPathInTab(p);
    useAppState.getState().setBooted();
    // A later launch's path forwarded before this page listened (startup, a reload).
    await openPendingRequests();
  })();
  return booted;
}

export function App() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    boot().catch((e: unknown) => setError(errorMessage(e)));
  }, []);
  return <AppShell error={error} />;
}
