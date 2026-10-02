import { Redo2, Undo2 } from 'lucide-react';
import { useEffect } from 'react';
import type { StagingUndoState } from '../api/gen/StagingUndoState';
import type { WriteCtx } from '../write/client';
import { loadStaging, stagingRedo, stagingUndo, useWipCtx } from './actions';
import { ActionIcon } from './RowActions';
import { COMMIT_QUEUED, stagingKey, useCommitting, useStaging } from './store';

/** A button's tooltip and state (spec #2 §7.6). */
export function stagingView(s: StagingUndoState | undefined, which: 'undo' | 'redo', committing: boolean): { tooltip: string; disabled: boolean } {
  if (committing) return { tooltip: COMMIT_QUEUED, disabled: true };
  if (s?.off) return { tooltip: s.off, disabled: true };
  const label = which === 'undo' ? s?.undo : s?.redo;
  if (!label) return { tooltip: `Nothing to ${which} in staging`, disabled: true };
  return { tooltip: `${which === 'undo' ? 'Undo' : 'Redo'} ${label} (${which === 'undo' ? 'Ctrl+Z' : 'Ctrl+Shift+Z'})`, disabled: false };
}

/** Undo and Redo for the staging log, in the diff toolbar (WIP diffs) and the WIP file list's
 * header: the toolbar's Undo isn't in view there (§7.6). After one, the lists and the open
 * diff refresh from the answer; there's no toast. */
export function StagingUndoButtons({ ctx }: { ctx: WriteCtx }) {
  const s = useStaging((st) => st.states[stagingKey(ctx.repoId, ctx.worktree)]);
  const committing = useCommitting(ctx.repoId, ctx.worktree);
  useEffect(() => void loadStaging(ctx.repoId, ctx.worktree), [ctx.repoId, ctx.worktree]);
  const u = stagingView(s, 'undo', committing);
  const r = stagingView(s, 'redo', committing);
  return (
    <span className="staging-undo" role="group" aria-label="Staging history">
      <ActionIcon label="Undo staging" tip={u.tooltip} icon={Undo2} disabled={u.disabled} onClick={() => void stagingUndo(ctx)} />
      <ActionIcon label="Redo staging" tip={r.tooltip} icon={Redo2} disabled={r.disabled} onClick={() => void stagingRedo(ctx)} />
    </span>
  );
}

/** The buttons for the WIP row the panel shows, reading its own context: the diff panel stays
 * out of the selection (a hidden kept panel must not re-render when the graph selection moves). */
export function WipStagingUndo() {
  const ctx = useWipCtx();
  return ctx ? <StagingUndoButtons ctx={ctx} /> : null;
}
