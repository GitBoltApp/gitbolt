import { useEffect, useRef } from 'react';
import { activeTab } from './actions';

/**
 * Handlers a mounted view lends to a registry action, per tab: the commit box's Commit, the hunk
 * at the diff's cursor, an MR/PR view's Approve and Merge. The action (registered at startup,
 * so the palette and the Keyboard Shortcuts panel list it) is usable while the active tab's view
 * has lent one, and runs it. A view hidden in a background tab (`<Activity>`) has no effects, so
 * it lends nothing.
 */
const lent = new Map<string, Map<string, () => void>>();

/** Lends `fn` to action `id` for `tabId`; returns its removal. */
export function lend(id: string, tabId: string, fn: () => void): () => void {
  const byTab = lent.get(id) ?? new Map<string, () => void>();
  lent.set(id, byTab);
  byTab.set(tabId, fn);
  return () => {
    if (byTab.get(tabId) === fn) byTab.delete(tabId);
  };
}

/** What the active tab's view lent to `id`, or null. */
export function lentHandler(id: string): (() => void) | null {
  const t = activeTab();
  return t ? lent.get(id)?.get(t.id) ?? null : null;
}

/** `lend` while mounted and `fn` isn't null (null: the action doesn't apply now). The latest
 * `fn` runs: it needn't be stable. */
export function useLend(id: string, tabId: string, fn: (() => void) | null): void {
  const latest = useRef(fn);
  latest.current = fn;
  const on = fn !== null;
  useEffect(() => (on ? lend(id, tabId, () => latest.current?.()) : undefined), [id, tabId, on]);
}
