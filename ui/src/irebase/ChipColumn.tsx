import { Lock, Plus, X } from 'lucide-react';
import { useState, type DragEvent } from 'react';
import { HoverTooltip } from '../ui/HoverTooltip';
import { addChip, chipRow, moveChip, rebasedRow, removeChip, type EditorChip, type EditorState, type Grouping } from './model';
import { editState, sessionOf } from './session';

/** The chip being dragged (one drag at a time). jsdom's and WebKit's DataTransfer differ; this doesn't. */
let dragging: string | null = null;

/** A row's `<li>` takes chip drops: the branch moves to that row. */
export function chipDrop(tabId: string, row: string, setOver: (on: boolean) => void) {
  return {
    onDragOver: (e: DragEvent) => {
      if (!dragging) return;
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => {
      setOver(false);
      if (!dragging) return;
      e.preventDefault();
      const branch = dragging;
      dragging = null;
      editState(tabId, (s) => moveChip(s, branch, row));
    },
  };
}

function Chip({ tabId, chip }: { tabId: string; chip: EditorChip }) {
  const free = !chip.locked && !chip.deleted;
  const tip = chip.locked ? `${chip.branch}: ${chip.locked}` : chip.deleted ? `${chip.branch} will be deleted` : `Drag ${chip.branch} to another commit to move it`;
  return (
    <HoverTooltip content={tip}>
      <span className={`irebase-chip-wrap${chip.deleted ? ' is-deleted' : ''}`}>
        <span
          className={`irebase-chip${chip.deleted ? ' is-deleted' : ''}${chip.locked ? ' is-locked' : ''}`}
          draggable={free}
          onDragStart={(e) => {
            dragging = chip.branch;
            e.dataTransfer?.setData?.('text/plain', chip.branch);
          }}
          onDragEnd={() => { dragging = null; }}
        >
          {chip.branch}
        </span>
        {chip.locked ? <Lock size={11} aria-hidden="true" /> : (
          <button type="button" className="irebase-chip-x" aria-label={chip.deleted ? `Keep ${chip.branch}` : `Delete ${chip.branch} when the rebase completes`} onClick={(e) => { e.stopPropagation(); editState(tabId, (s) => removeChip(s, chip.branch)); }}>
            <X size={11} aria-hidden="true" />
          </button>
        )}
      </span>
    </HoverTooltip>
  );
}

function AddBranch({ tabId, row }: { tabId: string; row: string }) {
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (name === null) {
    return (
      <HoverTooltip content="Add a branch at this commit">
        <button type="button" className="irebase-chip-add" aria-label="Add a branch here" onClick={(e) => { e.stopPropagation(); setName(''); }}><Plus size={12} aria-hidden="true" /></button>
      </HoverTooltip>
    );
  }
  const submit = () => {
    const s = sessionOf(tabId);
    if (!s) return;
    const next = addChip(s.state, name, row);
    if (typeof next === 'string') return setError(next);
    editState(tabId, () => next);
    setName(null);
    setError(null);
  };
  return (
    <span className="irebase-chip-input" onClick={(e) => e.stopPropagation()}>
      <input
        aria-label="New branch name"
        value={name}
        autoFocus
        onChange={(e) => { setName(e.target.value); setError(null); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setName(null); setError(null); }
        }}
      />
      {error && <span role="status" className="irebase-chip-error">{error}</span>}
    </span>
  );
}

/** The chips git leaves on `row` (spec #3 §4.1): the rebased branch's on the effective top row
 * (fixed, Ruling 7), and every chip whose landing row this is. On the base's row (read-only):
 * the base's own chips, and any chip that lands there because every row below it is dropped;
 * no "+". The "+" sits outside the clipped list, so a row of long names never hides it. */
export function ChipColumn({ tabId, row, state, g }: { tabId: string; row: string; state: EditorState; g: Grouping }) {
  const here = state.chips.filter((c) => chipRow(state, c.at, g) === row);
  const base = row === state.base.oid;
  return (
    <span className="irebase-chips" data-row={row}>
      <span className="irebase-chip-list">
        {base && state.base.chips.map((b) => <span key={b} className="irebase-chip is-base">{b}</span>)}
        {rebasedRow(state, g) === row && (
          <HoverTooltip content={`${state.branch} ends here: git moves it`}><span className="irebase-chip is-rebased">{state.branch}</span></HoverTooltip>
        )}
        {here.map((c) => <Chip key={c.branch} tabId={tabId} chip={c} />)}
      </span>
      {!base && <AddBranch tabId={tabId} row={row} />}
    </span>
  );
}
