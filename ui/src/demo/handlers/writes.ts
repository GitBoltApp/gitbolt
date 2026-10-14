// The write handlers (plan 3): each task adds its group here; spread into HANDLERS after the reads.
import type { HandlerTable } from '../transport';
import { branchHandlers } from './branches';
import { commitHandlers } from './commit';
import { conflictHandlers } from './conflicts';
import { checkoutHandlers } from './checkout';
import { discardHandlers } from './discard';
import { journalHandlers } from './journal';
import { mergeHandlers } from './merge';
import { resetHandlers } from './reset';
import { stageHandlers } from './stage';
import { stashHandlers } from './stash';
import { undoHandlers } from './undo';
import { worktreeFileHandlers } from './worktreeFiles';
import { worktreeHandlers } from './worktrees';

export const WRITE_HANDLERS = {
  ...journalHandlers,
  ...stageHandlers,
  ...discardHandlers,
  ...commitHandlers,
  ...branchHandlers,
  ...checkoutHandlers,
  ...mergeHandlers,
  ...conflictHandlers,
  ...resetHandlers,
  ...stashHandlers,
  ...worktreeFileHandlers,
  ...worktreeHandlers,
  ...undoHandlers,
} satisfies Partial<HandlerTable>;
