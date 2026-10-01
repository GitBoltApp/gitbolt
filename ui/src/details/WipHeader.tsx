import { wipCountsText } from '../format/wip';
import { useRepoView } from '../repo/store';

/** Spec §8.6, read-only in #1: no stage, unstage or discard controls (#2). */
export function WipHeader() {
  // What the panel shows (feedback F12); its row is found by worktree, as the graph may have
  // been reloaded since.
  const selection = useRepoView((s) => s.panel?.selection);
  const wip = useRepoView((s) => {
    const sel = s.panel?.selection;
    if (sel?.kind !== 'wip') return null;
    const row = s.graph.rows[sel.index];
    return (row?.wip?.worktreePath === sel.worktree ? row : s.graph.rows.find((r) => r.wip?.worktreePath === sel.worktree))?.wip ?? null;
  });
  if (selection?.kind !== 'wip') return null;
  return (
    <header className="wip-header panel-bar" data-testid="wip-header">
      <span className="wip-tag">// WIP</span> <span className="person-name">{selection.name ?? 'Working tree'}</span> <span className="dim">{wip ? wipCountsText(wip) : ''}</span>
    </header>
  );
}
