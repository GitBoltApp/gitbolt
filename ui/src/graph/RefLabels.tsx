import { Check, FolderOpen, Laptop, Tag } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RemoteRefLabel } from '../api/gen/RemoteRefLabel';
import { RemoteIcon } from '../icons/brands';
import { GRAPH_COLORS } from '../theme/graphColors';
import { chipRefs, type BranchMembership } from './membership';
import { useHoverTooltip } from '../ui/HoverTooltip';
import { remoteShort } from './refNames';


/** J22's branch-hover focus: a chip entered (the refs it stands for) or left (null). */
type BranchHover = (refs: readonly string[] | null) => void;
const NO_REFS: readonly string[] = [];

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

/** A chip's inside. `compact` (Branch/Tag at its minimum, spec §8.4): icons only, no name; the
 * hover copy (`full`) is never compact, so hovering names the ref. */
function ChipContent({ label, full = false, compact = false }: { label: RefLabel; full?: boolean; compact?: boolean }) {
  return (
    <>
      {/* The checked-out branch's check, ~1.4x the other icons (J21, graph.css .ref-head-check). */}
      {label.isHead && <Check size={12} className="ref-head-check" aria-label="HEAD" />}
      {label.tag && <Tag size={12} aria-label="tag" />}
      {/* No tooltip on the name (F9): the expanded copy already shows it in full. */}
      {!(compact && !full) && <span className={full ? 'ref-name-full' : 'ref-name'}>{label.name}</span>}
      {label.local && <SourceIcon tip={`${label.local.replace(/^refs\/heads\//, '')} (Local)`}><Laptop size={12} aria-label="local" /></SourceIcon>}
      {label.remotes.map((r) => <SourceIcon key={r.fullName} tip={<RemoteTip remote={r} />}><RemoteIcon kind={r.hostKind} remote={r.remote} size={12} /></SourceIcon>)}
      {label.worktree && <SourceIcon tip={`Checked out in ${label.worktree}`}><FolderOpen size={12} aria-label="checked out in another worktree" /></SourceIcon>}
    </>
  );
}

/**
 * A chip: the row's first label, or the dimmed membership chip (J6). `content(full)` renders its
 * inside, resting (`false`) or in the expanded copy (`true`). Hovering it floats an untruncated copy (`.ref-label-full`) exactly over
 * it: absolutely positioned (so the in-flow chip, the `+N` badge and the connector keep their
 * resting geometry) and above the canvas (graph.css). The copy takes the pointer and is a DOM
 * child of the chip, so the chip stays expanded wherever the pointer is over the copy, including
 * the part that sticks out past the resting chip (its source icons and their tooltips, F4); it
 * collapses once the pointer leaves the copy. The copy is never smaller than the chip it covers,
 * so expanding can't move the pointer "out" and back in (no flicker at the edge).
 */
function Chip({ color, className = 'ref-label', content, refs = NO_REFS, onBranchHover, onContextMenu }: { color: string; className?: string; content: (full: boolean) => ReactNode; refs?: readonly string[]; onBranchHover?: BranchHover; onContextMenu?: (e: MouseEvent<HTMLElement>) => void }) {
  const [expanded, setExpanded] = useState(false);
  // J22: entering a branch chip starts its branch's focus, leaving ends it. A chip unmounted
  // under the pointer (scrolled out of the virtual window) never gets its mouseleave: end it then.
  const focusing = useRef<BranchHover | null>(null);
  useEffect(() => () => focusing.current?.(null), []);
  const enter = () => {
    setExpanded(true);
    if (!onBranchHover || refs.length === 0) return;
    focusing.current = onBranchHover;
    onBranchHover(refs);
  };
  const leave = () => {
    setExpanded(false);
    focusing.current?.(null);
    focusing.current = null;
  };
  return (
    <span
      className={className}
      style={{ ['--lane-color' as string]: color }}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onContextMenu={onContextMenu}
    >
      {content(false)}
      {expanded && (
        <span className="ref-label ref-label-full" aria-hidden="true">
          {content(true)}
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

/** The dimmed branch-membership chip itself (F7): the chip look at half opacity, just the branch name, no tooltip (F9). Otherwise it behaves like the first chip
 * (J6): hovered, it lights up to full strength and floats its untruncated copy, and a press on
 * it selects the row. */
function DimChip({ membership, onBranchHover }: { membership: BranchMembership; onBranchHover?: BranchHover }) {
  return (
    <Chip
      className="ref-label ref-label-dim"
      refs={[membership.ref]}
      onBranchHover={onBranchHover}
      color={GRAPH_COLORS[membership.color % GRAPH_COLORS.length]}
      content={(full) => <span className={full ? 'ref-name-full' : 'ref-name'}>{membership.name}</span>}
    />
  );
}

/**
 * A row's chips. `compact`: Branch/Tag is at its minimum (spec §8.4), so the first chip shows
 * its icons only (HEAD's check, tag, local, remotes, worktree), in the lane colour; the `+N`
 * badge, the dimmed chip and the connector are unchanged. `membership` (a hovered or selected row that isn't its branch's tip, F7) adds
 * the dimmed chip: alone on a row without chips; otherwise after the real chip and `+N` badge, in
 * `.ref-dim-slot`, which gives up its width before the real chip does and drops the dimmed chip
 * whole when it doesn't fit (graph.css), so it never truncates or displaces a real chip.
 */
export function RefLabels({ labels, color, membership = null, onBranchHover, compact = false, onContextMenu }: {
  labels: RefLabel[];
  color: number;
  membership?: BranchMembership | null;
  onBranchHover?: BranchHover;
  compact?: boolean;
  /** Right-clicking the row's own (first) label chip: the commit or tag menu for that branch or
   * tag (plan 1C Task 15). Not on the `+N` overflow badge or the dimmed membership chip. */
  onContextMenu?: (label: RefLabel, e: MouseEvent<HTMLElement>) => void;
}) {
  if (labels.length === 0) return membership ? <span className="ref-labels"><DimChip membership={membership} onBranchHover={onBranchHover} /></span> : null;
  const c = GRAPH_COLORS[color % GRAPH_COLORS.length];
  const rest = labels.slice(1);
  // The checked-out branch (HEAD's label always sorts first): its chip is always lit and its
  // connector is the graph line's width and colour (J21, graph.css; draw.ts `headRow`).
  const head = labels[0].isHead;
  return (
    // `--lane-color` is set here (not just on the chip) so `.ref-connector`, a sibling of the
    // chip, can read it too: it continues the connector drawn in the canvas (see draw.ts).
    <span className={head ? 'ref-labels ref-labels-head' : 'ref-labels'} style={{ ['--lane-color' as string]: c }}>
      <Chip
        color={c}
        className={`ref-label${head ? ' ref-label-head' : ''}${compact ? ' compact' : ''}`}
        refs={chipRefs(labels[0])}
        onBranchHover={onBranchHover}
        onContextMenu={onContextMenu && ((e) => onContextMenu(labels[0], e))}
        content={(full) => <ChipContent label={labels[0]} full={full} compact={compact} />}
      />
      {rest.length > 0 && <More rest={rest} />}
      {membership && (
        <span className="ref-dim-slot">
          <span className="ref-dim-fill" />
          <DimChip membership={membership} onBranchHover={onBranchHover} />
        </span>
      )}
      <span className="ref-connector" />
    </span>
  );
}
