import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { RowPayload } from '../api/gen/RowPayload';
import { StatusCountsView } from '../files/FileList';
import { isEditableTarget } from '../ui/keys';
import { debounce } from '../util/debounce';
import { readWipDraft, WIP_DRAFT_COUNTER_FROM, WIP_DRAFT_MAX, writeWipDraft } from './wipDraft';

const PERSIST_MS = 300;

/** A press in the draft box bubbles to the row (K51), so it selects WIP like any press on the row
 * (plain, or with Ctrl/Shift as a row click); it is not a drag start, and the click that follows
 * toggles nothing. */
const keepClick = (e: MouseEvent) => e.stopPropagation();

/**
 * The inline draft summary (K48): a compact rounded text box, "// WIP" as its placeholder, whose text
 * prefills sub-project #2's commit summary (`wipDraft.ts`). Its text is local state with a
 * debounced persist, so typing re-renders this box alone, never the memoized rows.
 */
function DraftInput({ repoId, worktreePath }: { repoId: string; worktreePath: string }) {
  const [text, setText] = useState(() => readWipDraft(repoId, worktreePath));
  const persist = useMemo(() => debounce((t: string) => writeWipDraft(repoId, worktreePath, t), PERSIST_MS), [repoId, worktreePath]);
  // Leaving (or switching worktree) never loses the last keystrokes.
  useEffect(() => () => void persist.flush(), [persist]);
  const lastKey = useRef(`${repoId}\0${worktreePath}`);
  useEffect(() => {
    const k = `${repoId}\0${worktreePath}`;
    if (lastKey.current !== k) {
      lastKey.current = k;
      setText(readWipDraft(repoId, worktreePath));
    }
  }, [repoId, worktreePath]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Nothing typed here reaches the graph's or the app's shortcuts.
    if (!isEditableTarget(e.target)) return;
    e.stopPropagation();
    if (e.key === 'Escape' || e.key === 'Enter') {
      const grid = e.currentTarget.closest<HTMLElement>('[role="grid"]');
      e.currentTarget.blur();
      void persist.flush();
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
        maxLength={WIP_DRAFT_MAX}
        spellCheck={false}
        autoComplete="off"
        value={text}
        onClick={keepClick}
        onKeyDown={onKeyDown}
        onChange={(e) => {
          setText(e.target.value);
          persist(e.target.value);
        }}
        onBlur={() => void persist.flush()}
      />
      {text.length > WIP_DRAFT_COUNTER_FROM && <span className="wip-counter" data-testid="wip-counter">{text.length}/{WIP_DRAFT_MAX}</span>}
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
