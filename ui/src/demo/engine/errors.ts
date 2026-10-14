// GbError values as the core makes them: the demo's handlers fail the way the backend does.
import type { GbError } from '../../api/gen/GbError';
import type { GbErrorKind } from '../../api/gen/GbErrorKind';
import { isGbError } from '../../errors/describe';

export function gbError(kind: GbErrorKind, message: string): GbError {
  return { kind, message, commandId: null, stderr: null };
}

/** The core's `classify_stderr` (error.rs): the first rule, in this order, with a phrase git's stderr
 *  holds; `Other` when none does. */
const RULES: [GbErrorKind, string[]][] = [
  ['IndexLocked', [".lock': File exists"]],
  ['RefMoved', ['but expected', 'cannot lock ref', '(stale info)']],
  ['AuthFailed', ['Authentication failed', 'could not read Username', 'could not read Password', 'Permission denied (publickey', 'terminal prompts disabled', 'HTTP Basic: Access denied']],
  ['NonFastForward', ['Not possible to fast-forward', 'non-fast-forward', "Diverging branches can't be fast-forwarded", '(fetch first)', 'is not fully merged']],
  ['Conflict', ['CONFLICT (', 'Merge conflict', 'needs merge', 'resolve your current index first', 'Conflicts in index']],
  ['DirtyWorktree', ['would be overwritten by', 'Please commit your changes or stash them', 'untracked working tree files would be overwritten', 'not uptodate. Cannot merge']],
  ['InvalidInput', ['is already checked out at', 'is already used by worktree at', 'nothing to commit']],
  ['NotFound', ['not a git repository', 'unknown revision', 'did not match any file(s) known to git', 'bad revision', 'does not appear to be a git repository', 'There is no tracking information']],
];

export function classifyStderr(stderr: string): GbErrorKind {
  return RULES.find(([, needles]) => needles.some((n) => stderr.includes(n)))?.[0] ?? 'Other';
}

/** A git command's failure as the core reports it: `message` (git's line), its kind from the whole
 *  `stderr`. */
export function gitFailure(message: string, stderr: string): GbError {
  return { ...gbError(classifyStderr(stderr), message), stderr };
}

export const NOT_IN_DEMO = 'Not in the demo: ';

/** What a browser can't do (spec §4.3, the "Not in the demo" tier): the UI shows the message. */
export function notInDemo(what: string): never {
  throw gbError('Other', `${NOT_IN_DEMO}${what}`);
}

/** Anything a handler threw, as the GbError a backend would have sent. */
export function asGbError(e: unknown): GbError {
  if (isGbError(e)) return e;
  return gbError('Other', e instanceof Error ? e.message : String(e));
}
