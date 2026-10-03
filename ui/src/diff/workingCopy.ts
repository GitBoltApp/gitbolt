import { create } from 'zustand';
import { api } from '../api/client';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import type { GbError } from '../api/gen/GbError';
import { inTauri } from '../api/transport';
import { toastActionError } from '../debug/errorToast';
import { contentsRequest, type DiffTarget, type RepoViewStore } from '../repo/store';
import { chooseAction } from '../ui/ConfirmDialog';
import { applyResult } from '../write/client';
import type { MonacoHost } from './monaco/host';
import { loadedHost } from './TextDiff';
import { loadMonacoHost } from './monaco/load';
import { wipSideOf } from './wipHunks';

/** Hunk and line buttons while the working copy has unsaved edits (spec #2 §7.5). */
export const SAVE_FIRST = 'Save first';

export interface WorkingCopy {
  key: string; path: string; worktree: string; repo: number; base: string | null; dirty: boolean;
  /** Which editor holds it: the diff's modified side, or File View's. */
  view?: 'diff' | 'file';
  /** The edited text kept while the tab is hidden (the shared editor may show another tab's file
   * meanwhile): the panel shows it again, instead of the file's disk text, on return. */
  draft?: string;
}

interface WorkingCopyStore {
  /** Per tab: the editable file shown, if any. */
  copies: Record<string, WorkingCopy | undefined>;
  /** Per tab: bumped to reload the shown file's contents (after a save, or Reload). */
  epoch: Record<string, number>;
}

export const useWorkingCopy = create<WorkingCopyStore>(() => ({ copies: {}, epoch: {} }));

const patch = (tabId: string, p: Partial<WorkingCopy>) =>
  useWorkingCopy.setState((s) => (s.copies[tabId] ? { copies: { ...s.copies, [tabId]: { ...s.copies[tabId]!, ...p } } } : s));
const reload = (tabId: string) => useWorkingCopy.setState((s) => ({ epoch: { ...s.epoch, [tabId]: (s.epoch[tabId] ?? 0) + 1 } }));

export const useIsDirty = (tabId: string) => useWorkingCopy((s) => !!s.copies[tabId]?.dirty);

/** A conflicted WIP path (`U`, `X`): the merge tool edits it, never the working copy. */
const conflicted = (t: DiffTarget) => t.status === 'U' || t.status === 'X';

/**
 * UX round 2 G.2: File View of a WIP file, unstaged or staged, shows (and edits) its
 * working-tree file. A staged file's target loads the working tree as its new side, its staged
 * version as the old one: File View shows that one, read-only, if the file is gone from the
 * working tree. Every other target (a Diff View, a commit's file, a deletion, a conflict) is
 * returned as it is.
 */
export function worktreeFileTarget(t: DiffTarget): DiffTarget {
  if (t.view !== 'file' || t.new.kind === 'worktree' || t.new.kind === 'absent' || conflicted(t)) return t;
  const side = wipSideOf(t);
  return side ? { ...t, old: t.new, new: { kind: 'worktree', worktree: side.worktree } } : t;
}

/** §7.5: a WIP diff (or File View of a WIP file, `worktreeFileTarget`) whose new side is the
 * working-tree file, as loaded text: binary, the large-file prompt, image diffs, deletions and
 * conflicted files stay read-only. */
export function isEditableTarget(t: DiffTarget, c: DiffContentsPayload | null): boolean {
  return t.key.startsWith('{"kind":"wip"') && t.new.kind === 'worktree' && !conflicted(t) && !!c && !c.tooLarge && !c.image && !!c.new && !c.new.binary && c.new.text !== null;
}

/** The shown copy is editable: track it (`base` = its loaded bytes' hash). */
export function trackCopy(tabId: string, repo: number, t: DiffTarget, c: DiffContentsPayload): void {
  if (t.new.kind !== 'worktree') return;
  const worktree = t.new.worktree;
  useWorkingCopy.setState((s) => {
    const prev = s.copies[tabId];
    // Back from a hidden tab with unsaved edits: they stay, with their base.
    if (prev?.dirty && prev.key === t.key && prev.view === t.view) return s;
    return { copies: { ...s.copies, [tabId]: { key: t.key, path: t.path, worktree, repo, base: c.new?.hash ?? null, dirty: false, view: t.view } } };
  });
}

/** The text the shared editor holds for `wc`, or `null` when it shows something else (another
 * tab's file, the other view): never one file's text for another path. */
function editorText(host: MonacoHost, wc: WorkingCopy): string | null {
  return wc.view === 'file' ? host.fileText(wc.key) : host.modifiedText(wc.key);
}

/** The tab is going out of view: dirty edits are kept as a draft, else the copy is dropped. */
export function suspendCopy(tabId: string, host: MonacoHost | null): void {
  const wc = useWorkingCopy.getState().copies[tabId];
  if (!wc) return;
  if (!wc.dirty) return forgetCopy(tabId);
  const text = host ? editorText(host, wc) : null;
  if (text !== null) patch(tabId, { draft: text });
}

export const markDirty = (tabId: string) => patch(tabId, { dirty: true });
export const forgetCopy = (tabId: string) => useWorkingCopy.setState((s) => ({ copies: { ...s.copies, [tabId]: undefined } }));

/**
 * Save (Ctrl+S, §7.5): `writeWorktreeFile` behind the loaded base. Then the fresh lists apply, the base
 * becomes the written bytes' hash, and the file reloads with its cursor and scroll kept.
 * A `Stale` save keeps the text and asks [Reload] [Overwrite]; any other failure toasts.
 */
export async function saveWorkingCopy(tabId: string): Promise<'saved' | 'kept' | 'failed'> {
  const wc = useWorkingCopy.getState().copies[tabId];
  if (!wc) return 'failed';
  // Nothing unsaved (Ctrl+S on a clean copy): no write, so no new inode, mtime or Activity row
  // to wake the user's watchers (2B final I3). The Save button is disabled for the same reason.
  if (!wc.dirty) return 'saved';
  const host = await loadMonacoHost();
  const text = editorText(host, wc);
  if (text === null) {
    toastActionError({ kind: 'Other', message: `Can't save ${wc.path}: the editor isn't showing it`, commandId: null, stderr: null });
    return 'failed';
  }
  const ctx = { tabId, repoId: wc.repo, worktree: wc.worktree };
  const send = async (base: string | null): Promise<'saved' | 'kept' | 'failed'> => {
    try {
      const r = await api.writeWorktreeFile(wc.repo, wc.worktree, wc.path, text, base ?? '');
      applyResult(ctx, r);
      // Typed after the text was read: those edits stay (still dirty), with the new base.
      if (editorText(host, wc) !== text) {
        patch(tabId, { base: r.outcome.hash, dirty: true, draft: undefined });
        return 'kept';
      }
      patch(tabId, { base: r.outcome.hash, dirty: false });
      host.keepViewOnNextShow();
      reload(tabId);
      return 'saved';
    } catch (e) {
      const err = e as GbError;
      if (err?.kind !== 'Stale') {
        toastActionError(err, { retry: () => void send(base) });
        return 'failed';
      }
      const pick = await chooseAction({ title: err.message, body: 'Reload it (your edits are lost), or overwrite it with your text.', choices: [{ id: 'reload', label: 'Reload' }, { id: 'overwrite', label: 'Overwrite', danger: true }] });
      if (pick === 'reload') {
        patch(tabId, { dirty: false, draft: undefined });
        reload(tabId);
        return 'kept';
      }
      if (pick !== 'overwrite') return 'kept';
      const target: DiffTarget = { key: wc.key, path: wc.path, oldPath: null, status: 'M', old: { kind: 'absent' }, new: { kind: 'worktree', worktree: wc.worktree }, view: 'diff' };
      const now = await api.diffContents(wc.repo, contentsRequest(target, true));
      if (!now.new) {
        toastActionError({ kind: 'Other', message: `${wc.path} was deleted on disk; reload to start over`, commandId: null, stderr: null });
        return 'kept';
      }
      return send(now.new.hash);
    }
  };
  return send(wc.base);
}

// --- 2D T20: other unsaved work (the merge tool's) joins the same three guards ---
/** Unsaved work outside the working copy: what the guards ask about, and how to settle it. */
export interface UnsavedWork {
  path: string;
  /** The question's body: what isn't saved. */
  body: string;
  /** Resolves true once saved (a no, a refusal or a failure: false). */
  save(): Promise<boolean>;
  discard(): void;
}
export interface UnsavedSource {
  /** The work in the file `tabId` shows now (leaving it: another file, Esc, ×, Ctrl+W). */
  shown(tabId: string): UnsavedWork | null;
  /** Any of `tabId`'s work (closing the tab). */
  any(tabId: string): UnsavedWork | null;
  /** Any at all (closing the window). */
  anyAtAll(): boolean;
}
const unsavedSources = new Set<UnsavedSource>();
/** Adds `source` to the leave, tab-close and window-close guards; returns its removal. */
export function registerUnsaved(source: UnsavedSource): () => void {
  unsavedSources.add(source);
  return () => void unsavedSources.delete(source);
}
function firstUnsaved(f: (s: UnsavedSource) => UnsavedWork | null): UnsavedWork | null {
  for (const s of unsavedSources) {
    const w = f(s);
    if (w) return w;
  }
  return null;
}
/** The working copy's question, [Save] [Discard edits] [Cancel], for other unsaved work. */
async function askUnsaved(w: UnsavedWork, canSave: boolean): Promise<'saved' | 'discarded' | 'kept'> {
  const choices = [...(canSave ? [{ id: 'save', label: 'Save' }] : []), { id: 'discard', label: 'Discard edits', danger: true }];
  const pick = await chooseAction({ title: `Save your changes to ${w.path}?`, body: w.body, choices });
  if (pick === 'save') return (await w.save()) ? 'saved' : 'kept';
  if (pick === 'discard') {
    w.discard();
    return 'discarded';
  }
  return 'kept';
}
// --- end 2D T20 ---

/** §7.5: leaving the file with unsaved edits (Esc, ↑/↓, ×, another row) asks [Save]
 * [Discard edits] [Cancel]. Returns the guard's removal. */
export function installLeaveGuard(tabId: string, store: RepoViewStore): () => void {
  store.getState().setLeaveGuard((go) => {
    const wc = useWorkingCopy.getState().copies[tabId];
    if (!wc?.dirty) {
      // --- 2D T20 ---
      const other = firstUnsaved((s) => s.shown(tabId));
      if (!other) return false;
      void askUnsaved(other, true).then((pick) => { if (pick === 'saved' || pick === 'discarded') go(); });
      return true;
      // --- end 2D T20 ---
    }
    void chooseAction({ title: `Save your changes to ${wc.path}?`, choices: [{ id: 'save', label: 'Save' }, { id: 'discard', label: 'Discard edits', danger: true }] }).then(async (pick) => {
      if (pick === 'save' && (await saveWorkingCopy(tabId)) === 'saved') go();
      if (pick === 'discard') {
        patch(tabId, { dirty: false, draft: undefined });
        go();
      }
    });
    return true;
  });
  return () => store.getState().setLeaveGuard(null);
}

/** Closing tabs `ids` (the x, the tab menu, Ctrl+W): a tab with unsaved edits asks first
 * ([Save] [Discard edits] [Cancel]); `go` runs once every one is settled. */
export function guardTabClose(ids: string[], go: () => void): void {
  const dirty = ids.find((id) => useWorkingCopy.getState().copies[id]?.dirty);
  if (!dirty) {
    // --- 2D T20 ---
    const other = ids.map((id) => firstUnsaved((s) => s.any(id))).find((w) => w !== null);
    if (!other) return go();
    void askUnsaved(other, true).then((pick) => { if (pick === 'saved' || pick === 'discarded') guardTabClose(ids, go); });
    return;
    // --- end 2D T20 ---
  }
  const wc = useWorkingCopy.getState().copies[dirty]!;
  // Save only when it can succeed: the editor is showing this tab's file right now.
  const shown = loadedHost() !== null && editorText(loadedHost()!, wc) !== null;
  const choices = [...(shown ? [{ id: 'save', label: 'Save' }] : []), { id: 'discard', label: 'Discard edits', danger: true }];
  void chooseAction({ title: `Save your changes to ${wc.path}?`, choices }).then(async (pick) => {
    if (pick === 'save' && (await saveWorkingCopy(dirty)) !== 'saved') return;
    if (pick === 'discard') patch(dirty, { dirty: false, draft: undefined });
    if (pick === 'save' || pick === 'discard') guardTabClose(ids, go);
  });
}

const anyDirty = () => Object.values(useWorkingCopy.getState().copies).some((c) => c?.dirty) || [...unsavedSources].some((s) => s.anyAtAll()); // 2D T20: + other unsaved work
let windowGuard = false;
/** Closing the window with unsaved edits asks (Tauri's close request; `beforeunload` in a browser). Idempotent. */
export function installWindowCloseGuard(): void {
  if (windowGuard) return;
  windowGuard = true;
  try {
    if (!inTauri()) {
      window.addEventListener('beforeunload', (e) => {
        if (!anyDirty()) return;
        e.preventDefault();
        e.returnValue = '';
      });
      return;
    }
  } catch {
    return;
  }
  void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
    const win = getCurrentWindow();
    return win.onCloseRequested((ev) => {
      if (!anyDirty()) return;
      ev.preventDefault();
      void chooseAction({ title: 'Discard unsaved changes?', choices: [{ id: 'discard', label: 'Discard edits', danger: true }] }).then((pick) => {
        if (pick === 'discard') void win.destroy();
      });
    });
  }).catch((e: unknown) => console.warn('[gitbolt] window close events unavailable', e));
}
