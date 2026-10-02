import { useEffect } from 'react';
import { api, errorMessage } from '../api/client';
import type { GbError } from '../api/gen/GbError';
import { ERROR_TOAST_MS, useToast } from '../ui/toast';
import { showServerResult } from '../sync/serverOutput';
import { openActivityLog } from './activityLog';
import { useOps } from './ops';
import { platform } from './platform';
import { useRuntime } from './runtime';
import { clampFetchInterval } from '../settings/schema';
import { useAppState } from './state';

export interface FetchDeps {
  now(): number;
  /** ms epoch of the tab's last fetch attempt; 0 = never. */
  lastFetchAt(): number;
  isMinimized(): Promise<boolean>;
  fetch(): Promise<void>;
}

export const FETCH_SKIPPED_AUTH = 'Fetch skipped: authentication required';

/**
 * Spec §15's timing rules, independent of React so they're unit-testable with fake timers:
 * - started (the tab became active): one fetch at once if the last one is older than the interval;
 * - then one every interval;
 * - a tick while the window is minimized is skipped, and replayed once when the window gets the
 *   focus back. CEF has no minimize event, so each tick asks (`isMinimized`), and the focus event
 *   is what tells the window is back. Visible but unfocused, the ticks go on;
 * - an interval of 0 (or less) is off.
 */
export class FetchScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private missed = false;
  private running = false;
  private readonly intervalMs: number;
  private readonly deps: FetchDeps;

  constructor(intervalMs: number, deps: FetchDeps) {
    this.intervalMs = intervalMs;
    this.deps = deps;
  }

  start(): void {
    if (this.intervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    if (this.deps.now() - this.deps.lastFetchAt() >= this.intervalMs) void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.missed = false;
  }

  async tick(): Promise<void> {
    // A fetch still in flight (a slow remote): this tick adds nothing.
    if (!this.timer || this.running) return;
    const minimized = await this.deps.isMinimized();
    // Stopped while asking (the tab was hidden or closed): it does no more work.
    if (!this.timer || this.running) return;
    if (minimized) {
      this.missed = true;
      return;
    }
    await this.run();
  }

  /** The window's focus changed: back from minimized, one fetch if a tick was skipped meanwhile. */
  onFocus(focused: boolean): void {
    if (focused && this.missed && this.timer && !this.running) void this.run();
  }

  /** One fetch, which also makes up for any skipped tick. */
  private async run(): Promise<void> {
    this.running = true;
    this.missed = false;
    try {
      await this.deps.fetch();
    } finally {
      this.running = false;
    }
  }
}

/** Repos (by id) whose last fetch failed: a background failure reaches the bell only when it
 * starts, not on every tick of an outage (K30). */
const failing = new Set<number>();

/**
 * One fetch of the tab's repo (spec §15). `background`: the scheduler's, which never prompts
 * (§5.4) and shows nothing while it runs or when it succeeds: it's only in the activity log (K30,
 * `useOps().activity`). A fetch that would need credentials comes back skipped and shows as a
 * status-bar warning until a fetch succeeds. Errors: a background one goes to the bell's history
 * (once, when the failures start), a user's to a toast with git's message and an "Activity log"
 * link (§16.1, K96); a fetch that worked says nothing (7c303cc), a failure still toasts. A cancel is quiet. A user's fetch
 * that finds a background one running waits on that one: the Fetch button shows it as busy.
 */
export async function runFetch(tabId: string, background: boolean): Promise<void> {
  const rt = useRuntime.getState().tabs[tabId];
  if (!rt?.repo) return;
  const repo = rt.repo;
  const patch = (p: { lastFetchAt?: number; fetchSkipped?: string | null }) => {
    // The tab may have been closed (or re-pointed) while the fetch ran.
    if (useRuntime.getState().tabs[tabId]?.repo?.id === repo.id) useRuntime.getState().patch(tabId, p);
  };
  try {
    const out = await api.fetch(repo.id, background);
    if (out.status === 'done' || out.reason === 'authRequired') failing.delete(repo.id);
    if (out.status === 'done') {
      // A fetch that worked says nothing (except a user's with server output, which links it, and a server warning, spec #2 §12.4), user-initiated or not: the button's spinner and the
      // graph are enough, and a toast every time is noise (the user's call, after K96).
      patch({ lastFetchAt: Date.now(), fetchSkipped: null });
      if (!background && out.server.lines > 0) showServerResult(`Fetched ${repo.name}`, `Fetched ${repo.name}; the server reported a problem`, out.server, out.op);
      else if (background && out.server.warning) showServerResult('', `Background fetch of ${repo.name}: the server reported a problem`, out.server, out.op);
    } else if (out.reason === 'authRequired') patch({ lastFetchAt: Date.now(), fetchSkipped: FETCH_SKIPPED_AUTH });
    else if (!background) {
      const running = Object.values(useOps.getState().ops).find((o) => o.kind === 'fetch' && o.repo === repo.id);
      if (running) useOps.getState().showOp(running.op);
      else useToast.getState().show('A fetch is already running');
    }
  } catch (e) {
    patch({ lastFetchAt: Date.now() });
    const kind = (e as GbError | null)?.kind;
    if (kind === 'Cancelled') return;
    // git's own first line for a rejected credential is the server's ("remote: authentication
    // required"); the kind says what happened.
    const text = kind === 'AuthFailed' ? `Authentication failed (${errorMessage(e)})` : errorMessage(e);
    const started = !failing.has(repo.id);
    failing.add(repo.id);
    // K96: long enough to read git's message, with the activity log (which keeps it) a click away.
    if (!background) useToast.getState().show(`Fetch failed: ${text}`, { ms: ERROR_TOAST_MS, action: { label: 'Activity log', run: openActivityLog } });
    else if (started) useOps.getState().pushError(`Fetch failed (${repo.name}): ${text}`);
  }
}

/**
 * The background fetch for one tab. RepoTab calls it, inside the tab's `<Activity>`: only the
 * shown tab's effect is live, so a hidden tab has no timer and does no work (spec §4.4, Review
 * Focus 1), and showing it again restarts the schedule (one fetch at once if it's due).
 */
export function useFetchScheduler(tabId: string, repoId: number | undefined): void {
  const intervalMs = clampFetchInterval(useAppState((s) => s.settings.fetchIntervalSecs)) * 1000;
  useEffect(() => {
    if (repoId === undefined || !(intervalMs > 0)) return;
    const s = new FetchScheduler(intervalMs, {
      now: Date.now,
      lastFetchAt: () => useRuntime.getState().tabs[tabId]?.lastFetchAt ?? 0,
      isMinimized: () => platform.isMinimized().catch(() => false),
      fetch: () => runFetch(tabId, true),
    });
    s.start();
    const off = platform.onFocusChanged((f) => s.onFocus(f));
    return () => {
      s.stop();
      off();
    };
  }, [tabId, repoId, intervalMs]);
}
