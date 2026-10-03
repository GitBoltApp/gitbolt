import { ArrowDown, GripVertical, Redo2, TriangleAlert, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from '../avatars/Avatar';
import { CommitFields } from '../commit/CommitFields';
import { draftMessage, splitMessage, type WipDraft } from '../commit/draft';
import type { CenterViewProps } from '../repo/centerView';
import type { Origin } from '../ui/arm/origin';
import { HoverTooltip } from '../ui/HoverTooltip';
import { registerKeys } from '../ui/keyRouter';
import { Select } from '../ui/Select';
import {
  ACTION_KEYS, ACTION_LABEL, ACTION_TIP, ACTIONS, dirty, editMessage, grouping, moveRows, moveSelected, problems, reset, select,
  setActions, targetMessage, type EditorRow, type EditorState, type Grouping, type RowAction,
} from './model';
import { usePrediction } from './predict';
import { useRowDrag } from './rowDrag';
import { ChipColumn } from './ChipColumn';
import { useChipDrag, useChipDragCleanup } from './chipDrag';
import { laneStyle, useChipColor } from './colors';
import { inspectBase, useBaseInspected, useInspectSelection } from './inspect';
import { editSession, editState, redoPlan, sessionOf, undoPlan, useRebaseSessions } from './session';
import { cancelRebase, flattenWarning, reloadRebase, startRebase } from './start';
import './editor.css';

const short = (oid: string) => oid.slice(0, 7);
const NO_STATE = { selected: [], base: { oid: '' } } as unknown as EditorState;
const firstLine = (m: string) => m.split('\n')[0];
/** Undo / Redo while a message editor is open: they'd drop its draft (UX R1.6 ruling). */
const FINISH_MESSAGE = 'Finish editing the message first';
/** A control as a key's origin: the confirm arms it in place (spec §ui confirms). */
const keyOrigin = (el: HTMLElement | null): Origin | null => (el ? { el, rect: null, via: 'key', control: true, holds: 0 } : null);

const startEditing = (tabId: string, oid: string | null) => editSession(tabId, (s) => ({ ...s, editing: oid }));

/** The keys (spec #3 §4.1), before the app's own: none of them while typing in the message editor. */
function useEditorKeys(tabId: string, root: React.RefObject<HTMLElement | null>, cancel: React.RefObject<HTMLButtonElement | null>) {
  useEffect(() => registerKeys('overlay', (e) => {
    const s = sessionOf(tabId);
    if (!s || !root.current) return;
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (t?.closest('input, textarea, [contenteditable="true"]')) return;
    if (t && t !== document.body && !root.current.contains(t)) return;
    const { state } = s;
    const one = state.selected.length === 1 ? state.selected[0] : null;
    // Undo / Redo of the plan (UX R1.6); in the message editor, its own (the return above).
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redoPlan(tabId);
      else undoPlan(tabId);
      return 'handled';
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      void cancelRebase(tabId, keyOrigin(cancel.current));
      return 'handled';
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const delta = e.key === 'ArrowUp' ? -1 : 1;
      if (e.ctrlKey || e.metaKey) editState(tabId, (x) => moveSelected(x, delta));
      else {
        const at = state.rows.findIndex((r) => r.oid === (state.selected.at(-1) ?? state.anchor));
        const next = state.rows[Math.min(state.rows.length - 1, Math.max(0, at + delta))];
        if (next) editState(tabId, (x) => select(x, next.oid, { shift: e.shiftKey }));
      }
      return 'handled';
    }
    if (e.key === 'Enter' && one && !t?.closest('button')) {
      e.preventDefault();
      startEditing(tabId, one);
      return 'handled';
    }
    const action = !e.ctrlKey && !e.metaKey && !e.altKey ? ACTION_KEYS[e.key.toLowerCase()] : undefined;
    if (action && state.selected.length > 0) {
      e.preventDefault();
      editState(tabId, (x) => setActions(x, x.selected, action));
      if (action === 'reword' && one) startEditing(tabId, one);
      return 'handled';
    }
  }), [tabId, root, cancel]);
}

function InlineMessage({ tabId, oid, text }: { tabId: string; oid: string; text: string }) {
  const [value, setValue] = useState<WipDraft>(() => splitMessage(text));
  const save = () => {
    editState(tabId, (s) => editMessage(s, oid, draftMessage(value)));
    startEditing(tabId, null);
  };
  return (
    <div className="irebase-message-editor">
      <CommitFields value={value} onChange={setValue} onSubmit={save} onEscape={() => startEditing(tabId, null)} autoFocus />
    </div>
  );
}

function Row({ tabId, row, index, state, g, chips, conflict, editing, drag }: {
  tabId: string; row: EditorRow; index: number; state: EditorState; g: Grouping; conflict: string[] | undefined; editing: boolean; drag: ReturnType<typeof useRowDrag>;
  /** The plan the chips show: during a row drag, the one it would make (R1.7). */
  chips: { state: EditorState; g: Grouping };
}) {
  const into = g.into.get(row.oid);
  const selected = state.selected.includes(row.oid);
  const text = targetMessage(state, row.oid, g);
  const over = useChipDrag((x) => x.drag?.over === row.oid);
  const count = drag.count(index);
  const choose = (a: RowAction) => editState(tabId, (s) => setActions(s, s.selected.includes(row.oid) ? s.selected : [row.oid], a));
  return (
    <li
      data-irebase-row=""
      data-oid={row.oid}
      role="option"
      aria-selected={selected}
      className={['irebase-row', `is-${row.action}`, into ? 'is-folded' : '', selected ? 'is-selected' : '', over ? 'chip-over' : ''].filter(Boolean).join(' ')}
      style={drag.style(index)}
      onPointerDown={(e) => drag.onPointerDown(e, index, state.selected)}
      onClick={(e) => editState(tabId, (s) => select(s, row.oid, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }))}
      onDoubleClick={() => startEditing(tabId, row.oid)}
    >
      <span className="irebase-handle" aria-hidden="true"><GripVertical size={14} /></span>
      {count !== null && <span className="irebase-drag-count" role="status">{count} commits</span>}
      <ChipColumn tabId={tabId} row={row.oid} state={chips.state} g={chips.g} />
      <HoverTooltip content={ACTION_TIP[row.action]}>
        {/* On a selected row the dropdown sets every selected row: the click keeps the selection. */}
        <span className={`irebase-action is-${row.action}`} onClick={(e) => { if (selected) e.stopPropagation(); }} onDoubleClick={(e) => e.stopPropagation()}>
          <Select aria-label={`Action for ${short(row.oid)}`} value={row.action} options={ACTIONS.map((a) => [a, ACTION_LABEL[a]] as const)} onChange={choose} />
        </span>
      </HoverTooltip>
      <span className="irebase-fold">{into && <HoverTooltip content={`Folds into ${short(into)}`}><ArrowDown size={13} aria-label={`Folds into ${short(into)}`} /></HoverTooltip>}</span>
      <Avatar name={row.authorName} email={row.authorEmail} size={20} />
      {editing ? <InlineMessage tabId={tabId} oid={row.oid} text={text} /> : <span className="irebase-summary">{firstLine(text)}</span>}
      <span className="irebase-dot">{row.edited !== null && <span aria-label="Message edited">•</span>}</span>
      <span className="irebase-conflict">
        {conflict && <HoverTooltip content={`Predicted conflict in ${conflict.join(', ')}`}><TriangleAlert size={13} aria-label="Predicted conflict" /></HoverTooltip>}
      </span>
    </li>
  );
}

/** The chip being dragged, under the pointer (it ignores the pointer: the row under it is the drop). */
function ChipGhost({ tabId }: { tabId: string }) {
  const drag = useChipDrag((x) => x.drag);
  const color = useChipColor(tabId);
  if (!drag) return null;
  return createPortal(<span className="irebase-chip irebase-chip-ghost" style={{ ...laneStyle(color(drag.branch)), left: drag.x + 10, top: drag.y + 6 }} aria-hidden="true">{drag.branch}</span>, document.body);
}

/** The interactive rebase editor (spec #3 §4.1), in place of the graph (3A's center view). */
export function RebaseEditor({ tabId }: CenterViewProps<object>) {
  const session = useRebaseSessions((x) => x.sessions[tabId]);
  const root = useRef<HTMLElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  usePrediction(tabId);
  useEditorKeys(tabId, root, cancelButton);
  useInspectSelection(tabId);
  const drag = useRowDrag(list, (oids, to) => editState(tabId, (s) => moveRows(s, oids, to)));
  const color = useChipColor(tabId);
  const chipDragging = useChipDrag((x) => x.drag !== null);
  useChipDragCleanup();
  useEffect(() => { root.current?.focus(); }, []);
  const baseShown = useBaseInspected(tabId, session?.state ?? NO_STATE);
  if (!session) return null;
  const { state, prediction, moved, editing } = session;
  const g = grouping(state.rows);
  const why = problems(state, g);
  const edited = dirty(state);
  const chipView = drag.preview ? moveRows(state, drag.preview.oids, drag.preview.to) : state;
  const chips = { state: chipView, g: chipView === state ? g : grouping(chipView.rows) };
  return (
    <section ref={root} tabIndex={-1} className="irebase" aria-label="Interactive Rebase" data-testid="irebase">
      <header className="irebase-header">
        <h2>Interactive Rebase</h2>
        <span className="irebase-title">Rebasing <span className="irebase-chip" style={laneStyle(color(state.branch))}>{state.branch}</span> onto <span className="irebase-chip is-base" style={laneStyle(color(state.base.name))}>{state.base.name}</span></span>
        {state.merges > 0 && <span role="note" className="irebase-warn"><TriangleAlert size={13} aria-hidden="true" /> {flattenWarning(state.merges)}</span>}
        {(prediction.status === 'off' || prediction.status === 'failed') && <span className="irebase-note">{prediction.note}</span>}
        <span className="irebase-history">
          <HoverTooltip content={editing ? FINISH_MESSAGE : 'Undo the last plan change (Ctrl+Z)'}>
            <button type="button" className="icon-button" aria-label="Undo plan change" aria-disabled={!!editing || !session.past?.length} onClick={() => undoPlan(tabId)}><Undo2 size={15} aria-hidden="true" /></button>
          </HoverTooltip>
          <HoverTooltip content={editing ? FINISH_MESSAGE : 'Redo the plan change (Ctrl+Shift+Z)'}>
            <button type="button" className="icon-button" aria-label="Redo plan change" aria-disabled={!!editing || !session.future?.length} onClick={() => redoPlan(tabId)}><Redo2 size={15} aria-hidden="true" /></button>
          </HoverTooltip>
        </span>
        <button type="button" className="commit-neutral irebase-cancel-top" onClick={() => void cancelRebase(tabId)}>Cancel</button>
      </header>
      {moved && (
        <div role="alert" className="irebase-moved">
          The plan is out of date: {moved}. <button type="button" className="commit-neutral" onClick={() => void reloadRebase(tabId)}>Reload</button>
        </div>
      )}
      <ol ref={list} className={`irebase-rows${drag.dragging ? ' dragging' : ''}${chipDragging ? ' chip-dragging' : ''}${prediction.status === 'pending' ? ' predicting' : ''}`} role="listbox" aria-multiselectable="true" aria-label="Commits, newest first">
        {state.rows.map((r, i) => (
          <Row key={r.oid} tabId={tabId} row={r} index={i} state={state} g={g} chips={chips} conflict={prediction.byRow[r.oid]} editing={editing === r.oid} drag={drag} />
        ))}
        {/* Not a row of the plan: a click shows the base in the details panel (UX R2.2). */}
        <li className={`irebase-row irebase-base${baseShown ? ' is-selected' : ''}`} role="option" aria-selected={baseShown} onClick={() => inspectBase(tabId)}>
          <span className="irebase-handle" />
          <ChipColumn tabId={tabId} row={state.base.oid} state={chips.state} g={chips.g} />
          <span className="irebase-action is-base">{short(state.base.oid)}</span>
          <span className="irebase-fold" />
          <span className="irebase-summary">{state.base.summary}</span>
        </li>
      </ol>
      <footer className="irebase-footer">
        <span className="irebase-keys">P Pick · R Reword · S Squash · F Fixup · D Drop · E Edit · Ctrl+↑/↓ Move · Enter Message · Esc Cancel</span>
        <button type="button" className="commit-neutral" aria-disabled={!edited} onClick={() => edited && editState(tabId, reset)}>Reset</button>
        <button ref={cancelButton} type="button" className="commit-neutral" onClick={() => void cancelRebase(tabId)}>Cancel</button>
        <HoverTooltip content={why[0] ?? `Rebase ${state.branch} onto ${state.base.name}`}>
          <button type="button" className="commit-positive" aria-disabled={why.length > 0} onClick={() => void startRebase(tabId)}>Start Rebase</button>
        </HoverTooltip>
      </footer>
      <ChipGhost tabId={tabId} />
    </section>
  );
}
