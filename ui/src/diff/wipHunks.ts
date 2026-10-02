import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { HunksPayload } from '../api/gen/HunksPayload';
import { useRepoView, type DiffTarget } from '../repo/store';
import { wipKey } from '../repo/wipLists';

/** A WIP diff's side, from its key (`filesKey(spec)|path`); `null` for any other diff. */
export function wipSideOf(t: Pick<DiffTarget, 'key' | 'path'>): { worktree: string; staged: boolean } | null {
  try {
    const spec = JSON.parse(t.key.slice(0, t.key.length - t.path.length - 1)) as { kind: string; worktree?: string; staged?: boolean };
    return spec.kind === 'wip' && typeof spec.worktree === 'string' ? { worktree: spec.worktree, staged: !!spec.staged } : null;
  } catch {
    return null;
  }
}

/** The open WIP file's hunks from the backend (§7.3), read again whenever its list's version
 * moves (a stage, a discard, a save, the watcher) or `epoch` does (the diff was shown anew).
 * `null` while loading, or for a non-WIP diff. */
export function useWipHunks(repoId: number, target: DiffTarget, epoch = 0): HunksPayload | null {
  const side = wipSideOf(target);
  const version = useRepoView((s) => (side ? s.services.wip.peek(wipKey(side.worktree, side.staged))?.version ?? null : null));
  const [state, setState] = useState<{ key: string; hunks: HunksPayload } | null>(null);
  const key = `${target.key}\u0000${version ?? ''}\u0000${epoch}`;
  useEffect(() => {
    if (!side) return;
    let live = true;
    api.wipHunks(repoId, side.worktree, target.path, side.staged).then(
      (hunks) => { if (live) setState({ key, hunks }); },
      () => { if (live) setState(null); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, key]);
  return state?.key === key ? state.hunks : null;
}
