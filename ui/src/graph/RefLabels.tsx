import { PendingMark } from '../pending/PendingMark';
import { usePendingAny } from '../pending/store';
import { Check, Laptop, LoaderCircle, Tag, TreePine } from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RemoteRefLabel } from '../api/gen/RemoteRefLabel';
import { RemoteIcon } from '../icons/brands';
import { useTheme } from '../theme/store';
import { chipRefs, type BranchMembership } from './membership';
import { useHoverTooltip } from '../ui/HoverTooltip';
import { CHIP_SPACING, chipFont, chipWidth, fitCount, rebasingWidth } from './chipFit';
import { UpstreamWarning } from '../branches/UpstreamWarning';
import { TagTip } from '../tags/TagTip';
// --- 4B T10 ---
import { useRepoContext } from '../app/repoContext';
import { MrBadge, useChipMr } from '../forge/MrBadge';
import { mrForLabel, useForge } from '../forge/mrStore';
import { useShallow } from 'zustand/react/shallow';
// --- end 4B T10 ---


/** J22's branch-hover focus: a chip entered (the refs it stands for) or left (null). */
type BranchHover = (refs: readonly string[] | null) => void;
const NO_REFS: readonly string[] = [];


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

// --- 2D T18 ---
/** The branch a rebase is replaying, at HEAD's row while its worktree rebases (Deviation 10):
 * a spinner and the name, dashed. HEAD is detached then, so the branch has no chip of its own.
 * A `Chip` like the others (UX round 2): hovered, it floats its untruncated copy over its
 * neighbours. */
function RebasingChip({ name }: { name: string }) {
  return (
    <Chip
      className="ref-label ref-label-head ref-rebasing"
      ariaLabel={`${name} (rebasing)`}
      tip={`${name} is being rebased`}
      content={(full) => (
        <>
          <LoaderCircle size={12} className="spin" aria-hidden />
          <span className={full ? 'ref-name-full' : 'ref-name'}>{name}</span>
        </>
      )}
    />
  );
}
// --- end 2D T18 ---

/** The detached HEAD's label (snapshot.rs: named `HEAD`, no local, remote or tag). */
export const isDetachedHead = (l: RefLabel) => l.isHead && l.name === 'HEAD' && l.local === null && !l.tag && l.remotes.length === 0;

/** A chip's inside. `compact` (Branch/Tag at its minimum, spec §8.4): icons only, no name; the
 * hover copy (`full`) is never compact, so hovering names the ref. */
// Lucide's outline icons leave ~2/24 padding inside their box, while the brand marks fill theirs
// edge to edge: at the same nominal size the laptop reads smaller than the GitLab mark. Outline
// source icons go one step up so all source icons look the same size.
export const SOURCE_OUTLINE = 14;

function ChipContent({ label, full = false, compact = false }: { label: RefLabel; full?: boolean; compact?: boolean }) {
  // --- 4B T10: the MR/PR badge, its own icon after the local and remote ones (they keep saying
  // where the branch is, and the PR icon sits beside them). chipFit counts it. ---
  const { tabId } = useRepoContext();
  const badge = useChipMr(tabId, label);
  // The spinner while an action runs on this branch (src/pending): a checkout's sits where its
  // checkmark will appear (the left of the chip); any other action's takes the source icon's place.
  const pending = usePendingAny(tabId, [label.local, ...label.remotes.map((r) => r.fullName)]);
  const checkingOut = pending === 'checkout' && !label.isHead;
  const spinHere: 'local' | number | null = !pending || label.isHead || checkingOut ? null : label.local ? 'local' : label.remotes.length ? 0 : null;
  // --- end 4B T10 ---
  return (
    <>
      {/* UX round 3, M.1: an upstream with another branch name, first in the chip (its width counted in chipFit.ts). */}
      {label.upstreamMismatch && <UpstreamWarning branch={label.name} upstream={label.upstreamMismatch} />}
      {/* The checked-out branch's check, ~1.4x the other icons (J21, graph.css .ref-head-check). */}
      {label.isHead && (pending ? <PendingMark action={pending} className="ref-head-check" /> : <Check size={12} className="ref-head-check" aria-label="HEAD" />)}
      {checkingOut && <PendingMark action="checkout" className="ref-head-check" />}
      {/* UX round 3, M.2: an annotated tag's icon is filled, a lightweight one's outlined. */}
      {label.tag && (label.annotation ? <Tag size={12} fill="currentColor" className="ref-tag-annotated" aria-label="annotated tag" /> : <Tag size={12} aria-label="tag" />)}
      {/* No tooltip on the name (F9): the expanded copy already shows it in full. */}
      {!(compact && !full) && <span className={full ? 'ref-name-full' : 'ref-name'}>{label.name}</span>}
      {/* A non-HEAD chip has no check box: the spinner stands in for its first source icon, at its size, so the chip's width holds (chipFit). */}
      {label.local && <SourceIcon tip={`${label.local.replace(/^refs\/heads\//, '')} (Local)`}>{spinHere === 'local' ? <PendingMark action={pending!} size={SOURCE_OUTLINE} /> : <Laptop size={SOURCE_OUTLINE} aria-label="local" />}</SourceIcon>}
      {label.remotes.map((r, i) => <Fragment key={r.fullName}><SourceIcon tip={<RemoteTip remote={r} />}>{spinHere === i ? <PendingMark action={pending!} size={12} /> : <RemoteIcon kind={r.hostKind} host={r.host} remote={r.remote} size={12} tabId={tabId} />}</SourceIcon></Fragment>)}
      {label.worktree && <SourceIcon tip={`Checked out in ${label.worktree}`}><TreePine size={SOURCE_OUTLINE} aria-label="checked out in another worktree" /></SourceIcon>}
      {badge && <MrBadge tabId={tabId} kind={badge.kind} mr={badge.mr} size={SOURCE_OUTLINE} />}
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
function Chip({ color, className = 'ref-label', content, refs = NO_REFS, onBranchHover, onContextMenu, onDoubleClick, stack, tip, ariaLabel }: { /** Omitted: the lane colour inherited from `.ref-labels`. */ color?: string; className?: string; content: (full: boolean) => ReactNode; stack?: () => ReactNode; refs?: readonly string[]; onBranchHover?: BranchHover; onContextMenu?: (e: MouseEvent<HTMLElement>) => void; onDoubleClick?: (e: MouseEvent<HTMLElement>) => void; /** The chip's own instant tooltip (the rebasing and the icon-only detached HEAD chips). */ tip?: ReactNode; ariaLabel?: string }) {
  const [expanded, setExpanded] = useState(false);
  const { triggerProps, tooltip } = useHoverTooltip({ content: tip ?? null, disabled: tip === undefined });
  // J22: entering a branch chip starts its branch's focus, leaving ends it. A chip unmounted
  // under the pointer (scrolled out of the virtual window) never gets its mouseleave: end it then.
  const focusing = useRef<BranchHover | null>(null);
  useEffect(() => () => focusing.current?.(null), []);
  const enter = (e: MouseEvent<HTMLElement>) => {
    triggerProps.onMouseEnter?.(e);
    setExpanded(true);
    if (!onBranchHover || refs.length === 0) return;
    focusing.current = onBranchHover;
    onBranchHover(refs);
  };
  const leave = (e: MouseEvent<HTMLElement>) => {
    triggerProps.onMouseLeave?.(e);
    setExpanded(false);
    focusing.current?.(null);
    focusing.current = null;
  };
  return (
    <span
      {...triggerProps}
      className={className}
      aria-label={ariaLabel}
      style={color === undefined ? undefined : { ['--lane-color' as string]: color }}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
    >
      {content(false)}
      {expanded && (stack ? stack() : (
        <span className="ref-label ref-label-full" aria-hidden="true">
          {content(true)}
        </span>
      ))}
      {tooltip}
    </span>
  );
}

/** One row of the label stack (K77): a full chip for one ref. Hovering it starts that ref's
 * branch focus (J22), ended on leaving or unmounting; right-clicking opens that label's menu. */
function StackRow({ label, sha, first, onBranchHover, onContextMenu, onDoubleClick }: { label: RefLabel; sha: string | null; first: boolean; onBranchHover?: BranchHover; onContextMenu?: (label: RefLabel, e: MouseEvent<HTMLElement>) => void; onDoubleClick?: (label: RefLabel, e: MouseEvent<HTMLElement>) => void }) {
  const focusing = useRef<BranchHover | null>(null);
  useEffect(() => () => focusing.current?.(null), []);
  // A tag's row has the tag's tooltip, as its chip does (UX round 3, M.2); not the first row, which
  // lies over that chip and its own tooltip (`first`).
  const { triggerProps, tooltip } = useHoverTooltip({ content: label.tag ? <TagTip annotation={label.annotation} sha={sha} /> : null, disabled: !label.tag || first });
  return (
    <span
      className="ref-stack-row"
      onMouseOver={triggerProps.onMouseOver}
      onMouseMove={triggerProps.onMouseMove}
      onMouseEnter={(e) => {
        triggerProps.onMouseEnter(e);
        const refs = chipRefs(label);
        if (!onBranchHover || refs.length === 0) return;
        focusing.current = onBranchHover;
        onBranchHover(refs);
      }}
      onMouseLeave={(e) => {
        triggerProps.onMouseLeave(e);
        focusing.current?.(null);
        focusing.current = null;
      }}
      onContextMenu={onContextMenu && ((e) => { e.stopPropagation(); onContextMenu(label, e); })}
      onDoubleClick={onDoubleClick && ((e) => { e.stopPropagation(); onDoubleClick(label, e); })}
    >
      <ChipContent label={label} full />
      {tooltip}
    </span>
  );
}

/**
 * The hover stack (K77): a row with several labels floats one full chip per label,
 * the first exactly over the resting chip, the rest below it, every row as wide as the widest
 * and never narrower than chip + `+N`. A DOM child of the hovered chip or `+N` badge, so it stays
 * open while the pointer is anywhere over it. Absolutely positioned from the row (as the single
 * copy is: `.col-labels` clips nothing it doesn't contain); measured once on mount, before paint.
 */
function LabelStack({ labels, sha, onBranchHover, onContextMenu, onDoubleClick }: { labels: RefLabel[]; sha: string | null; onBranchHover?: BranchHover; onContextMenu?: (label: RefLabel, e: MouseEvent<HTMLElement>) => void; onDoubleClick?: (label: RefLabel, e: MouseEvent<HTMLElement>) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const host = el?.closest('.ref-labels');
    const chip = host?.querySelector(':scope > .ref-label:not(.ref-rebasing)');
    const op = el?.offsetParent;
    if (!el || !host || !chip || !op) return;
    const c = chip.getBoundingClientRect();
    const o = op.getBoundingClientRect();
    const more = host.querySelector('.ref-more');
    if (more) el.style.minWidth = `${more.getBoundingClientRect().right - c.left}px`;
    // Open downward from the chip; near the bottom of the scroller, slide up just enough.
    let top = c.top;
    const scroller = el.closest('.graph-scroll');
    if (scroller) {
      const s = scroller.getBoundingClientRect();
      top -= Math.max(0, Math.min(top + el.offsetHeight - s.bottom, top - s.top));
    }
    el.style.left = `${c.left - o.left}px`;
    el.style.top = `${top - o.top}px`;
  }, []);
  return (
    <span ref={ref} className="ref-stack" aria-hidden="true">
      {labels.map((l, i) => <StackRow key={`${i}:${l.name}`} label={l} sha={sha} first={i === 0} onBranchHover={onBranchHover} onContextMenu={onContextMenu} onDoubleClick={onDoubleClick} />)}
    </span>
  );
}

function More({ count, stack, head }: { count: number; stack: () => ReactNode; head: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={head ? 'ref-more ref-more-head' : 'ref-more'} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      +{count}
      {open && stack()}
    </span>
  );
}

/** The dimmed branch-membership chip itself (F7): the chip look at half opacity, just the branch name, no tooltip (F9). Otherwise it behaves like the first chip
 * (J6): hovered, it lights up to full strength and floats its untruncated copy, and a press on
 * it selects the row. */
function DimChip({ membership, onBranchHover }: { membership: BranchMembership; onBranchHover?: BranchHover }) {
  const lanes = useTheme((s) => s.colors.graph);
  return (
    <Chip
      className="ref-label ref-label-dim"
      refs={[membership.ref]}
      onBranchHover={onBranchHover}
      color={lanes[membership.color % lanes.length]}
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
export function RefLabels({ labels, color, membership = null, onBranchHover, compact = false, width, onContextMenu, onDoubleClick, line, rebasing = null, sha = null }: {
  labels: RefLabel[];
  /** The row's commit: named in the icon-only detached HEAD chip's tooltip. */
  sha?: string | null;
  /** HEAD's row only: the branch being rebased in the active worktree (2D T18). */
  rebasing?: string | null;
  color: number;
  membership?: BranchMembership | null;
  onBranchHover?: BranchHover;
  compact?: boolean;
  /** The Branch/Tag column's width (K104): every label shows as a chip while they fit it, the
   * overflow collapsing into `+N`. Omitted: only the first chip, the rest in `+N`. */
  width?: number;
  /** Right-clicking the row's own (first) label chip: the commit or tag menu for that branch or
   * tag (plan 1C Task 15). or any row of the hover stack (K77). Not on the `+N` badge or the dimmed membership chip. */
  onContextMenu?: (label: RefLabel, e: MouseEvent<HTMLElement>) => void;
  /** Double-clicking a label chip or a stack row (a branch checks out; spec #2 §9.3). The handler
   * stops the event, so the row's own double-click doesn't also fire. */
  onDoubleClick?: (label: RefLabel, e: MouseEvent<HTMLElement>) => void;
  /** The connector's line, CSS px from the row's top: placed on the device pixel rows the canvas
   * draws its half on (K57, pixels.ts connectorLine). Omitted: centred, 1 px (2 px for HEAD). */
  line?: { top: number; height: number } | null;
}) {
  // The theme's lanes (overrides applied): a theme switch recolours the chips in place.
  const lanes = useTheme((s) => s.colors.graph);
  // Which chips carry an MR/PR badge (chipFit counts its icon): one shallow selector per row.
  const { tabId } = useRepoContext();
  const badged = useForge(useShallow((s) => { const f = s.byTab[tabId]; return labels.map((l) => !!(f?.kind && mrForLabel(f, l))); }));
  if (labels.length === 0 && rebasing) return <span className="ref-labels ref-labels-head" style={{ ['--lane-color' as string]: lanes[color % lanes.length] }}><RebasingChip name={rebasing} /></span>;
  if (labels.length === 0) return membership ? <span className="ref-labels"><DimChip membership={membership} onBranchHover={onBranchHover} /></span> : null;
  const c = lanes[color % lanes.length];
  // K104: the chips that fit whole (estimated from canvas text widths: no layout per row), the
  // rest in `+N`. The first (the checked-out branch's, if any) is always shown.
  // A detached HEAD sharing the cell with branch chips (or the rebasing one) is just its check
  // (UX round 2): "HEAD" truncated to "H…" beside them read as noise. Its tooltip names it, and
  // hovering floats the full "HEAD" chip like any other.
  const crowded = labels.length + (rebasing ? 1 : 0) > 1;
  const iconOnly = (l: RefLabel) => compact || (crowded && isDetachedHead(l));
  const font = chipFont();
  // The rebasing chip comes first and takes its room before the others are fitted.
  const room = width === undefined ? undefined : width - (rebasing ? rebasingWidth(rebasing, font) + CHIP_SPACING : 0);
  const shown = room === undefined || compact || labels.length === 1
    ? 1
    : fitCount(labels.map((l, i) => chipWidth(l, font, iconOnly(l), badged[i])), room);
  const hidden = labels.length - shown;
  // The checked-out branch (HEAD's label always sorts first): its chip is always lit and its
  // connector is the graph line's width and colour (J21, graph.css; draw.ts `headRow`).
  const head = labels[0].isHead;
  const stack = hidden > 0 ? () => <LabelStack labels={labels} sha={sha} onBranchHover={onBranchHover} onContextMenu={onContextMenu} onDoubleClick={onDoubleClick} /> : undefined;
  return (
    // `--lane-color` is set here (not just on the chip) so `.ref-connector`, a sibling of the
    // chip, can read it too: it continues the connector drawn in the canvas (see draw.ts).
    <span className={head ? 'ref-labels ref-labels-head' : 'ref-labels'} style={{ ['--lane-color' as string]: c, ...(line && { ['--conn-top' as string]: `${line.top}px`, ['--conn-h' as string]: `${line.height}px` }) }}>
      {rebasing && <RebasingChip name={rebasing} />}
      {labels.slice(0, shown).map((l, i) => (
        <Chip
          key={`${i}:${l.name}`}
          color={c}
          className={`ref-label${l.isHead ? ' ref-label-head' : ''}${iconOnly(l) ? ' compact' : ''}${i > 0 || rebasing ? ' ref-label-next' : ''}`}
          refs={chipRefs(l)}
          onBranchHover={onBranchHover}
          onContextMenu={onContextMenu && ((e) => onContextMenu(l, e))}
          onDoubleClick={onDoubleClick && ((e) => { e.stopPropagation(); onDoubleClick(l, e); })}
          stack={i === 0 ? stack : undefined}
          content={(full) => <ChipContent label={l} full={full} compact={iconOnly(l)} />}
          tip={l.tag ? <TagTip annotation={l.annotation} sha={sha} /> : !compact && iconOnly(l) ? `HEAD (detached at ${sha ? sha.slice(0, 7) : 'this commit'})` : undefined}
        />
      ))}
      {stack && <More count={hidden} stack={stack} head={head} />}
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
