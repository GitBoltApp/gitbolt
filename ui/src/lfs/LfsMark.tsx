import { useRepoContext } from '../app/repoContext';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useLfsStatus, useLfsTracked } from './store';
import './lfs.css';

/** A file-list row's mark for a file stored with Git LFS; nothing in a repository without LFS.
 * In one that uses it, every row keeps the mark's space (hidden until known to be LFS), so a
 * name never shifts when the lookup answers. */
export function LfsMark({ path }: { path: string }) {
  const { repoId, worktree } = useRepoContext();
  const used = useLfsStatus(repoId)?.used ?? false;
  const tracked = useLfsTracked(repoId, worktree, path);
  if (!used) return null;
  if (!tracked) return <span className="lfs-mark lfs-mark-off" aria-hidden="true">LFS</span>;
  return (
    <HoverTooltip content="Stored with Git LFS">
      <span className="lfs-mark" role="img" aria-label="Stored with Git LFS" data-testid="lfs-mark">LFS</span>
    </HoverTooltip>
  );
}
