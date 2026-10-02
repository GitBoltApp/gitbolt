import type { GbError } from '../api/gen/GbError';
import type { GbErrorKind } from '../api/gen/GbErrorKind';

/** Pure error model (spec §16.1): what an error says and which actions it offers. The toast (R12) renders it. */

export const isGbError = (e: unknown): e is GbError =>
  !!e && typeof e === 'object' && 'kind' in e && typeof (e as { message?: unknown }).message === 'string';

export const toGbError = (e: unknown): GbError =>
  isGbError(e) ? e : { kind: 'Other', message: e instanceof Error ? e.message : String(e), commandId: null, stderr: null };

/** The lock an IndexLocked error saw: its path, mtime and identity. */
export interface IndexLockId { path: string; mtimeMs: number; ino: number; dev: number }
export interface ErrorContext {
  retry?: () => void | Promise<void>;
  refresh?: () => void | Promise<void>;
  removeRecent?: () => void | Promise<void>;
  /** Remove stale lock (spec #2 §14): asks, then removes the lock the error saw. */
  removeLock?: (lock: IndexLockId) => void | Promise<void>;
}
export interface ErrorAction { id: 'retry' | 'refresh' | 'remove-recent' | 'remove-lock' | 'copy' | 'details'; label: string; run(): void | Promise<void> }
export interface ErrorDeps { openDetails(commandId: number): void; copy(text: string): Promise<void> }

const TITLES: Record<Exclude<GbErrorKind, 'Cancelled'>, string> = {
  AuthFailed: 'Authentication failed',
  NonFastForward: 'Branch has diverged',
  Conflict: 'Merge conflict',
  DirtyWorktree: 'Uncommitted changes in the way',
  IndexLocked: 'Repository is locked',
  RefMoved: 'Branch changed outside GitBolt',
  NotFound: 'Not found',
  InvalidInput: 'Invalid input',
  GitTooOld: 'git is too old',
  Io: 'File system error',
  Other: 'Something went wrong',
  HookFailed: 'A hook failed',
  InProgress: 'Operation in progress',
  Stale: 'Changed since it was shown',
};

/** Title and message for a notification, or null for errors that never notify (Cancelled). */
export function describeError(err: GbError): { title: string; message: string } | null {
  if (err.kind === 'Cancelled') return null;
  const title = TITLES[err.kind];
  if (err.kind === 'RefMoved') return { title, message: 'Branch changed outside GitBolt — refresh and retry' };
  if (err.kind === 'IndexLocked') {
    // Spec #2 §14: Remove stale lock arrives with the lock's detail; without it, the hand-made way.
    return err.detail?.kind === 'indexLock'
      ? { title, message: `${err.message}\nAnother git program may be running.` }
      : { title, message: `${err.message}\nAnother git process may be running. If none is, remove .git/index.lock yourself.` };
  }
  if (err.kind === 'HookFailed') {
    const hook = err.detail?.kind === 'hook' ? err.detail.hook : null;
    return { title: hook ? `${hook} hook failed` : title, message: err.message };
  }
  // Spec #2 §15: the message is the title ("A rebase is in progress", "a.php changed since it was shown").
  if (err.kind === 'InProgress') return { title: err.message, message: 'Finish or abort it first' };
  if (err.kind === 'Stale') return { title: err.message, message: 'Refreshed: try again' };
  // --- 2C T12 ---
  // "<path> is a repository in the way of the checkout: move it first": a refusal, readable as one.
  if (err.kind === 'InvalidInput' && /is a repository in the way of the /.test(err.message)) return { title: 'A repository is in the way', message: err.message.replace(/^(.*?) is a repository in the way of the (\w+): move it first$/, '$1 can\'t be replaced during the $2: move it first') };
  // --- end 2C T12 ---
  return { title, message: err.message };
}

type Slot = 'retry' | 'refresh' | 'remove-recent' | 'remove-lock' | 'copy';
const SLOTS: Record<GbErrorKind, Slot[]> = {
  AuthFailed: ['retry'], NonFastForward: ['refresh'], Conflict: ['refresh'], DirtyWorktree: ['refresh'], RefMoved: ['refresh'],
  IndexLocked: ['remove-lock', 'retry'], NotFound: ['remove-recent'], InvalidInput: [], GitTooOld: [], Io: ['copy'], Other: ['copy'], Cancelled: [],
  HookFailed: ['retry'], InProgress: [], Stale: ['refresh'],
};

/** Suggested actions for one error (spec §16.1): the kind's slots the context can fill, then Details if a command is linked. */
export function actionsFor(err: GbError, ctx: ErrorContext, deps: ErrorDeps): ErrorAction[] {
  const out: ErrorAction[] = [];
  if (err.kind === 'Cancelled') return out;
  for (const slot of SLOTS[err.kind]) {
    if (slot === 'retry' && ctx.retry) out.push({ id: 'retry', label: 'Retry', run: ctx.retry });
    if (slot === 'refresh' && ctx.refresh) out.push({ id: 'refresh', label: 'Refresh', run: ctx.refresh });
    if (slot === 'remove-recent' && ctx.removeRecent) out.push({ id: 'remove-recent', label: 'Remove from recent', run: ctx.removeRecent });
    if (slot === 'remove-lock' && ctx.removeLock && err.detail?.kind === 'indexLock') {
      const { path, mtimeMs, ino, dev } = err.detail;
      const lock = { path, mtimeMs, ino, dev };
      const remove = ctx.removeLock;
      out.push({ id: 'remove-lock', label: 'Remove stale lock', run: () => remove(lock) });
    }
    if (slot === 'copy') {
      const d = describeError(err);
      out.push({ id: 'copy', label: 'Copy error', run: () => deps.copy([d?.title, d?.message, err.stderr].filter(Boolean).join('\n')) });
    }
  }
  if (err.commandId !== null && err.kind !== 'InvalidInput' && err.kind !== 'GitTooOld') {
    const id = err.commandId;
    out.push({ id: 'details', label: 'Details', run: () => deps.openDetails(id) });
  }
  return out;
}
