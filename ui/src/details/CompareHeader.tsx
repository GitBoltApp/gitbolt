import { X } from 'lucide-react';
import { Avatar } from '../avatars/Avatar';
import { formatDate } from '../format/date';
import { shortSha } from '../format/sha';
import { wipCountsText } from '../format/wip';
import { useRepoView } from '../repo/store';
import { useHoverTooltip } from '../ui/HoverTooltip';
import { personLabel } from './CoAuthors';

/** Compare rows' avatar size: the co-author chips' scale, a notch under the author's. */
const AVATAR_PX = 20;

/** One compared commit (K17): its author's avatar, its one-line summary (ellipsized; hovering
 * shows it whole, with the author) and its committed date, from its graph row. A commit outside
 * the loaded graph shows its short SHA. */
function CompareCommit({ id }: { id: string }) {
  const row = useRepoView((s) => {
    const i = s.indexById.get(id);
    return i === undefined ? undefined : s.graph.rows[i];
  });
  const { triggerProps, tooltip } = useHoverTooltip({
    disabled: !row,
    content: row ? <span className="hovercard"><span className="hovercard-title">{row.summary}</span><span>{personLabel(row.authorName, row.authorEmail)}</span></span> : null,
  });
  if (!row) {
    return <div className="compare-commit" data-testid="compare-commit"><code className="compare-summary" data-testid="compare-summary">{shortSha(id)}</code></div>;
  }
  return (
    <div className="compare-commit" data-testid="compare-commit">
      <Avatar name={row.authorName} email={row.authorEmail} size={AVATAR_PX} />
      <span className="compare-summary" data-testid="compare-summary" {...triggerProps}>{row.summary}</span>
      <span className="compare-date" data-testid="compare-date">{formatDate(row.committerTime)}</span>
      {tooltip}
    </div>
  );
}

/** The compared working tree, as the WIP header names it. */
function CompareWorktree({ worktree }: { worktree: string }) {
  // The row itself (a stable reference), found by worktree.
  const wip = useRepoView((s) => s.graph.rows.find((r) => r.wip?.worktreePath === worktree)?.wip ?? null);
  return (
    <div className="compare-commit" data-testid="compare-commit">
      <span className="compare-summary"><span className="wip-tag">// WIP</span> <span className="person-name">{wip?.worktreeName ?? 'Working tree'}</span></span>
      {wip && <span className="compare-date dim">{wipCountsText(wip)}</span>}
    </div>
  );
}

/**
 * Spec §9.4: the bar `Comparing a1b2c3 → e4f5g6 [×]`, the base (older) first (K16), in the
 * commit header's bar box (K5/K6); then the two sides, one row each (K17).
 */
export function CompareHeader() {
  // What the panel shows (feedback F12).
  const selection = useRepoView((s) => s.panel?.selection);
  const exit = useRepoView((s) => s.exitCompare);
  const setFocus = useRepoView((s) => s.setFocus);
  if (selection?.kind !== 'compare' && selection?.kind !== 'compareWorktree') return null;
  const to = selection.kind === 'compare' ? <code>{shortSha(selection.to)}</code> : 'working tree';
  // Leaving compare unmounts this header and the focused ×: hand keyboard focus to the graph
  // (a focus request moves DOM focus even when the store already names the graph).
  const onExit = () => {
    exit();
    setFocus('graph');
  };
  return (
    <header className="compare-header">
      <div className="panel-bar compare-bar">
        <span data-testid="compare-header">Comparing <code>{shortSha(selection.from)}</code> <span role="img" aria-label="to">→</span> {to}</span>
        <button type="button" className="icon-button" aria-label="Exit compare" title="Exit compare (Esc)" onClick={onExit}><X size={14} /></button>
      </div>
      <div className="compare-commits">
        <CompareCommit id={selection.from} />
        {selection.kind === 'compare' ? <CompareCommit id={selection.to} /> : <CompareWorktree worktree={selection.worktree} />}
      </div>
    </header>
  );
}
