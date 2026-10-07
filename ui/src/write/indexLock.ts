import { api } from '../api/client';
import type { ErrorContext, IndexLockId } from '../errors/describe';
import { confirmAction } from '../ui/ConfirmDialog';
import { useToast } from '../ui/toastStore';

/** The lock's path inside the repository (`.git/index.lock`, `.git/worktrees/x/index.lock`). */
export const lockLabel = (path: string): string => {
  const at = path.lastIndexOf('/.git/');
  return at >= 0 ? path.slice(at + 1) : 'index.lock';
};

/** Remove stale lock (spec #2 §14). Asks first; the backend unlinks the lock only if it's still
 * the file the error saw and no git process runs in the repository. A failure (it changed since:
 * `Stale`; a live process: `IndexLocked`) reaches the caller's toast. */
export async function removeStaleLock(repo: number, lock: IndexLockId): Promise<void> {
  const label = lockLabel(lock.path);
  const ok = await confirmAction({ title: `Remove ${label}?`, body: 'Do this only if no other git program is running.', confirmLabel: 'Remove', arm: `Click again to remove ${label}`, caption: 'Only if no other git program is running.', danger: true });
  if (!ok) return;
  await api.removeIndexLock(repo, lock);
  useToast.getState().show(`Removed ${label}`);
}

/**
 * The toast context for a failed write on `repo`: `base` (Retry, Refresh...) plus Remove stale
 * lock for an IndexLocked error that carries its lock. Every write failure's `toastActionError`
 * call (Undo/Redo and the rest) builds its context with this.
 */
export const writeErrorContext = (repo: number, base: ErrorContext = {}): ErrorContext => ({
  ...base,
  removeLock: (lock) => removeStaleLock(repo, lock),
});
