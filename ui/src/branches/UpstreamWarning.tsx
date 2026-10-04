import { TriangleAlert } from 'lucide-react';
import { HoverTooltip } from '../ui/HoverTooltip';
import './upstreamWarning.css';

/** UX round 3, M.1: the warning's text for `branch` tracking `upstream` (`origin/feature/b`). */
export const upstreamMismatchTip = (branch: string, upstream: string) => `Tracks ${upstream}, not a branch named ${branch}. That's often a mistake.`;

/**
 * The warning triangle on a local branch whose upstream has another branch name (UX round 3,
 * M.1): first in the branch's graph chip and before its sidebar row's name, with its own instant
 * tooltip. Part of the chip (chipFit.ts counts its width), so the chips don't jump when it shows.
 */
export function UpstreamWarning({ branch, upstream, size = 12 }: { branch: string; upstream: string; size?: number }) {
  const tip = upstreamMismatchTip(branch, upstream);
  return (
    <HoverTooltip content={tip}>
      <span className="upstream-warn" role="img" aria-label={tip}>
        <TriangleAlert size={size} aria-hidden />
      </span>
    </HoverTooltip>
  );
}
