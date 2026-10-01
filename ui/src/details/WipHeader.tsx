import { useRepoView } from '../repo/store';
import { HoverTooltip } from '../ui/HoverTooltip';

/** Spec §8.6, read-only in #1: `N file change(s) on [branch]`, no stage, unstage or discard
 * controls (#2). N counts each changed path once, staged or not. */
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
  const count = useRepoView((s) => {
    const paths = new Set<string>();
    let ready = false;
    for (const sec of s.panel?.sections ?? []) {
      if (sec.list.status !== 'ready') continue;
      ready = true;
      for (const f of sec.list.data.files) paths.add(f.path);
    }
    return ready ? paths.size : wip ? wip.modified + wip.added + wip.deleted + wip.renamed + wip.conflicted : 0;
  });
  // A linked worktree's branch is on its label; the main worktree's is HEAD's.
  const branch = useRepoView((s) => {
    const sel = s.panel?.selection;
    if (sel?.kind !== 'wip') return null;
    return s.graph.labels.find((l) => l.worktree === sel.worktree)?.name ?? (sel.name === null ? s.graph.head.branch?.replace(/^refs\/heads\//, '') : null) ?? sel.name;
  });
  if (selection?.kind !== 'wip') return null;
  return (
    <header className="wip-header panel-bar" data-testid="wip-header">
      <span>{count} file {count === 1 ? 'change' : 'changes'}</span>
      {branch && <>{' '}<span>on</span>{' '}<HoverTooltip content={`Worktree ${selection.name}`} disabled={!selection.name}><span className="wip-branch">{branch}</span></HoverTooltip></>}
    </header>
  );
}
