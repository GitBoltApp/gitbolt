import { create } from 'zustand';
import { api } from '../api/client';
import type { AppEvent } from '../api/gen/AppEvent';
import type { OpKind } from '../api/gen/OpKind';
import type { QueueStatePayload } from '../api/gen/QueueStatePayload';

export const IDLE: QueueStatePayload = { running: null, queued: [], stopped: null };

interface QueueStore {
  /** Each open repo id's queue (the backend announces it to every tab of the repository). */
  byRepo: Record<number, QueueStatePayload>;
  set(repo: number, s: QueueStatePayload): void;
}

export const useQueue = create<QueueStore>((set) => ({
  byRepo: {},
  set: (repo, s) => set((st) => ({ byRepo: { ...st.byRepo, [repo]: s } })),
}));

export function applyQueueEvent(ev: AppEvent): void {
  if (ev.type === 'queueChanged') useQueue.getState().set(ev.repo, { running: ev.running, queued: ev.queued, stopped: ev.stopped });
}

/** The state at the time a tab shows (events keep it current after). */
export async function loadQueue(repo: number): Promise<void> {
  const before = useQueue.getState().byRepo[repo];
  try {
    const s = await api.queueState(repo);
    // A queueChanged that arrived meanwhile is newer than this response.
    if (useQueue.getState().byRepo[repo] === before) useQueue.getState().set(repo, s);
  } catch (e) {
    console.warn('[gitbolt] queue state', e);
  }
}

export const isIdle = (q: QueueStatePayload | undefined) => !q || (!q.running && q.queued.length === 0 && !q.stopped);

/** Spec #2 §3.6: `Running: push dev · 2 queued`, or `Stopped: push dev failed · 2 not run`. */
export function chipText(q: QueueStatePayload): string {
  const n = q.queued.length;
  if (q.stopped) return `Stopped: ${q.stopped.label} failed · ${n} not run`;
  if (!q.running) return `${n} queued`;
  return `Running: ${q.running.label}${n ? ` · ${n} queued` : ''}`;
}

/** An op of `kind` waits in `repo`'s queue: its button shows the queued badge (§3.6). */
export const useQueuedKind = (repo: number, kind: OpKind) => useQueue((s) => (s.byRepo[repo]?.queued ?? []).some((i) => i.kind === kind));
