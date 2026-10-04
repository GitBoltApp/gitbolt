import { TriangleAlert } from 'lucide-react';
import { relativeTime } from '../format/relative';
import { HoverTooltip } from '../ui/HoverTooltip';
import '../branches/upstreamWarning.css';

/** UX round 4, T.1: the tooltip for a remote whose last fetch failed. `at`: ms epoch. */
export const fetchFailedTip = (reason: string, at: number, now = Date.now()) => `Last fetch failed: ${reason} (${relativeTime(at / 1000, now / 1000)})`;

/** The warning triangle after a Remote row's name, cleared by the remote's next successful fetch. */
export function RemoteFetchWarning({ remote, reason, at }: { remote: string; reason: string; at: number }) {
  const tip = fetchFailedTip(reason, at);
  return (
    <HoverTooltip content={tip}>
      <span className="upstream-warn" role="img" aria-label={tip} data-remote-fetch-warning={remote}>
        <TriangleAlert size={13} aria-hidden />
      </span>
    </HoverTooltip>
  );
}
