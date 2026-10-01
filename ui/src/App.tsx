import { useEffect, useState } from 'react';
import { api, errorMessage } from './api/client';
import { AppShell } from './app/AppShell';
import { installColumnPersistence } from './app/columnsPersistence';
import { openPathInTab } from './app/runtime';
import { flushSaves, useAppState } from './app/state';
import './graph/graph.css';

declare global {
  /** A test hook (harmless in production): e2e flushes the debounced saves before a reload. */
  interface Window { __gb?: { flush: () => Promise<void>; setSettings: (patch: object) => void } }
}

let booted: Promise<void> | null = null;

/**
 * Loads the settings and the active profile (its tabs come back, spec §6.2), then opens the
 * launch repos: `?repo=` (repeatable; how Playwright opens repos), else the app's
 * GITBOLT_OPEN / argv. Each opens in a new tab after the active one, or focuses the tab already
 * showing it. Once per page (StrictMode runs effects twice).
 */
function boot(): Promise<void> {
  booted ??= (async () => {
    installColumnPersistence();
    window.__gb = { flush: flushSaves, setSettings: (patch) => useAppState.getState().setSettings(patch) };
    window.addEventListener('pagehide', () => { void flushSaves(); });
    // The backend outlives a webview reload: forget what the previous page watched, before this
    // one watches its active tab (spec §4.4: only the active tab is watched).
    await api.unwatchAll().catch((e: unknown) => console.warn('[gitbolt] unwatchAll failed', errorMessage(e)));
    await useAppState.getState().load();
    const fromUrl = new URLSearchParams(location.search).getAll('repo');
    const paths = fromUrl.length ? fromUrl : [await api.launchRepo()].filter((p): p is string => !!p);
    for (const p of paths) await openPathInTab(p);
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
