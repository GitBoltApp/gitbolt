import { useEffect } from 'react';
import { create } from 'zustand';
import { onEvent } from '../api/client';
import type { AppEvent } from '../api/gen/AppEvent';
import type { OpKind } from '../api/gen/OpKind';
import type { OpOutcome } from '../api/gen/OpOutcome';
import type { ProgressStep } from '../api/gen/ProgressStep';
import type { RemoteLine } from '../api/gen/RemoteLine';
import type { StashStep } from '../api/gen/StashStep';
import { applyQueueEvent } from '../queue/store';
import { applyJournalEvent } from '../undo/store';

/** A running network op (fetch, clone), from `opStarted` until `opFinished`. `interactive`: the
 * user started it (a background fetch is `false` and shows nowhere but the activity log, K30).
 * `shown`: a user's Fetch found this background fetch already running and waits on it instead. */
export interface OpInfo {
  op: number; kind: OpKind; repo: number | null; label: string; phase: string | null; percent: number | null;
  interactive: boolean; shown: boolean; startedAt: number;
  /** A write's autostash step running now (`opStashStep`), since `at` (spec #2 §6). */
  stash?: { step: StashStep; message: string; at: number } | null;
  // --- 2D T18 ---
  /** A rebase's place, `n` of `m` (spec #2 §13.4), from `opProgress.step`: kept until the next one. */
  step?: ProgressStep | null;
  // --- end 2D T18 ---
}
/** An askpass prompt waiting for the user (spec §5.4), from `authWaiting` until `authResolved`. */
export interface AuthPrompt { prompt: number; op: number; repo: number | null; text: string; secret: boolean }
/** A background error, kept for the status bar's bell (spec §16.1). */
export interface BgError { at: number; message: string }
/** One finished network op, for the activity log (K30), which a future Activity panel and Help →
 * Debug (spec §16.2) read. `durationMs` runs from `opStarted` to `opFinished`. */
export interface ActivityEntry {
  at: number; op: number; kind: OpKind; label: string; background: boolean; durationMs: number; outcome: OpOutcome; message: string | null;
  /** The git command that ran, redacted (K101). */
  command: string | null;
  /** The op's hook and progress output (opOutput), at most `OUTPUT_CAP` bytes (spec #2 §3.5). */
  output: string[];
  /** The server's `remote:` lines, whole (spec #2 §12.4). */
  remote: RemoteLine[];
}
export const OUTPUT_CAP = 64 * 1024;
const TRUNCATED = '… output truncated at 64 KB';

/** Byte size of each array `appendCapped` returned (a line costs O(1), not a re-sum). */
const bytes = new WeakMap<string[], number>();

/** `lines` plus `line`, or plus the truncation note (once) past `OUTPUT_CAP` bytes. */
export function appendCapped(lines: string[], line: string): string[] {
  if (lines[lines.length - 1] === TRUNCATED) return lines;
  const size = bytes.get(lines) ?? 0;
  const add = new TextEncoder().encode(line).length + 1;
  const next = size + add > OUTPUT_CAP ? [...lines, TRUNCATED] : [...lines, line];
  bytes.set(next, size + add);
  return next;
}
export const MAX_ERRORS = 100;
export const MAX_ACTIVITY = 200;

interface OpsState {
  ops: Record<number, OpInfo>;
  prompts: AuthPrompt[];
  /** Newest first, at most `MAX_ERRORS`. */
  errors: BgError[];
  /** Errors since the bell was last opened. */
  unread: number;
  /** Every finished operation, background ones included: newest first, at most `MAX_ACTIVITY`. */
  activity: ActivityEntry[];
  /** The output of each running op, until its `opFinished` moves it into the Activity entry. */
  outputs: Record<number, string[]>;
  /** The server lines of each running op, until `opFinished` moves them into the Activity entry. */
  remotes: Record<number, RemoteLine[]>;
  apply(ev: AppEvent): void;
  /** A user's Fetch found this (background) fetch running: the Fetch button shows it as busy. */
  showOp(op: number): void;
  pushError(message: string): void;
  markRead(): void;
  clearErrors(): void;
}

/** A user's fetch (or a background one a user's Fetch waits on): what the Fetch button shows. */
export const isShownFetch = (o: OpInfo, repo: number | undefined) => o.kind === 'fetch' && o.repo === repo && (o.interactive || o.shown);

/**
 * The app's network ops and askpass prompts, fed by the backend's events whichever tab is showing
 * (they're app-wide: a clone has no tab yet, and the auth modal is the app's), plus the background
 * error history and the activity log. The status bar (clones only), the toolbar's busy Fetch (user
 * fetches only) and the auth modal read it.
 */
export const useOps = create<OpsState>((set) => ({
  ops: {},
  prompts: [],
  errors: [],
  unread: 0,
  activity: [],
  outputs: {},
  remotes: {},
  apply(ev) {
    switch (ev.type) {
      case 'opStarted':
        set((s) => ({ ops: { ...s.ops, [ev.op]: { op: ev.op, kind: ev.kind, repo: ev.repo, label: ev.label, phase: null, percent: null, interactive: ev.interactive, shown: false, startedAt: Date.now() } } }));
        break;
      case 'opProgress':
        // `opProgress` carries only the op id: an op this store never saw start has nothing to update.
        set((s) => (s.ops[ev.op] ? { ops: { ...s.ops, [ev.op]: { ...s.ops[ev.op], phase: ev.phase, percent: ev.percent, step: ev.step ?? s.ops[ev.op].step ?? null } } } : s));
        break;
      case 'opStashStep':
        set((s) => (s.ops[ev.op] ? { ops: { ...s.ops, [ev.op]: { ...s.ops[ev.op], stash: ev.step ? { step: ev.step, message: ev.message, at: Date.now() } : null } } } : s));
        break;
      case 'opOutput':
        set((s) => ({ outputs: { ...s.outputs, [ev.op]: appendCapped(s.outputs[ev.op] ?? [], ev.line) } }));
        break;
      case 'opRemote':
        set((s) => ({ remotes: { ...s.remotes, [ev.op]: [...(s.remotes[ev.op] ?? []), ...ev.lines] } }));
        break;
      case 'opFinished':
        set((s) => {
          const ops = { ...s.ops };
          const done = s.ops[ev.op];
          delete ops[ev.op];
          const now = Date.now();
          const entry: ActivityEntry = {
            at: now, op: ev.op, kind: ev.kind, label: done?.label ?? '', background: done ? !done.interactive : false,
            durationMs: done ? now - done.startedAt : 0, outcome: ev.outcome, message: ev.message, command: ev.command,
            output: s.outputs[ev.op] ?? [], remote: s.remotes[ev.op] ?? [],
          };
          const outputs = { ...s.outputs };
          delete outputs[ev.op];
          const remotes = { ...s.remotes };
          delete remotes[ev.op];
          // A finished op's askpass child is gone, so a prompt of its that's still listed (its
          // `authResolved` lost to a reconnect) would never close.
          const prompts = s.prompts.some((p) => p.op === ev.op) ? s.prompts.filter((p) => p.op !== ev.op) : s.prompts;
          // A successful stage or unstage appears only in the Commands tab (spec #2 §3.5).
          if (ev.kind === 'stage' && ev.outcome === 'ok') return { ops, prompts, outputs, remotes };
          return { ops, prompts, outputs, remotes, activity: [entry, ...s.activity].slice(0, MAX_ACTIVITY) };
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
  showOp(op) {
    set((s) => (s.ops[op] && !s.ops[op].shown ? { ops: { ...s.ops, [op]: { ...s.ops[op], shown: true } } } : s));
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
  useEffect(() => onEvent((ev) => {
    useOps.getState().apply(ev);
    applyQueueEvent(ev);
    applyJournalEvent(ev);
  }), []);
}
