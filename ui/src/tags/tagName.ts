import { useRuntime } from '../app/runtime';
import { branchNameError } from '../branches/branchName';

/** git's ref-name rules for a tag: the branch rules, said of a tag (the core's
 * `names::tag_name_error`, word for word). */
export const tagNameError = (name: string): string | null => branchNameError(name)?.replaceAll('branch', 'tag') ?? null;

/** The rules, then "not already a tag" (the loaded sidebar's tags): the inline input's live check. */
export const tagCreateError = (tabId: string, v: string): string | null =>
  tagNameError(v) ?? (useRuntime.getState().tabs[tabId]?.sidebar?.tags.some((t) => t.name === v) ? `A tag named ${v} already exists` : null);
