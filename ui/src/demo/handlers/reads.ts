// The read handlers: commit details, file lists, diffs, blame, find, … Plan 1b fills this; it's
// spread into HANDLERS after every other group.
import type { HandlerTable } from '../transport';
import { avatarHandlers } from './avatars';
import { cannedHandlers } from './canned';
import { contentsHandlers } from './contents';
import { detailsHandlers } from './details';
import { findHandlers } from './find';
import { filesHandlers } from './files';
import { historyHandlers } from './history';
import { hunksHandlers } from './hunks';
import { integrateHandlers } from './integrate';
import { repoFactsHandlers } from './repoFacts';

export const READ_HANDLERS = {
  ...avatarHandlers,
  ...filesHandlers,
  ...contentsHandlers,
  ...hunksHandlers,
  ...detailsHandlers,
  ...historyHandlers,
  ...findHandlers,
  ...repoFactsHandlers,
  ...integrateHandlers,
  ...cannedHandlers,
} satisfies Partial<HandlerTable>;
