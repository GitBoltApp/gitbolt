import { Check, Laptop, Tag, TreePine } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RemoteRefLabel } from '../api/gen/RemoteRefLabel';
import { RemoteIcon } from '../icons/brands';
import { useTheme } from '../theme/store';
import { chipRefs, type BranchMembership } from './membership';
import { useHoverTooltip } from '../ui/HoverTooltip';
import { chipFont, chipWidth, fitCount } from './chipFit';


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

/** A chip's inside. `compact` (Branch/Tag at its minimum, spec §8.4): icons only, no name; the
 * hover copy (`full`) is never compact, so hovering names the ref. */
// Lucide's outline icons leave ~2/24 padding inside their box, while the brand marks fill theirs
// edge to edge: at the same nominal size the laptop reads smaller than the GitLab mark. Outline
// source icons go one step up so all source icons look the same size.
export const SOURCE_OUTLINE = 14;

function ChipContent({ label, full = false, compact = false }: { label: RefLabel; full?: boolean; compact?: boolean }) {
  return (
    <>
      {/* The checked-out branch's check, ~1.4x the other icons (J21, graph.css .ref-head-check). */}
      {label.isHead && <Check size={12} className="ref-head-check" aria-label="HEAD" />}
      {label.tag && <Tag size={12} aria-label="tag" />}
      {/* No tooltip on the name (F9): the expanded copy already shows it in full. */}
      {!(compact && !full) && <span className={full ? 'ref-name-full' : 'ref-name'}>{label.name}</span>}
      {label.local && <SourceIcon tip={`${label.local.replace(/^refs\/heads\//, '')} (Local)`}><Laptop size={SOURCE_OUTLINE} aria-label="local" /></SourceIcon>}
      {label.remotes.map((r) => <SourceIcon key={r.fullName} tip={<RemoteTip remote={r} />}><RemoteIcon kind={r.hostKind} host={r.host} remote={r.remote} size={12} /></SourceIcon>)}
      {label.worktree && <SourceIcon tip={`Checked out in ${label.worktree}`}><TreePine size={SOURCE_OUTLINE} aria-label="checked out in another worktree" /></SourceIcon>}
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
function Chip({ color, className = 'ref-label', content, refs = NO_REFS, onBranchHover, onContextMenu, stack }: { color: string; className?: string; content: (full: boolean) => ReactNode; stack?: () => ReactNode; refs?: readonly string[]; onBranchHover?: BranchHover; onContextMenu?: (e: MouseEvent<HTMLElement>) => void }) {
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
      {expanded && (stack ? stack() : (
        <span className="ref-label ref-label-full" aria-hidden="true">
          {content(true)}
        </span>
      ))}
    </span>
  );
}

/** One row of the label stack (K77): a full chip for one ref. Hovering it starts that ref's
 * branch focus (J22), ended on leaving or unmounting; right-clicking opens that label's menu. */
function StackRow({ label, onBranchHover, onContextMenu }: { label: RefLabel; onBranchHover?: BranchHover; onContextMenu?: (label: RefLabel, e: MouseEvent<HTMLElement>) => void }) {
  const focusing = useRef<BranchHover | null>(null);
  useEffect(() => () => focusing.current?.(null), []);
  return (
    <span
      className="ref-stack-row"
      onMouseEnter={() => {
        const refs = chipRefs(label);
        if (!onBranchHover || refs.length === 0) return;
        focusing.current = onBranchHover;
        onBranchHover(refs);
      }}
      onMouseLeave={() => {
        focusing.current?.(null);
        focusing.current = null;
      }}
      onContextMenu={onContextMenu && ((e) => { e.stopPropagation(); onContextMenu(label, e); })}
    >
      <ChipContent label={label} full />
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
function LabelStack({ labels, onBranchHover, onContextMenu }: { labels: RefLabel[]; onBranchHover?: BranchHover; onContextMenu?: (label: RefLabel, e: MouseEvent<HTMLElement>) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const host = el?.closest('.ref-labels');
    const chip = host?.firstElementChild;
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
      {labels.map((l, i) => <StackRow key={`${i}:${l.name}`} label={l} onBranchHover={onBranchHover} onContextMenu={onContextMenu} />)}
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
export function RefLabels({ labels, color, membership = null, onBranchHover, compact = false, width, onContextMenu, line }: {
  labels: RefLabel[];
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
  /** The connector's line, CSS px from the row's top: placed on the device pixel rows the canvas
   * draws its half on (K57, pixels.ts connectorLine). Omitted: centred, 1 px (2 px for HEAD). */
  line?: { top: number; height: number } | null;
}) {
  // The theme's lanes (overrides applied): a theme switch recolours the chips in place.
  const lanes = useTheme((s) => s.colors.graph);
  if (labels.length === 0) return membership ? <span className="ref-labels"><DimChip membership={membership} onBranchHover={onBranchHover} /></span> : null;
  const c = lanes[color % lanes.length];
  // K104: the chips that fit whole (estimated from canvas text widths: no layout per row), the
  // rest in `+N`. The first (the checked-out branch's, if any) is always shown.
  const shown = width === undefined || compact || labels.length === 1
    ? 1
    : fitCount(labels.map((l) => chipWidth(l, chipFont())), width);
  const hidden = labels.length - shown;
  // The checked-out branch (HEAD's label always sorts first): its chip is always lit and its
  // connector is the graph line's width and colour (J21, graph.css; draw.ts `headRow`).
  const head = labels[0].isHead;
  const stack = hidden > 0 ? () => <LabelStack labels={labels} onBranchHover={onBranchHover} onContextMenu={onContextMenu} /> : undefined;
  return (
    // `--lane-color` is set here (not just on the chip) so `.ref-connector`, a sibling of the
    // chip, can read it too: it continues the connector drawn in the canvas (see draw.ts).
    <span className={head ? 'ref-labels ref-labels-head' : 'ref-labels'} style={{ ['--lane-color' as string]: c, ...(line && { ['--conn-top' as string]: `${line.top}px`, ['--conn-h' as string]: `${line.height}px` }) }}>
      {labels.slice(0, shown).map((l, i) => (
        <Chip
          key={`${i}:${l.name}`}
          color={c}
          className={`ref-label${l.isHead ? ' ref-label-head' : ''}${compact ? ' compact' : ''}${i > 0 ? ' ref-label-next' : ''}`}
          refs={chipRefs(l)}
          onBranchHover={onBranchHover}
          onContextMenu={onContextMenu && ((e) => onContextMenu(l, e))}
          stack={i === 0 ? stack : undefined}
          content={(full) => <ChipContent label={l} full={full} compact={compact} />}
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
