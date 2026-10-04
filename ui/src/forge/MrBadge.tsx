import { useShallow } from 'zustand/react/shallow';
import type { ForgeKind } from '../api/gen/ForgeKind';
import type { ForgeMr } from '../api/gen/ForgeMr';
import type { RefLabel } from '../api/gen/RefLabel';
import { useHoverTooltip } from '../ui/HoverTooltip';
import { MrCardLive } from './MrCardLive';
import { MrStateIcon } from './MrIcons';
import { mrForLabel, mrForUpstream, useForge } from './mrStore';
import { badgeLabel } from './mrText';
import { openMrView } from './poll';
import './mr.css';

export interface ChipMr { mr: ForgeMr; via: string; kind: ForgeKind }

/** A chip's MR/PR, and the ref it was found through (its icon's place, ruling 1). */
export function useChipMr(tabId: string, label: Pick<RefLabel, 'local' | 'remotes'>): ChipMr | null {
  const [mr, via, kind] = useForge(useShallow((s) => {
    const f = s.byTab[tabId];
    const hit = f?.kind ? mrForLabel(f, label) : null;
    return hit && f?.kind ? ([hit.mr, hit.via, f.kind] as const) : ([null, null, null] as const);
  }));
  return mr && via && kind ? { mr, via, kind } : null;
}

/** A branch's MR/PR by its upstream (the sidebar's Local rows). */
function useUpstreamMr(tabId: string, upstream: string | null): [ForgeMr | null, ForgeKind | null] {
  const [mr, kind] = useForge(useShallow((s) => {
    const f = s.byTab[tabId];
    return f?.kind ? ([mrForUpstream(f, upstream), f.kind] as const) : ([null, null] as const);
  }));
  return [mr, kind];
}

/**
 * The badge (spec #4 §2): just a state-coloured icon. A click opens the MR/PR view and does
 * nothing else (the row isn't selected, a double-click doesn't check out). With `tip`, hovering
 * shows its card; the sidebar's rows put the card in their own hover card instead.
 */
export function MrBadge({ tabId, kind, mr, size = 12, tip = true }: { tabId: string; kind: ForgeKind; mr: ForgeMr; size?: number; tip?: boolean }) {
  const { triggerProps, tooltip } = useHoverTooltip({ content: <MrCardLive tabId={tabId} kind={kind} mr={mr} hint="Click to open" />, disabled: !tip });
  return (
    <span
      {...triggerProps}
      className="ref-icon mr-badge"
      role="button"
      tabIndex={-1}
      aria-label={badgeLabel(kind, mr.number, mr.state)}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        openMrView(tabId, mr.number);
      }}
    >
      <MrStateIcon state={mr.state} size={size} />
      {tooltip}
    </span>
  );
}

/** A Local row's badge, at its end. */
export function LocalBranchBadge({ tabId, upstream }: { tabId: string; upstream: string | null }) {
  const [mr, kind] = useUpstreamMr(tabId, upstream);
  return mr && kind ? <MrBadge tabId={tabId} kind={kind} mr={mr} size={13} tip={false} /> : null;
}

/** The sidebar hover card's MR/PR block. */
export function BranchMrBlock({ tabId, upstream }: { tabId: string; upstream: string | null }) {
  const [mr, kind] = useUpstreamMr(tabId, upstream);
  return mr && kind ? <div className="hc-mr"><MrCardLive tabId={tabId} kind={kind} mr={mr} /></div> : null;
}
