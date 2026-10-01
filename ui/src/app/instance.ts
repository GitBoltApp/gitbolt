import { api, errorMessage, onEvent } from '../api/client';
import { openPathInTab } from './runtime';
import { useAppState } from './state';

/** Resolves once boot is done (settings and profile loaded, the launch repos opened). */
function whenBooted(): Promise<void> {
  if (useAppState.getState().booted) return Promise.resolve();
  return new Promise((resolve) => {
    const off = useAppState.subscribe((s) => {
      if (!s.booted) return;
      off();
      resolve();
    });
  });
}

const warn = (e: unknown) => { console.warn('[gitbolt] opening a path from another launch failed', errorMessage(e)); };

/**
 * Opens what later launches forwarded and nothing took yet. The backend returns each forwarded
 * path once, to whichever take comes first (this page's boot, or the `openRequested` that
 * announced it), so a path that both queued and was announced opens once. Each opens in a new
 * tab after the active one, or focuses the tab already showing it, as a launch path does at
 * boot; a failed one doesn't stop the rest.
 */
async function openPending(): Promise<void> {
  const paths = await api.takeOpenRequests();
  for (const path of new Set(paths)) await openPathInTab(path).catch(warn);
}

/**
 * The single-instance guard's UI side (1D R19): a second launch on this config dir hands its
 * launch path to this instance and exits; the backend queues it, emits `openRequested` and
 * brings the window to the front. On the event (once boot is done, so it lands after the
 * restored tabs) this takes the queue rather than trusting the event's path, so nothing opens
 * twice. Installed once, at the start of boot. A non-repo path fails the way any open does.
 */
export function installOpenRequests(): () => void {
  return onEvent((ev) => {
    if (ev.type !== 'openRequested') return;
    whenBooted().then(openPending).catch(warn);
  });
}

/** At the end of boot: the paths forwarded before this page listened (app startup, a reload). */
export function openPendingRequests(): Promise<void> {
  return openPending().catch(warn);
}
