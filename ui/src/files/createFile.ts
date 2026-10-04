import { FilePlus } from 'lucide-react';
import { create } from 'zustand';
import { api } from '../api/client';
import type { WriteResult } from '../api/gen/WriteResult';
import type { SaveOutcome } from '../api/gen/SaveOutcome';
import { useRuntime } from '../app/runtime';
import { tabIdOf, tabStore } from '../app/tabStores';
import { loadMonacoHost } from '../diff/monaco/load';
import type { MenuRow } from '../menu/types';
import { openWorktree, targetFor, worktreeViewTarget, type DiffTarget, type RepoViewStore } from '../repo/store';
import { promptText } from '../ui/PromptDialog';
import { useToast } from '../ui/toast';
import { runWrite, type WriteCtx } from '../write/client';

/**
 * UX round 3 O.1: Create file…, from a file list's empty space (an inline name input at the top
 * of that list) or the palette (a dialog: a keyboard-started action). The core makes an empty
 * file, its folders too, journaled (Undo removes it); it then opens in File View, editable and
 * focused.
 */

export const CREATE_FILE = 'Create file…';
export const NO_WORKTREE = 'This tab has no working tree to create a file in';

/** The live check of a name: a relative path inside the worktree (the core checks again, and
 * that it doesn't exist yet). `null` when it can be used. */
export function createFilePathError(v: string): string | null {
  if (!v.trim()) return 'Enter a file name';
  if (v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v)) return 'Enter a path relative to the repository';
  if (v.includes('\0') || v.includes('\\')) return 'A file name can\'t contain \\ or NUL';
  const parts = v.split('/');
  if (parts.some((p) => p === '..')) return 'The path can\'t leave the repository (..)';
  if (parts.some((p) => p.trim().replace(/\.+$/, '').toLowerCase() === '.git')) return 'Files can\'t be created in .git';
  if (v.endsWith('/')) return 'Enter a file name after the folder';
  if (parts.some((p) => p === '' || p === '.')) return 'The path has an empty or "." folder';
  return null;
}

/** Where a new file goes in `store`'s tab: its active worktree, or why there's none (a bare
 * repository, a worktree that's gone). */
export function createFileCtx(store: RepoViewStore): { ctx: WriteCtx } | { reason: string } {
  const tabId = tabIdOf(store);
  const rt = tabId ? useRuntime.getState().tabs[tabId] : undefined;
  const s = store.getState();
  if (!tabId || !rt?.repo) return { reason: NO_WORKTREE };
  const worktree = rt.worktree ?? openWorktree(s);
  if (s.graph.openWorktree === undefined && !s.graph.worktrees.some((w) => w.path === worktree)) return { reason: NO_WORKTREE };
  return { ctx: { tabId, repoId: rt.repo.id, worktree } };
}

/** The open inline input: which tab and list (`listKey`) shows it. */
export const useCreateFileInput = create<{ open: { tabId: string; listKey: string; prefill?: string } | null }>(() => ({ open: null }));
export const closeCreateFileInput = () => useCreateFileInput.setState({ open: null });

/** The file list's empty-space menu: Create file…, disabled with its reason without a worktree. */
export function createFileRow(store: RepoViewStore, listKey: string, prefill?: string): MenuRow {
  const where = createFileCtx(store);
  return {
    kind: 'action',
    id: 'files.createFile',
    label: CREATE_FILE,
    icon: FilePlus,
    tooltip: 'Create a new, empty file in the working tree (you can undo this)',
    disabledReason: 'reason' in where ? where.reason : undefined,
    run: () => { if ('ctx' in where) useCreateFileInput.setState({ open: { tabId: where.ctx.tabId, listKey, prefill } }); },
  };
}

/** Puts the keyboard in the editor once File View shows `key` (its contents load first). */
async function focusWhenShown(tabId: string, key: string): Promise<void> {
  const h = await loadMonacoHost();
  const until = performance.now() + 5000;
  while (performance.now() < until) {
    if (tabStore(tabId)?.getState().diff?.key !== key) return;
    if (h.fileText(key) !== null) return h.focus();
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** Creates `path` in `ctx`'s worktree and opens it in File View, editable (UX G.2's working
 * copy). True once created; a refusal (it exists, …) is the write's toast and false. */
export async function createFile(ctx: WriteCtx, path: string): Promise<boolean> {
  let res: WriteResult<SaveOutcome> | null = null;
  const done = await runWrite(ctx, async () => (res = await api.createWorktreeFile(ctx.repoId, ctx.worktree, path)));
  const r = res as WriteResult<SaveOutcome> | null;
  if (done === null || !r) return false;
  const store = tabStore(ctx.tabId);
  if (!store) return true;
  const spec = { kind: 'wip', worktree: r.wip?.worktree ?? ctx.worktree, staged: false } as const;
  const change = r.wip?.unstaged.files.find((f) => f.path === path);
  // An ignored path isn't in the Unstaged list: its working-tree file, as View all files opens it.
  const target: DiffTarget = change ? { ...targetFor(change, spec), view: 'file' } : worktreeViewTarget(path, spec.worktree, spec);
  store.getState().openFile(target);
  void focusWhenShown(ctx.tabId, target.key);
  return true;
}

/** The palette's Create file…: a dialog, or the reason it can't. */
export async function createFileFromPalette(store: RepoViewStore | null): Promise<void> {
  const where = store ? createFileCtx(store) : { reason: NO_WORKTREE };
  if ('reason' in where) return void useToast.getState().show(where.reason);
  const answer = await promptText({ title: 'Create a file', label: 'File path', confirmLabel: 'Create file', validate: createFilePathError });
  if (answer) await createFile(where.ctx, answer.value);
}
