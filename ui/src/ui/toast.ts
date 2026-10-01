import { create } from 'zustand';

/** A link in a toast: `run` and the toast goes away. */
export interface ToastAction { label: string; run(): void }
export interface ToastOptions {
  action?: ToastAction;
  /** How long it shows: a short notice by default; an error (with something to read) longer. */
  ms?: number;
}

export const TOAST_MS = 1200;
/** An error toast: long enough to read git's message and reach its link (K96). */
export const ERROR_TOAST_MS = 8000;

interface ToastState { message: string | null; action: ToastAction | null; show(msg: string, opts?: ToastOptions): void; dismiss(): void }

let timer: ReturnType<typeof setTimeout> | undefined;

export const useToast = create<ToastState>((set) => ({
  message: null,
  action: null,
  show(message, opts) {
    clearTimeout(timer);
    set({ message, action: opts?.action ?? null });
    timer = setTimeout(() => set({ message: null, action: null }), opts?.ms ?? TOAST_MS);
  },
  dismiss() {
    clearTimeout(timer);
    set({ message: null, action: null });
  },
}));
