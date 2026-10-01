import { api, errorMessage } from '../api/client';
import { useAppState } from '../app/state';

const MAX_PER_MINUTE = 20;

/** window.onerror and unhandled rejections -> the backend log file (spec §16.2), rate-limited. */
export function installFrontendErrorLogging(log: typeof api.logFrontend = api.logFrontend, now: () => number = Date.now): () => void {
  let windowStart = now();
  let sent = 0;
  const send = (message: string, stack: string | null) => {
    const t = now();
    if (t - windowStart >= 60_000) {
      windowStart = t;
      sent = 0;
    }
    if (sent >= MAX_PER_MINUTE) return;
    sent++;
    void log('error', message, stack).catch(() => {});
  };
  const onError = (e: ErrorEvent) => send(e.message || errorMessage(e.error), e.error instanceof Error ? e.error.stack ?? null : null);
  const onRejection = (e: PromiseRejectionEvent) => send(`Unhandled rejection: ${errorMessage(e.reason)}`, e.reason instanceof Error ? e.reason.stack ?? null : null);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

/** Pushes Settings -> Advanced -> Debug logging to the backend at startup and on change. */
export function bindDebugLogging(): () => void {
  let last = false; // the backend starts at info
  const sync = (debug: boolean) => {
    if (debug === last) return;
    last = debug;
    void api.setDebugLogging(debug).catch(() => {});
  };
  sync(useAppState.getState().settings.debugLogging);
  return useAppState.subscribe((s) => sync(s.settings.debugLogging));
}
