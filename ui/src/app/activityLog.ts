import { create } from 'zustand';
import { copyText } from '../api/transport';
import { useMenu } from '../menu/menuStore';
import { useToast } from '../ui/toast';
import type { ActivityEntry } from './ops';

/** The Debug modal's tabs (R9): the activity log, the backend's git command log, the action log. */
export type DebugView = 'activity' | 'commands' | 'actions';

interface ActivityUi {
  open: boolean;
  view: DebugView;
  /** The command the Commands tab scrolls to and highlights (an error toast's Details, R10). */
  focusCommandId: number | null;
  /** The op whose Activity entry is scrolled to, its server output expanded (spec #2 §12.4). */
  focusOp: number | null;
  /** The perf overlay (fps and backend call timings) is shown; it outlives the modal. */
  perfOverlay: boolean;
  setOpen(v: boolean): void;
  /** Opens the modal on `view`, focused on `focusCommandId` (Commands). */
  show(view: DebugView, focusCommandId?: number | null): void;
  setView(view: DebugView): void;
  togglePerfOverlay(): void;
}

/** The activity log (K30, K96, K101): every finished operation, background ones included. It
 * is a modal panel (`ActivityModal`), opened from the bell, Help → Activity log and the failed-fetch
 * toast. 1D (R9) makes it the one Debug modal: Activity | Commands | Actions. */
export const useActivityUi = create<ActivityUi>((set) => ({
  open: false,
  view: 'activity',
  focusCommandId: null,
  focusOp: null,
  perfOverlay: false,
  setOpen: (open) => set(open ? { open } : { open, focusCommandId: null, focusOp: null }),
  show: (view, focusCommandId = null) => set({ open: true, view, focusCommandId, focusOp: null }),
  setView: (view) => set({ view }),
  togglePerfOverlay: () => set((s) => ({ perfOverlay: !s.perfOverlay })),
}));

/** Opens the Debug modal on `view` (Help → Debug…, an error toast's Details). */
export function openDebug(view: DebugView, focusCommandId: number | null = null): void {
  useMenu.getState().close();
  useActivityUi.getState().show(view, focusCommandId);
}

/** Opens the activity log (a failed fetch's toast links here, the bell, and Help → Activity log). */
export function openActivityLog(): void {
  openDebug('activity');
}

/** Opens the activity log at op `op`'s entry, its server output expanded (spec #2 §12.4). */
export function openActivityEntry(op: number): void {
  useMenu.getState().close();
  useActivityUi.setState({ open: true, view: 'activity', focusCommandId: null, focusOp: op });
}

/** Copies `text`, saying so in a toast (the Debug modal's Copy all / Copy entry, an error's Copy). */
export function copyAndSay(text: string): Promise<void> {
  return copyText(text).then(() => useToast.getState().show('Copied'), () => useToast.getState().show('Copy failed'));
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
  return [head, e.command, e.message, e.remote.length ? e.remote.map((l) => `server: ${l.text}`).join('\n') : null, e.output.length ? e.output.join('\n') : null].filter(Boolean).join('\n');
}

export function allText(entries: ActivityEntry[], now = Date.now()): string {
  return entries.map((e) => entryText(e, now)).join('\n\n');
}
