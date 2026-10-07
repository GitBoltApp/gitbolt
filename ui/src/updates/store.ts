import { create } from 'zustand';
import { api, errorMessage, onEvent } from '../api/client';
import type { InstallOutcome } from '../api/gen/InstallOutcome';
import type { UpdateRelease } from '../api/gen/UpdateRelease';
import type { UpdateState } from '../api/gen/UpdateState';

/**
 * The update the core found (core `updates.rs`): its state as `updateChanged` events report it,
 * the dialog, and the last manual check's or install's answer. The webview never talks to
 * GitHub; every step is a request to the core.
 */
interface UpdatesStore {
  state: UpdateState;
  dialogOpen: boolean;
  /** Check for updates (About, the Help menu) failed: why. Cleared by the next check. */
  checkError: string | null;
  /** What the last Install said when it couldn't install by itself (the command to run). */
  outcome: InstallOutcome | null;
  /** A request that failed outside a check (download, install, restart). */
  error: string | null;
  setState(state: UpdateState): void;
  /** Starts listening and reads the current state, once. */
  listen(): void;
  check(): Promise<void>;
  download(): Promise<void>;
  cancel(): Promise<void>;
  install(): Promise<void>;
  restart(): Promise<void>;
  openDialog(): void;
  closeDialog(): void;
}

let listening = false;

export const useUpdates = create<UpdatesStore>((set, get) => {
  const failed = (e: unknown) => set({ error: errorMessage(e) });
  return {
    state: { state: 'idle' },
    dialogOpen: false,
    checkError: null,
    outcome: null,
    error: null,
    setState: (state) => set((s) => ({ state, outcome: state.state === 'ready' || state.state === 'installing' ? s.outcome : null })),
    listen() {
      if (listening) return;
      listening = true;
      onEvent((ev) => { if (ev.type === 'updateChanged') get().setState(ev.state); });
      Promise.resolve().then(() => api.updateStatus()).then((s) => get().setState(s), (e: unknown) => console.warn('[gitbolt] update status', errorMessage(e)));
    },
    async check() {
      set({ checkError: null });
      try { get().setState(await api.updateCheck()); } catch (e) { set({ checkError: errorMessage(e) }); }
    },
    async download() {
      set({ error: null, outcome: null });
      try { get().setState(await api.updateDownload()); } catch (e) { failed(e); }
    },
    async cancel() {
      try { get().setState(await api.updateCancel()); } catch (e) { failed(e); }
    },
    async install() {
      set({ error: null, outcome: null });
      try { set({ outcome: await api.updateInstall() }); } catch (e) { failed(e); }
    },
    async restart() {
      set({ error: null });
      try { await api.updateRestart(); } catch (e) { failed(e); }
    },
    openDialog: () => set({ dialogOpen: true }),
    closeDialog: () => set({ dialogOpen: false }),
  };
});

/** The release the pill and the dialog show, if any. A check that failed has none. */
export function releaseOf(s: UpdateState): UpdateRelease | null {
  return 'release' in s ? s.release : null;
}

/** 0–100, for the download's bar. */
export function percentOf(s: UpdateState): number {
  if (s.state !== 'downloading' || s.total <= 0) return 0;
  return Math.min(100, Math.floor((s.received * 100) / s.total));
}

/** `98.2 MB`, `640 KB`. */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Tests only: forget the subscription. */
export function resetUpdatesForTest(): void {
  listening = false;
  useUpdates.setState({ state: { state: 'idle' }, dialogOpen: false, checkError: null, outcome: null, error: null });
}
