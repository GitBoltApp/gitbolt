import type { GbError } from '../api/gen/GbError';
import type { GbErrorKind } from '../api/gen/GbErrorKind';

/** Pure error model (spec §16.1): what an error says and which actions it offers. The toast (R12) renders it. */

export const isGbError = (e: unknown): e is GbError =>
  !!e && typeof e === 'object' && 'kind' in e && typeof (e as { message?: unknown }).message === 'string';

export const toGbError = (e: unknown): GbError =>
  isGbError(e) ? e : { kind: 'Other', message: e instanceof Error ? e.message : String(e), commandId: null, stderr: null };

export interface ErrorContext { retry?: () => void | Promise<void>; refresh?: () => void | Promise<void>; removeRecent?: () => void | Promise<void> }
export interface ErrorAction { id: 'retry' | 'refresh' | 'remove-recent' | 'copy' | 'details'; label: string; run(): void | Promise<void> }
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
};

/** Title and message for a notification, or null for errors that never notify (Cancelled). */
export function describeError(err: GbError): { title: string; message: string } | null {
  if (err.kind === 'Cancelled') return null;
  const title = TITLES[err.kind];
  if (err.kind === 'RefMoved') return { title, message: 'Branch changed outside GitBolt — refresh and retry' };
  if (err.kind === 'IndexLocked') {
    // "Remove stale lock" would write to the repository; that action arrives with #2 (plan 1D, Deviation 1).
    return { title, message: `${err.message}\nAnother git process may be running. If none is, remove .git/index.lock yourself.` };
  }
  return { title, message: err.message };
}

type Slot = 'retry' | 'refresh' | 'remove-recent' | 'copy';
const SLOTS: Record<GbErrorKind, Slot[]> = {
  AuthFailed: ['retry'], NonFastForward: ['refresh'], Conflict: ['refresh'], DirtyWorktree: ['refresh'], RefMoved: ['refresh'],
  IndexLocked: ['retry'], NotFound: ['remove-recent'], InvalidInput: [], GitTooOld: [], Io: ['copy'], Other: ['copy'], Cancelled: [],
};

/** Suggested actions for one error (spec §16.1): the kind's slots the context can fill, then Details if a command is linked. */
export function actionsFor(err: GbError, ctx: ErrorContext, deps: ErrorDeps): ErrorAction[] {
  const out: ErrorAction[] = [];
  if (err.kind === 'Cancelled') return out;
  for (const slot of SLOTS[err.kind]) {
    if (slot === 'retry' && ctx.retry) out.push({ id: 'retry', label: 'Retry', run: ctx.retry });
    if (slot === 'refresh' && ctx.refresh) out.push({ id: 'refresh', label: 'Refresh', run: ctx.refresh });
    if (slot === 'remove-recent' && ctx.removeRecent) out.push({ id: 'remove-recent', label: 'Remove from recent', run: ctx.removeRecent });
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
