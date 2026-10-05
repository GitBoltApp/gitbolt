import { api } from '../api/client';
import type { FileChange } from '../api/gen/FileChange';
import type { StageSelection } from '../api/gen/StageSelection';
import type { WipBase } from '../api/gen/WipBase';
import type { WriteResult } from '../api/gen/WriteResult';
import { useRepoContext } from '../app/repoContext';
import { useRepoView } from '../repo/store';
import { confirmAction } from '../ui/ConfirmDialog';
import { runWrite, type WriteCtx } from '../write/client';
import { advanceFrom, followOpenFile } from './follow';
import { stagingKey, useStaging } from './store';

/** The WIP panel's write target: its tab, repo and the worktree of the WIP row it shows
 * (2B Deviation 17). `null` outside a WIP panel. */
export function useWipCtx(): WriteCtx | null {
  const { tabId } = useRepoContext();
  const repoId = useRepoView((s) => s.repo);
  const worktree = useRepoView((s) => (s.panel?.selection.kind === 'wip' ? s.panel.selection.worktree : null));
  return worktree === null ? null : { tabId, repoId, worktree };
}

/** One staging or discard write (TypeScript only asks, spec #2 §3.1): through `runWrite` (its
 * error toast, Retry, Refresh), then the open diff follows the file. `true` once it succeeded.
 * Refused while a commit for the worktree is queued or running (§3.6). */
export async function writeAndFollow(ctx: WriteCtx, send: () => Promise<WriteResult<unknown>>, advance = false): Promise<boolean> {
  if (useStaging.getState().committing[stagingKey(ctx.repoId, ctx.worktree)]) return false;
  // `advance` (a whole-file stage, unstage or discard): the open file's place in its list, before
  // it leaves, so the view can move to the next file (setting "After staging a file…").
  const from = advance ? advanceFrom(ctx.tabId, ctx.worktree) : null;
  // The diff follows only from this write's own fresh lists: a failed write, or an answer without
  // `wip`, would leave `wip.peek` holding stale lists (and a missing file would close the diff).
  let fresh = false;
  // The commit button holds off until this is answered and its lists are in (CommitBox).
  const { addStaging } = useStaging.getState();
  addStaging(ctx.repoId, ctx.worktree, 1);
  let ok: unknown;
  try {
    ok = await runWrite(ctx, async () => {
      const r = await send();
      fresh = !!r.wip;
      return { ...r, outcome: true as const };
    });
  } finally {
    addStaging(ctx.repoId, ctx.worktree, -1);
  }
  if (ok === true && fresh) followOpenFile(ctx.tabId, ctx.worktree, from);
  return ok === true;
}

export const stagePaths = (ctx: WriteCtx, paths: string[]) => writeAndFollow(ctx, () => api.stage(ctx.repoId, ctx.worktree, paths), true);

/** Renames unstage with both paths (§7.2). */
export const unstageFiles = (ctx: WriteCtx, files: FileChange[]) =>
  writeAndFollow(ctx, () => api.unstage(ctx.repoId, ctx.worktree, files.map((f) => f.path), files.flatMap((f) => (f.oldPath ? [f.oldPath] : []))), true);

export const stageAll = (ctx: WriteCtx) => writeAndFollow(ctx, () => api.stageAll(ctx.repoId, ctx.worktree), true);
export const unstageAll = (ctx: WriteCtx) => writeAndFollow(ctx, () => api.unstageAll(ctx.repoId, ctx.worktree), true);

// --- 2B T9: discards (spec #2 §7.2, §7.4). Undoable from the toolbar; only Discard all asks. ---
/** Explicit file paths: a folder row sends the files under it (the backend expands a directory too). */
export const discardPaths = (ctx: WriteCtx, paths: string[]) => writeAndFollow(ctx, () => api.discard(ctx.repoId, ctx.worktree, { kind: 'paths', paths }), true);
export const discardUnstaged = (ctx: WriteCtx) => writeAndFollow(ctx, () => api.discard(ctx.repoId, ctx.worktree, { kind: 'unstaged' }), true);

/** `count`: the changed files the panel shows, for the armed label; `confirmed`: their paths (a
 * rename's both), sent so the backend never discards more than that (UX R1 C.2).
 * One at a time per worktree: a big repository's discard takes seconds, and a click meanwhile
 * (nothing seemed to happen) sent another one. */
export async function discardAll(ctx: WriteCtx, count?: number, confirmed?: readonly string[]): Promise<boolean> {
  const { discarding, setDiscarding } = useStaging.getState();
  if (discarding[stagingKey(ctx.repoId, ctx.worktree)]) return false;
  const arm = count ? `Click again to discard ${count} ${count === 1 ? 'file' : 'files'}` : 'Click again to discard every change';
  const ok = await confirmAction({ title: 'Discard all changes?', body: 'Staged, unstaged and untracked changes are removed. You can undo this.', confirmLabel: 'Discard all', arm, danger: true });
  if (!ok || useStaging.getState().discarding[stagingKey(ctx.repoId, ctx.worktree)]) return false;
  setDiscarding(ctx.repoId, ctx.worktree, true);
  try {
    return await writeAndFollow(ctx, () => api.discard(ctx.repoId, ctx.worktree, confirmed ? { kind: 'all', confirmed: [...confirmed] } : { kind: 'all' }));
  } finally {
    useStaging.getState().setDiscarding(ctx.repoId, ctx.worktree, false);
  }
}
// --- end 2B T9 ---

// --- 2B T13: staging undo (spec #2 §7.6) ---
export const stagingUndo = (ctx: WriteCtx) => writeAndFollow(ctx, () => api.stagingUndo(ctx.repoId, ctx.worktree));
export const stagingRedo = (ctx: WriteCtx) => writeAndFollow(ctx, () => api.stagingRedo(ctx.repoId, ctx.worktree));

/** The buttons' state when the WIP panel opens; every write's answer keeps it current after. */
export async function loadStaging(repo: number, worktree: string): Promise<void> {
  try {
    useStaging.getState().set(repo, worktree, await api.stagingState(repo, worktree));
  } catch (e) {
    console.warn('[gitbolt] staging state', e);
  }
}

// --- 2B T10: hunks and lines (spec #2 §7.3) ---
export const stagePatch = (ctx: WriteCtx, path: string, staged: boolean, selection: StageSelection, base: WipBase) =>
  writeAndFollow(ctx, () => api.stagePatch(ctx.repoId, ctx.worktree, { path, staged, selection, base }));
export const discardPatch = (ctx: WriteCtx, path: string, selection: StageSelection, base: WipBase) =>
  writeAndFollow(ctx, () => api.discard(ctx.repoId, ctx.worktree, { kind: 'patch', path, selection, base }));
// --- end 2B T10 ---
