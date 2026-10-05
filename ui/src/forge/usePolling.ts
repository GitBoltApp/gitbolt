import { useEffect } from 'react';
import { platform } from '../app/platform';
import { useAppState } from '../app/state';
import { clampFetchInterval } from '../settings/schema';
import { notifyForgeAccountsChanged, onForgeAccountsChanged } from './accountsBus';
import { forgeScratch } from './mrStore';
import { pollForge } from './poll';
import { createForgePoller, type ForgePoller } from './poller';

const pollers = new Map<string, ForgePoller>();

/**
 * The forge poller of one tab (spec #4 §3.4). RepoTab calls it inside the tab's `<Activity>`, as
 * `useFetchScheduler`: only the shown tab's effect is live, so a background tab never polls, and
 * showing it again polls at once.
 */
export function useForgePolling(tabId: string, repoId: number | undefined): void {
  const intervalMs = clampFetchInterval(useAppState((s) => s.settings.fetchIntervalSecs)) * 1000;
  useEffect(() => {
    if (repoId === undefined) return;
    const p = createForgePoller(intervalMs, {
      now: Date.now,
      isMinimized: () => platform.isMinimized().catch(() => false),
      isFocused: () => platform.isFocused().catch(() => true),
      poll: (reason) => pollForge(tabId, reason),
    });
    pollers.set(tabId, p);
    p.start();
    const off = platform.onFocusChanged((f) => p.onFocus(f));
    return () => {
      p.stop();
      off();
      if (pollers.get(tabId) === p) pollers.delete(tabId);
    };
  }, [tabId, repoId, intervalMs]);
}

/** After a GitBolt forge write (spec #4 §3.4): the tab's poller polls at once. */
export function notifyForgeWrite(tabId: string): void {
  pollers.get(tabId)?.afterWrite();
}

export { notifyForgeAccountsChanged };

/** After an account was added or removed (spec #4 §3.4): every live poller polls at once, asking the forges again, and a tab's next activation does too. */
onForgeAccountsChanged(() => {
  forgeScratch.activatedAt.clear();
  for (const [tabId, p] of pollers) {
    forgeScratch.recheck.add(tabId);
    p.afterWrite();
  }
});
