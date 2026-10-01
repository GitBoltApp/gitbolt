import { create } from 'zustand';
import { useMenu } from '../menu/menuStore';
import type { ActivityEntry } from './ops';

/** The activity log (K30, K96, K101): every finished fetch and clone, background ones included. It
 * is a modal panel (`ActivityModal`), opened from the bell, Help → Activity log and the failed-fetch toast. */
export const useActivityUi = create<{ open: boolean; setOpen(v: boolean): void }>((set) => ({ open: false, setOpen: (open) => set({ open }) }));

/** Opens the activity log (a failed fetch's toast links here, the bell, and Help → Activity log). */
export function openActivityLog(): void {
  useMenu.getState().close();
  useActivityUi.getState().setOpen(true);
}

export const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export function relativeTime(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** One entry as plain text (the per-entry copy, and a block of "Copy all"). */
export function entryText(e: ActivityEntry, now = Date.now()): string {
  const head = `${new Date(e.at).toLocaleString()} (${relativeTime(e.at, now)}) · ${e.label || '(no repo)'} · ${e.kind} · ${e.background ? 'background' : 'user'} · ${seconds(e.durationMs)} · ${e.outcome}`;
  return [head, e.command, e.message].filter(Boolean).join('\n');
}

export function allText(entries: ActivityEntry[], now = Date.now()): string {
  return entries.map((e) => entryText(e, now)).join('\n\n');
}
