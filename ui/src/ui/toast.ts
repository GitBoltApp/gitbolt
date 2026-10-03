import { create } from 'zustand';

/** A link in a toast: `run` and the toast goes away. */
export interface ToastAction { label: string; run(): void }
export interface ToastOptions {
  action?: ToastAction;
  /** More links, after `action` (R12: a failed action's Retry/Copy and Details). */
  actions?: ToastAction[];
  /** Stays until dismissed (with a ×), no timer. */
  sticky?: boolean;
  tone?: 'warning';
  /** A failure: shows the long duration. */
  error?: boolean;
  /** A quoted line under the message. */
  detail?: string;
}

/**
 * The one duration policy (no caller passes a duration):
 * - plain info or success: `TOAST_MS` (4 s);
 * - anything with action links, a warning or an error: `LONG_TOAST_MS` (8 s), time to read and reach a link;
 * - sticky (asks for input): no timer, stays until dismissed;
 * - hovering a toast pauses its countdown (`hold`); leaving restarts it (`release`) with what was left.
 */
export const TOAST_MS = 4000;
export const LONG_TOAST_MS = 8000;

export function toastDuration(o?: ToastOptions): number | null {
  if (o?.sticky) return null;
  return o?.error || o?.tone === 'warning' || o?.action || o?.actions?.length ? LONG_TOAST_MS : TOAST_MS;
}

interface ToastState {
  message: string | null;
  action: ToastAction | null;
  actions: ToastAction[];
  sticky: boolean;
  tone: 'warning' | null;
  detail: string | null;
  show(msg: string, opts?: ToastOptions): void;
  dismiss(): void;
  /** The pointer is over the toast: pause its countdown. */
  hold(): void;
  /** The pointer left: resume with the time that was left. */
  release(): void;
}

let timer: ReturnType<typeof setTimeout> | undefined;
let left: number | null = null;
let startedAt = 0;
const NONE: ToastAction[] = [];

const CLEARED = { message: null, action: null, actions: NONE, sticky: false, tone: null, detail: null };

function arm(set: (s: typeof CLEARED) => void, ms: number | null) {
  clearTimeout(timer);
  left = ms;
  if (ms === null) return;
  startedAt = Date.now();
  timer = setTimeout(() => { left = null; set(CLEARED); }, ms);
}

export const useToast = create<ToastState>((set, get) => ({
  message: null,
  action: null,
  actions: NONE,
  sticky: false,
  tone: null,
  detail: null,
  show(message, opts) {
    set({ message, action: opts?.action ?? null, actions: opts?.actions ?? NONE, sticky: opts?.sticky ?? false, tone: opts?.tone ?? null, detail: opts?.detail ?? null });
    arm(set, toastDuration(opts));
  },
  dismiss() {
    clearTimeout(timer);
    left = null;
    set(CLEARED);
  },
  hold() {
    if (left === null || !get().message) return;
    clearTimeout(timer);
    left = Math.max(0, left - (Date.now() - startedAt));
  },
  release() {
    if (left === null || !get().message) return;
    arm(set, left);
  },
}));
