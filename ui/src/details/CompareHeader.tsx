import { ArrowLeftRight, X } from 'lucide-react';
import { useRepoView } from '../repo/store';

/** Spec §9.4: `Comparing a1b2c3 → e4f5g6 [⇄ swap] [×]`. */
export function CompareHeader() {
  const selection = useRepoView((s) => s.selection);
  const swap = useRepoView((s) => s.swapCompare);
  const exit = useRepoView((s) => s.exitCompare);
  const setFocus = useRepoView((s) => s.setFocus);
  if (selection.kind !== 'compare' && selection.kind !== 'compareWorktree') return null;
  const to = selection.kind === 'compare' ? <code>{selection.to.slice(0, 6)}</code> : 'working tree';
  // Leaving compare unmounts this header and the focused ×: hand keyboard focus to the graph
  // (a focus request moves DOM focus even when the store already names the graph).
  const onExit = () => {
    exit();
    setFocus('graph');
  };
  return (
    <header className="compare-header">
      <span data-testid="compare-header">Comparing <code>{selection.from.slice(0, 6)}</code> <span role="img" aria-label="to">→</span> {to}</span>
      {selection.kind === 'compare' && (
        <button type="button" className="icon-button" aria-label="Swap" title="Swap" onClick={swap}><ArrowLeftRight size={14} /></button>
      )}
      <button type="button" className="icon-button" aria-label="Exit compare" title="Exit compare (Esc)" onClick={onExit}><X size={14} /></button>
    </header>
  );
}
