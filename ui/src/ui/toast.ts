import { create } from 'zustand';

/** A link in a toast: `run` and the toast goes away. */
export interface ToastAction { label: string; run(): void }
export interface ToastOptions {
  action?: ToastAction;
  /** More links, after `action` (R12: a failed action's Retry/Copy and Details). */
  actions?: ToastAction[];
  /** How long it shows: a short notice by default; an error (with something to read) longer. */
  ms?: number;
}

export const TOAST_MS = 1200;
/** An error toast: long enough to read git's message and reach its link (K96). */
export const ERROR_TOAST_MS = 8000;

interface ToastState {
  message: string | null;
  action: ToastAction | null;
  actions: ToastAction[];
  show(msg: string, opts?: ToastOptions): void;
  dismiss(): void;
}

let timer: ReturnType<typeof setTimeout> | undefined;
const NONE: ToastAction[] = [];

export const useToast = create<ToastState>((set) => ({
  message: null,
  action: null,
  actions: NONE,
  show(message, opts) {
    clearTimeout(timer);
    set({ message, action: opts?.action ?? null, actions: opts?.actions ?? NONE });
    timer = setTimeout(() => set({ message: null, action: null, actions: NONE }), opts?.ms ?? TOAST_MS);
  },
  dismiss() {
    clearTimeout(timer);
    set({ message: null, action: null, actions: NONE });
  },
}));
