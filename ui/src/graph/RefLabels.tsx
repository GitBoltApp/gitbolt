import { Check, Cloud, FolderOpen, Laptop, Tag } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RemoteRefLabel } from '../api/gen/RemoteRefLabel';
import { GRAPH_COLORS } from '../theme/graphColors';
import type { BranchMembership } from './membership';
import { useHoverTooltip } from '../ui/HoverTooltip';
import { remoteShort } from './refNames';


/** A remote-only label's `name` is just the branch part (the payload drops the remote name,
 * since the chip's remote icons say it's remote). The `+N` tooltip is plain text with no icons,
 * so there it gets its remote prefix back, for every remote it's on. */
const overflowName = (l: RefLabel) => (!l.local && l.remotes.length > 0 ? l.remotes.map(remoteShort).join(', ') : l.name);

/** A remote icon's tooltip (H12): `origin → <branch> (Remote)`, the remote's name in the
 * tooltip's normal colour and the branch dimmed (graph.css). The branch is the remote's own name
 * for it (it may differ from the local branch's). */
function RemoteTip({ remote }: { remote: RemoteRefLabel }) {
  const branch = remote.fullName.replace(/^refs\/remotes\//, '').slice(remote.remote.length + 1);
  return <><span className="ref-tip-remote">{remote.remote}</span> → <span className="ref-tip-branch">{branch}</span> (Remote)</>;
}

/**
 * A source icon (local, a remote, another worktree), with its own instant tooltip naming that
 * one ref by its short name (`main (Local)`, `origin → main (Remote)`; never `refs/heads/…`).
 * Both the resting chip's icons and the expanded copy's have it (H12): the copy covers the
 * resting chip once the chip is hovered, but the browser only moves the hover onto the copy on
 * the next pointer move (or a later synthetic one), so a pointer that lands straight on a resting
 * icon gets its tooltip at once from that icon. The wrapper is the same in both, so the copy lays
 * out exactly like the chip.
 */
function SourceIcon({ tip, children }: { tip: ReactNode; children: ReactNode }) {
  const { triggerProps, tooltip } = useHoverTooltip({ content: tip });
  return (
    <span className="ref-icon" {...triggerProps}>
      {children}
      {tooltip}
    </span>
  );
}

function ChipContent({ label, full = false }: { label: RefLabel; full?: boolean }) {
  return (
    <>
      {label.isHead && <Check size={12} aria-label="HEAD" />}
      {label.tag && <Tag size={12} aria-label="tag" />}
      {/* No tooltip on the name (F9): the expanded copy already shows it in full. */}
      <span className={full ? 'ref-name-full' : 'ref-name'}>{label.name}</span>
      {label.local && <SourceIcon tip={`${label.local.replace(/^refs\/heads\//, '')} (Local)`}><Laptop size={12} aria-label="local" /></SourceIcon>}
      {label.remotes.map((r) => <SourceIcon key={r.fullName} tip={<RemoteTip remote={r} />}><Cloud size={12} aria-label={`remote ${r.remote}`} /></SourceIcon>)}
      {label.worktree && <SourceIcon tip={`Checked out in ${label.worktree}`}><FolderOpen size={12} aria-label="checked out in another worktree" /></SourceIcon>}
    </>
  );
}

/**
 * The row's first label. Hovering it floats an untruncated copy (`.ref-label-full`) exactly over
 * it: absolutely positioned (so the in-flow chip, the `+N` badge and the connector keep their
 * resting geometry) and above the canvas (graph.css). The copy takes the pointer and is a DOM
 * child of the chip, so the chip stays expanded wherever the pointer is over the copy, including
 * the part that sticks out past the resting chip (its source icons and their tooltips, F4); it
 * collapses once the pointer leaves the copy. The copy is never smaller than the chip it covers,
 * so expanding can't move the pointer "out" and back in (no flicker at the edge).
 */
function Chip({ label, color }: { label: RefLabel; color: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <span
      className="ref-label"
      style={{ ['--lane-color' as string]: color }}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
    >
      <ChipContent label={label} />
      {expanded && (
        <span className="ref-label ref-label-full" aria-hidden="true">
          <ChipContent label={label} full />
        </span>
      )}
    </span>
  );
}

function More({ rest }: { rest: RefLabel[] }) {
  const { triggerProps, tooltip } = useHoverTooltip({ content: rest.map(overflowName).join('\n') });
  return (
    <span className="ref-more" {...triggerProps}>
      +{rest.length}
      {tooltip}
    </span>
  );
}

/** The dimmed branch-membership chip itself (F7): the chip look at half opacity,
 * just the branch name, inert (`pointer-events: none`: no tooltip, and a press on it
 * is a press on the empty cell). */
function DimChip({ membership }: { membership: BranchMembership }) {
  return (
    <span className="ref-label ref-label-dim" style={{ ['--lane-color' as string]: GRAPH_COLORS[membership.color % GRAPH_COLORS.length] }}>
      <span className="ref-name">{membership.name}</span>
    </span>
  );
}

/**
 * A row's chips. `membership` (a hovered or selected row that isn't its branch's tip, F7) adds
 * the dimmed chip: alone on a row without chips; otherwise after the real chip and `+N` badge, in
 * `.ref-dim-slot`, which gives up its width before the real chip does and drops the dimmed chip
 * whole when it doesn't fit (graph.css), so it never truncates or displaces a real chip.
 */
export function RefLabels({ labels, color, membership = null }: { labels: RefLabel[]; color: number; membership?: BranchMembership | null }) {
  if (labels.length === 0) return membership ? <span className="ref-labels"><DimChip membership={membership} /></span> : null;
  const c = GRAPH_COLORS[color % GRAPH_COLORS.length];
  const rest = labels.slice(1);
  return (
    // `--lane-color` is set here (not just on the chip) so `.ref-connector`, a sibling of the
    // chip, can read it too: it continues the connector drawn in the canvas (see draw.ts).
    <span className="ref-labels" style={{ ['--lane-color' as string]: c }}>
      <Chip label={labels[0]} color={c} />
      {rest.length > 0 && <More rest={rest} />}
      {membership && (
        <span className="ref-dim-slot">
          <span className="ref-dim-fill" />
          <DimChip membership={membership} />
        </span>
      )}
      <span className="ref-connector" />
    </span>
  );
}
