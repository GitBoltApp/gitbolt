import { useEffect } from 'react';
import { create } from 'zustand';
import { onEvent } from '../api/client';
import type { AppEvent } from '../api/gen/AppEvent';
import type { OpKind } from '../api/gen/OpKind';

/** A running network op (fetch, clone), from `opStarted` until `opFinished`. */
export interface OpInfo { op: number; kind: OpKind; repo: number | null; label: string; phase: string | null; percent: number | null }
/** An askpass prompt waiting for the user (spec §5.4), from `authWaiting` until `authResolved`. */
export interface AuthPrompt { prompt: number; op: number; repo: number | null; text: string; secret: boolean }
/** A background error, kept for the status bar's bell (spec §16.1). */
export interface BgError { at: number; message: string }
export const MAX_ERRORS = 100;

interface OpsState {
  ops: Record<number, OpInfo>;
  prompts: AuthPrompt[];
  /** Newest first, at most `MAX_ERRORS`. */
  errors: BgError[];
  /** Errors since the bell was last opened. */
  unread: number;
  apply(ev: AppEvent): void;
  pushError(message: string): void;
  markRead(): void;
  clearErrors(): void;
}

/**
 * The app's network ops and askpass prompts, fed by the backend's events whichever tab is showing
 * (they're app-wide: a clone has no tab yet, and the auth modal is the app's), plus the background
 * error history. The status bar, the toolbar's busy Fetch and the auth modal read it.
 */
export const useOps = create<OpsState>((set) => ({
  ops: {},
  prompts: [],
  errors: [],
  unread: 0,
  apply(ev) {
    switch (ev.type) {
      case 'opStarted':
        set((s) => ({ ops: { ...s.ops, [ev.op]: { op: ev.op, kind: ev.kind, repo: ev.repo, label: ev.label, phase: null, percent: null } } }));
        break;
      case 'opProgress':
        // `opProgress` carries only the op id: an op this store never saw start has nothing to update.
        set((s) => (s.ops[ev.op] ? { ops: { ...s.ops, [ev.op]: { ...s.ops[ev.op], phase: ev.phase, percent: ev.percent } } } : s));
        break;
      case 'opFinished':
        set((s) => {
          const ops = { ...s.ops };
          delete ops[ev.op];
          // A finished op's askpass child is gone, so a prompt of its that's still listed (its
          // `authResolved` lost to a reconnect) would never close.
          const prompts = s.prompts.some((p) => p.op === ev.op) ? s.prompts.filter((p) => p.op !== ev.op) : s.prompts;
          return { ops, prompts };
        });
        break;
      case 'authWaiting':
        set((s) => ({ prompts: [...s.prompts.filter((p) => p.prompt !== ev.prompt), { prompt: ev.prompt, op: ev.op, repo: ev.repo, text: ev.text, secret: ev.secret }] }));
        break;
      case 'authResolved':
        set((s) => (s.prompts.some((p) => p.prompt === ev.prompt) ? { prompts: s.prompts.filter((p) => p.prompt !== ev.prompt) } : s));
        break;
      default:
        break;
    }
  },
  pushError(message) {
    set((s) => ({ errors: [{ at: Date.now(), message }, ...s.errors].slice(0, MAX_ERRORS), unread: s.unread + 1 }));
  },
  markRead() {
    set((s) => (s.unread ? { unread: 0 } : s));
  },
  clearErrors() {
    set({ errors: [], unread: 0 });
  },
}));

/** One subscription for the app's lifetime (`AppShell`): op and auth events matter whichever
 * tab is showing, so this is the one listener that isn't per tab. */
export function useGlobalEvents(): void {
  useEffect(() => onEvent((ev) => useOps.getState().apply(ev)), []);
}
