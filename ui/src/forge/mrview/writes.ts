import { errorMessage } from '../../api/client';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import { useRuntime } from '../../app/runtime';
import { useToast } from '../../ui/toast';
import { noteForgeWritten, patchForge } from '../mrStore';
import { notifyForgeWrite } from '../usePolling';

/**
 * One forge write from the MR/PR view (spec #4 §3.5: a remote action, not journaled). It works:
 * the tab's poller polls at once, and the caller puts the answer in the store. It fails: a toast
 * says why, and nothing in the store changes (§6: no optimistic UI).
 */
export async function forgeWrite<T>(tabId: string, failure: string, send: (repo: number) => Promise<T>): Promise<{ value: T } | null> {
  const repo = useRuntime.getState().tabs[tabId]?.repo?.id;
  if (repo === undefined) return null;
  try {
    const value = await send(repo);
    noteForgeWritten(tabId); // a poll or load already under way may predate this answer
    notifyForgeWrite(tabId);
    return { value };
  } catch (e) {
    useToast.getState().show(`${failure}: ${errorMessage(e)}`, { error: true });
    return null;
  }
}

/** The MR/PR a write answered with, into the list and its detail. A write's answer has no review
 * (and GitLab's no pipeline): the loaded ones stay until the next poll. */
export function putMr(tabId: string, mr: ForgeMr): void {
  patchForge(tabId, (f) => {
    const list = f.list ? { ...f.list, mrs: f.list.mrs.map((m) => (m.number === mr.number ? { ...mr, review: m.review, pipeline: mr.pipeline ?? m.pipeline } : m)) } : null;
    const d = f.details[mr.number];
    if (!d) return { list };
    const merged = { ...mr, review: d.value.mr.review, pipeline: mr.pipeline ?? d.value.mr.pipeline };
    return { list, details: { ...f.details, [mr.number]: { value: { ...d.value, mr: merged }, at: d.at } } };
  });
}

export function putDescription(tabId: string, number: number, description: string): void {
  patchForge(tabId, (f) => {
    const d = f.details[number];
    return d ? { details: { ...f.details, [number]: { value: { ...d.value, description }, at: d.at } } } : {};
  });
}
