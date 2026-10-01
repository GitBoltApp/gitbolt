import { useVirtualizer } from '@tanstack/react-virtual';
import { X } from 'lucide-react';
import { useRef } from 'react';
import { useRepoView } from '../repo/store';
import { CompareCommit, CompareWorktree } from './CompareHeader';

/** A row's height: the compare row's 28 px plus a 2 px gap (details.css). */
const ROW_H = 30;

/** The selected commits, virtualized: a Shift range can span the whole history (tens of
 * thousands of rows), and only the rows in view are rendered. */
function MultiRows({ ids }: { ids: readonly string[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const graph = useRepoView((s) => s.graph);
  const indexById = useRepoView((s) => s.indexById);
  const v = useVirtualizer({
    count: ids.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 10,
    initialRect: { width: 400, height: 600 },
  });
  return (
    <div ref={scrollRef} className="multi-commits" data-testid="multi-commits">
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((item) => {
          const id = ids[item.index];
          const wip = graph.rows[indexById.get(id) ?? -1]?.wip;
          return (
            <div key={id} className="multi-row" style={{ top: item.start, height: ROW_H }}>
              {wip ? <CompareWorktree worktree={wip.worktreePath} testId="multi-commit" /> : <CompareCommit id={id} testId="multi-commit" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Spec §9.4, K27: three or more selected rows. The bar `N commits selected [×]`, in the commit
 * header's bar box; then one row per commit (avatar, one-line message, date), newest first, as
 * the compare header shows its two. No diff and no file list; actions on the selection (cherry
 * pick, …) come in a later sub-project.
 */
export function MultiSummary() {
  // What the panel shows (feedback F12).
  const selection = useRepoView((s) => s.panel?.selection);
  const exit = useRepoView((s) => s.exitCompare);
  const setFocus = useRepoView((s) => s.setFocus);
  if (selection?.kind !== 'multi') return null;
  // Leaving unmounts this summary and the focused ×: hand keyboard focus to the graph.
  const onExit = () => {
    exit();
    setFocus('graph');
  };
  return (
    <section className="multi-summary" aria-label="Selected commits">
      <div className="panel-bar multi-bar">
        <span data-testid="multi-count">{selection.ids.length} commits selected</span>
        <button type="button" className="icon-button" aria-label="Exit multi-selection" title="Exit multi-selection (Esc)" onClick={onExit}><X size={14} /></button>
      </div>
      <MultiRows ids={selection.ids} />
    </section>
  );
}
