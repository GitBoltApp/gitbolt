import { wipCountsText } from '../format/wip';
import { useRepoView } from '../repo/store';

/** Spec §8.6, read-only in #1: no stage, unstage or discard controls (#2). */
export function WipHeader() {
  const selection = useRepoView((s) => s.selection);
  const wip = useRepoView((s) => (s.selection.kind === 'wip' ? s.graph.rows[s.selection.index]?.wip ?? null : null));
  if (selection.kind !== 'wip') return null;
  return (
    <header className="wip-header" data-testid="wip-header">
      <span className="wip-tag">// WIP</span> <span className="person-name">{selection.name ?? 'Working tree'}</span> <span className="dim">{wip ? wipCountsText(wip) : ''}</span>
    </header>
  );
}
