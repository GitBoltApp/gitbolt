import { type KeyboardEvent, type MouseEvent } from 'react';
import type { RowPayload } from '../api/gen/RowPayload';
import { StatusCountsView } from '../files/FileList';
import { isEditableTarget } from '../ui/keys';
import { flushDrafts, useWipDraft, WIP_DRAFT_COUNTER_FROM, WIP_DRAFT_WARN_FROM } from '../commit/draft';

/** A press in the draft box bubbles to the row (K51), so it selects WIP like any press on the row
 * (plain, or with Ctrl/Shift as a row click); it is not a drag start, and the click that follows
 * toggles nothing. */
const keepClick = (e: MouseEvent) => e.stopPropagation();

/**
 * The inline draft summary (K48): a compact rounded text box, "// WIP" as its placeholder. Its text
 * is the WIP draft's summary, shared with the commit box (spec #2 §8.2; `commit/draft.ts`).
 */
function DraftInput({ repoId, worktreePath }: { repoId: string; worktreePath: string }) {
  const [draft, setDraft] = useWipDraft(repoId, worktreePath);
  const text = draft.summary;
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Nothing typed here reaches the graph's or the app's shortcuts.
    if (!isEditableTarget(e.target)) return;
    e.stopPropagation();
    if (e.key === 'Escape' || e.key === 'Enter') {
      const grid = e.currentTarget.closest<HTMLElement>('[role="grid"]');
      e.currentTarget.blur();
      flushDrafts();
      if (e.key === 'Escape') {
        e.preventDefault();
        grid?.focus();
      }
    }
  };
  return (
    <span className="wip-draft">
      <span className="wip-sr">// WIP</span>
      <input
        className="wip-input"
        type="text"
        aria-label="Commit summary draft"
        placeholder="// WIP"
        spellCheck={false}
        autoComplete="off"
        value={text}
        onClick={keepClick}
        onKeyDown={onKeyDown}
        onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
        onBlur={flushDrafts}
      />
      {text.length > WIP_DRAFT_COUNTER_FROM && (
        <span className={`wip-counter${text.length > WIP_DRAFT_WARN_FROM ? ' warn' : ''}`} data-testid="wip-counter">{text.length}</span>
      )}
    </span>
  );
}

/** The WIP row's message cell: the draft box, the worktree name if it isn't the main one, and
 * the per-type change counts at the right (the file list's coloured status icons). */
export function WipSummary({ row, repoId }: { row: RowPayload; repoId: string }) {
  const w = row.wip!;
  return (
    <div className="wip-summary">
      <DraftInput repoId={repoId} worktreePath={w.worktreePath} />
      {w.worktreeName && <span className="dim wip-worktree">{w.worktreeName}</span>}
      <span className="wip-counts"><StatusCountsView counts={w} testId="wip-counts" size={12} /></span>
    </div>
  );
}
