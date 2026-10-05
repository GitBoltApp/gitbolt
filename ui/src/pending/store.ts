import { create } from 'zustand';

/** What a ref is being put through (the chip and the row show a spinner meanwhile). */
export type PendingAction = 'checkout' | 'pull' | 'push' | 'delete' | 'fetch';

interface PendingState {
  /** Per tab: the full ref name -> the action running on it. */
  byTab: Record<string, Record<string, PendingAction>>;
  /** Actions queued or running, by `tab|action|target`: the same action on the same target is not started twice. */
  inflight: Record<string, true>;
}

export const usePending = create<PendingState>(() => ({ byTab: {}, inflight: {} }));

const flightKey = (tabId: string, action: PendingAction, target: string) => `${tabId}|${action}|${target}`;

/** True while `action` on `target` (a ref, a remote; '' for all) is queued or running on this tab. */
export const isInFlight = (tabId: string, action: PendingAction, target: string): boolean => !!usePending.getState().inflight[flightKey(tabId, action, target)];

/** Hook form of `isInFlight` (the toolbar button's spinner). */
export const useInFlight = (tabId: string, action: PendingAction, target: string | null): boolean =>
  usePending((s) => target !== null && !!s.inflight[flightKey(tabId, action, target)]);

/** Runs `fn` unless the same action on the same target is already queued or running: then it is
 * ignored (`undefined`; not queued again). The one dedupe point every path (button, menu, hotkey,
 * palette) goes through; cleared when `fn` ends however it ends. */
export async function runOnce<T>(tabId: string, action: PendingAction, target: string, fn: () => Promise<T>): Promise<T | undefined> {
  const key = flightKey(tabId, action, target);
  if (usePending.getState().inflight[key]) return undefined;
  usePending.setState((s) => ({ inflight: { ...s.inflight, [key]: true } }));
  try {
    return await fn();
  } finally {
    usePending.setState((s) => {
      const { [key]: _gone, ...rest } = s.inflight;
      return { inflight: rest };
    });
  }
}

export function startPending(tabId: string, ref: string, action: PendingAction): void {
  usePending.setState((s) => ({ byTab: { ...s.byTab, [tabId]: { ...s.byTab[tabId], [ref]: action } } }));
}

export function endPending(tabId: string, ref: string, action?: PendingAction): void {
  usePending.setState((s) => {
    const cur = s.byTab[tabId];
    // A later action on the same ref owns the mark now: only clear our own.
    if (!cur || !(ref in cur) || (action && cur[ref] !== action)) return s;
    const { [ref]: _gone, ...rest } = cur;
    return { byTab: { ...s.byTab, [tabId]: rest } };
  });
}

/** Runs `fn` with `refs` marked pending on `tabId`; cleared when it ends however it ends (success,
 * failure, cancel). Wired into the `runWrite` callers, so every path (double-click, menu, palette)
 * shows it. */
export async function withPending<T>(tabId: string, refs: string[], action: PendingAction, fn: () => Promise<T>): Promise<T> {
  for (const r of refs) startPending(tabId, r, action);
  try {
    return await fn();
  } finally {
    for (const r of refs) endPending(tabId, r, action);
  }
}

/** The action running on any of `refs` on this tab, if one is. */
export function usePendingAny(tabId: string, refs: readonly (string | null | undefined)[]): PendingAction | null {
  return usePending((s) => {
    const cur = s.byTab[tabId];
    if (!cur) return null;
    for (const r of refs) if (r && cur[r]) return cur[r];
    return null;
  });
}
