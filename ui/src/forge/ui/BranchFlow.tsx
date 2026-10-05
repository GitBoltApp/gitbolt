import { ArrowRight, ChevronDown, ChevronUp, TriangleAlert } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { HoverTooltip } from '../../ui/HoverTooltip';
import type { RangeState } from './rangeStats';
import './forgeUi.css';

export interface FlowEnd {
  /** The branch's name, in mono with an ellipsis; the tooltip says it whole. */
  branch: string;
  /** Under the branch: the remote (Create's quiet dropdown) or the project (plain text). */
  sub: ReactNode;
  /** The branch is a button (Create's target branch picker), named by this. */
  pick?: { label: string; onPick(anchor: DOMRect): void };
}

/**
 * Where an MR/PR goes (the Create flyout, the MR/PR view): From → Into side by side, a footer
 * with what it brings (commits, files, +/−) and its expandable commit list, and an optional
 * status strip at the bottom (Create's "isn't on origin yet" with Push). The footer keeps its
 * height while the counts load.
 */
export function BranchFlow({ from, into, stats, count = null, none, strip }: {
  from: FlowEnd;
  into: FlowEnd;
  stats: RangeState;
  /** The commit count when the graph can't list them (Create's first-commit count). */
  count?: number | null;
  /** The footer when the repository lacks the commits. */
  none?: ReactNode;
  strip?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const ready = stats.status === 'ready' ? stats.stats : null;
  const commits = ready?.commits ?? null;
  const shownCount = commits?.length ?? count;
  return (
    <section className="flow" aria-label="Branches">
      <div className="flow-row">
        <End caption="From" end={from} />
        <span className="flow-arrow" aria-hidden><ArrowRight size={16} /></span>
        <End caption="Into" end={into} />
      </div>
      <div className="flow-meta">
        {stats.status === 'loading' && <span className="flow-wait">Counting…</span>}
        {stats.status === 'none' && (count !== null
          ? <span><b>{count}</b> {count === 1 ? 'commit' : 'commits'}</span>
          : <span className="flow-wait">{none ?? "The commits aren't in this repository yet"}</span>)}
        {ready && (
          <>
            {shownCount !== null && <span><b>{shownCount}</b> {shownCount === 1 ? 'commit' : 'commits'}</span>}
            <span><b>{ready.files}</b> {ready.files === 1 ? 'file' : 'files'}</span>
            <span className="flow-add">+{ready.added}</span>
            <span className="flow-del">−{ready.deleted}</span>
            {commits && commits.length > 0 && (
              <button type="button" className="flow-more" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)}>
                {open ? 'Hide commits' : 'Show commits'} {open ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
              </button>
            )}
          </>
        )}
      </div>
      {open && commits && (
        <ol className="flow-commits" id={listId} aria-label="Commits">
          {commits.map((c) => (
            <li key={c.sha}><code>{c.sha.slice(0, 7)}</code><span>{c.summary}</span></li>
          ))}
        </ol>
      )}
      {strip}
    </section>
  );
}

function End({ caption, end }: { caption: string; end: FlowEnd }) {
  const name = end.pick
    ? (
      <button type="button" className="flow-branch flow-pick" aria-label={end.pick.label} onClick={(e) => end.pick!.onPick(e.currentTarget.getBoundingClientRect())}>
        <span className="flow-name">{end.branch}</span><ChevronDown size={12} aria-hidden />
      </button>
    )
    : <span className="flow-branch"><span className="flow-name">{end.branch}</span></span>;
  return (
    <div className="flow-end">
      <span className="flow-cap">{caption}</span>
      <HoverTooltip content={end.branch}>{name}</HoverTooltip>
      <span className="flow-sub">{end.sub}</span>
    </div>
  );
}

/** BranchFlow's orange strip: a message and an optional action (Push). */
export function FlowStrip({ children, action, tone = 'warn' }: { children: ReactNode; action?: ReactNode; tone?: 'warn' | 'bad' }) {
  return (
    <div className="flow-strip" data-tone={tone} role="status">
      <TriangleAlert size={14} aria-hidden className="flow-strip-icon" />
      <span className="flow-strip-msg">{children}</span>
      {action}
    </div>
  );
}
