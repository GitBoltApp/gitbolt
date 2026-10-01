import { create } from 'zustand';
import { api, errorMessage } from '../api/client';
import { relativeTime, seconds } from '../app/activityLog';

/**
 * The action log (R11, spec §16.2): every action the user ran — through the hamburger, the
 * palette, a shortcut or the toolbar (`invoke`) — and every context-menu row (`runMenuRow`, the
 * menu's row-run hook). In memory only, newest last, capped; each one also goes to the log file.
 */
export interface ActionLogEntry {
  seq: number;
  at: number;
  id: string;
  label: string;
  ok: boolean;
  ms: number;
  error: string | null;
  /** `menu`: a context-menu row that isn't a registered action. */
  source: 'action' | 'menu';
}
export const ACTION_LOG_CAPACITY = 1000;

let seq = 0;

interface ActionLogState { entries: ActionLogEntry[]; record(e: Omit<ActionLogEntry, 'seq'>): void; clear(): void }
export const useActionLog = create<ActionLogState>((set) => ({
  entries: [],
  record: (e) => set((s) => ({ entries: [...s.entries, { ...e, seq: ++seq }].slice(-ACTION_LOG_CAPACITY) })),
  clear: () => set({ entries: [] }),
}));

function logLine(level: 'info' | 'warn', text: string) {
  // Some unit tests mock the client without it; the file log is best effort anyway.
  if (typeof api.logFrontend === 'function') void api.logFrontend(level, text, null).catch(() => {});
}

function finish(id: string, label: string, source: ActionLogEntry['source'], at: number, t0: number, failure: { e: unknown } | null) {
  const ms = Math.round(performance.now() - t0);
  const error = failure ? errorMessage(failure.e) : null;
  useActionLog.getState().record({ at, id, label, ok: !failure, ms, error, source });
  logLine(failure ? 'warn' : 'info', failure ? `action ${id} failed in ${ms} ms: ${error}` : `action ${id} ok in ${ms} ms`);
}

/** The menu row running now, if any: an action it invokes records itself instead of the row. */
let row: { claimed: boolean } | null = null;

/**
 * Runs `run` now, in the caller's task (a key press's effects land before the next paint), and
 * records it once it settles: at once when it's synchronous, when its promise settles otherwise.
 * A failure (a throw or a rejection) is recorded and handed to `onError`; it's never thrown.
 */
/** `quiet`: a success isn't logged (a held shortcut's key repeats); a failure always is. */
export function track(id: string, label: string, run: () => unknown, onError: (e: unknown) => void, quiet = false): void {
  if (row) row.claimed = true;
  const at = Date.now();
  const t0 = performance.now();
  let result: unknown;
  try {
    result = run();
  } catch (e) {
    finish(id, label, 'action', at, t0, { e });
    onError(e);
    return;
  }
  if (result instanceof Promise) {
    result.then(
      () => { if (!quiet) finish(id, label, 'action', at, t0, null); },
      (e: unknown) => {
        finish(id, label, 'action', at, t0, { e });
        onError(e);
      },
    );
  } else if (!quiet) finish(id, label, 'action', at, t0, null);
}

/** A context-menu row's run (synchronous, as rows are): recorded as the row unless it invoked an
 * action, which records itself. A throw is recorded and handed to `onError`. */
export function runMenuRow(id: string, label: string, run: () => void, onError: (e: unknown) => void): void {
  const frame = { claimed: false };
  const outer = row;
  row = frame;
  const at = Date.now();
  const t0 = performance.now();
  let failure: { e: unknown } | null = null;
  try {
    run();
  } catch (e) {
    failure = { e };
  } finally {
    row = outer;
  }
  if (!frame.claimed || failure) finish(id, label, 'menu', at, t0, failure);
  if (failure) onError(failure.e);
}

/** One entry as plain text (a block of the Actions tab's "Copy all"). */
export function actionEntryText(e: ActionLogEntry, now = Date.now()): string {
  const head = `${new Date(e.at).toLocaleString()} (${relativeTime(e.at, now)}) · ${e.label} · ${e.id} · ${e.source} · ${seconds(e.ms)} · ${e.ok ? 'ok' : 'failed'}`;
  return e.error ? `${head}\n${e.error}` : head;
}

export function actionLogText(entries: ActionLogEntry[], now = Date.now()): string {
  return entries.map((e) => actionEntryText(e, now)).join('\n\n');
}
