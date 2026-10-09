import type { Action } from '../../app/actions';

/**
 * Review comments (spec 2026-10-08 §3): while a review's rendered Markdown diff shows, the
 * comment key (Plan 2's Mod+Alt+C) comments on a block there (`RenderedReview` sets it), not on
 * the line of the editor Diff View keeps attached, hidden, underneath. One at a time, as
 * `setChangeStepper`: a view in a background tab has no effects, so it sets none.
 */
let commenter: (() => void) | null = null;

/** Sets the rendered diff's commenter; returns its removal, which removes only this one. */
export function setBlockCommenter(fn: () => void): () => void {
  commenter = fn;
  return () => { if (commenter === fn) commenter = null; };
}

export const blockCommenter = (): (() => void) | null => commenter;

/** The comment action, the rendered diff's first: usable while a commenter is set, and then it
 * runs that instead of its own. A key the editor takes itself (`keysBy`) is the app's meanwhile,
 * as the hidden editor can't take it. */
export function withBlockComment(a: Action): Action {
  const w: Action = {
    ...a,
    when: () => commenter !== null || (a.when?.() ?? true),
    run: () => {
      const c = commenter;
      if (c) return c();
      return a.run();
    },
  };
  if (a.keysBy !== undefined) Object.defineProperty(w, 'keysBy', { enumerable: true, configurable: true, get: () => (commenter ? undefined : a.keysBy) });
  return w;
}
