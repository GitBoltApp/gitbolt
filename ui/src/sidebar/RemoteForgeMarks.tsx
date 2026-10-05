import { TriangleAlert } from 'lucide-react';
import { HoverTooltip } from '../ui/HoverTooltip';
import '../branches/upstreamWarning.css';

/** The dim "main" chip on the remote whose forge project the repo's MRs/PRs target. */
export function RemoteMainChip({ remote, kind, chosen }: { remote: string; kind: string | null; chosen: boolean }) {
  const noun = kind === 'github' ? 'pull requests' : 'merge requests';
  const tip = chosen ? `The main remote: its forge project is used for ${noun}` : 'Picked automatically: right-click a remote to choose';
  return (
    <HoverTooltip content={tip}>
      <span className={chosen ? 'sb-main-chip' : 'sb-main-chip sb-main-auto'} data-remote-main={remote}>{chosen ? 'main' : 'main (auto)'}</span>
    </HoverTooltip>
  );
}

/** A dim warning after a remote's name: why its forge project couldn't be loaded. */
export function RemoteLookupWarning({ remote, reason }: { remote: string; reason: string }) {
  const tip = `Not on the forge: ${reason}`;
  return (
    <HoverTooltip content={tip}>
      <span className="upstream-warn sb-lookup-warn" role="img" aria-label={tip} data-remote-lookup-warning={remote}>
        <TriangleAlert size={13} aria-hidden />
      </span>
    </HoverTooltip>
  );
}
