import { TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { CommitIdentity } from '../api/gen/CommitIdentity';
import { Avatar } from '../avatars/Avatar';
import { HoverTooltip } from '../ui/HoverTooltip';

/** The last answer per worktree: the line shows at once when the box mounts again, then updates. */
const known = new Map<string, CommitIdentity | null>();

/**
 * Who the commit will be made as (ux round 1): git's own resolution (`commitIdentity`), asked
 * each time the box mounts, so a `git config` change shows the next time the WIP is selected.
 * With none, a warning in its place: git would refuse the commit.
 */
export function CommitIdentityLine({ repoId, worktree }: { repoId: number; worktree: string }) {
  const key = `${repoId}\u0000${worktree}`;
  const [who, setWho] = useState<CommitIdentity | null | undefined>(() => known.get(key));
  useEffect(() => {
    let live = true;
    setWho(known.get(key));
    // A rejected (or failed) read leaves the line empty: never an error in the box.
    Promise.resolve().then(() => api.commitIdentity(repoId, worktree)).then(
      (w) => {
        known.set(key, w);
        if (live) setWho(w);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [key, repoId, worktree]);
  if (who === undefined) return <span className="commit-identity" />;
  if (who === null) {
    return (
      <span className="commit-identity warn" data-testid="commit-identity">
        <TriangleAlert size={13} aria-hidden />
        No git identity set: commits will fail
      </span>
    );
  }
  return (
    <HoverTooltip content={`Commits as ${who.name} <${who.email}> (git config user.name, user.email)`}>
      <span className="commit-identity" data-testid="commit-identity">
        <Avatar name={who.name} email={who.email} size={16} />
        <span className="commit-identity-name">{who.name}</span>
        <span className="commit-identity-email">{who.email}</span>
      </span>
    </HoverTooltip>
  );
}
