import { create } from 'zustand';
import type { WriteCtx } from '../write/client';
import { samePlan, type EditorChip, type EditorRow, type EditorState, type Preset } from './model';

/** Conflict prediction as the editor shows it (spec #3 §3.2). */
export interface PredictionView {
  status: 'idle' | 'pending' | 'ready' | 'off' | 'failed';
  /** Each conflicting row's paths. */
  byRow: Record<string, string[]>;
  /** The first conflicting row, in replay order. */
  first: string | null;
  /** "Prediction is off for ranges over 300 commits", "Couldn't predict conflicts", … */
  note: string | null;
}
export const NO_PREDICTION: PredictionView = { status: 'idle', byRow: {}, first: null, note: null };

export interface OpenRebase { branch: string; base: string; preset?: Preset }

/** One tab's interactive rebase editor. It outlives the view: Start closes the view, and a RefMoved
 * answer brings it back with the plan as it was (spec #3 §5's Reload). */
export interface RebaseSession {
  ctx: WriteCtx;
  opened: OpenRebase;
  state: EditorState;
  prediction: PredictionView;
  /** RefMoved on Start: the ref that moved; the editor offers Reload. */
  moved: string | null;
  /** The row whose message is open for editing (a fold target: its merged message). */
  editing: string | null;
  /** Start's write is running (the view closed): an entry point must not bring the editor back
   * over it. */
  running?: boolean;
  /** Each branch's lane colour index in the graph when the editor opened (a chip takes its
   * branch's graph colour); a branch not there has the default chip colour. */
  colors?: Record<string, number>;
  /** The plan before each change, newest last (Undo), and the undone ones (Redo). */
  past?: PlanSnapshot[];
  future?: PlanSnapshot[];
}

/** A plan as Undo/Redo restore it: the rows (order, actions, messages) and the chips. */
export interface PlanSnapshot { rows: EditorRow[]; chips: EditorChip[] }
/** How many plan changes Undo goes back. */
export const UNDO_LIMIT = 200;

export const useRebaseSessions = create<{ sessions: Record<string, RebaseSession | undefined> }>(() => ({ sessions: {} }));

export const sessionOf = (tabId: string): RebaseSession | undefined => useRebaseSessions.getState().sessions[tabId];

export function setSession(tabId: string, s: RebaseSession | undefined): void {
  useRebaseSessions.setState((x) => ({ sessions: { ...x.sessions, [tabId]: s } }));
}

export function editSession(tabId: string, f: (s: RebaseSession) => RebaseSession): void {
  const s = sessionOf(tabId);
  if (s) setSession(tabId, f(s));
}

const snap = (s: EditorState): PlanSnapshot => ({ rows: s.rows, chips: s.chips });

/** Edits the plan. A change to it (not the selection alone) is one Undo step, and clears Redo. */
export const editState = (tabId: string, f: (s: EditorState) => EditorState): void => editSession(tabId, (s) => {
  const state = f(s.state);
  if (samePlan(state, s.state)) return { ...s, state };
  return { ...s, state, past: [...(s.past ?? []), snap(s.state)].slice(-UNDO_LIMIT), future: [] };
});

/** Undo (`back`) or Redo of the last plan change; the selection stays. False: nothing to do, or
 * a message editor is open (its draft is never dropped: finish it first). */
function step(tabId: string, back: boolean): boolean {
  const s = sessionOf(tabId);
  const from = back ? s?.past : s?.future;
  if (!s || !from?.length || s.editing !== null) return false;
  const to = from[from.length - 1];
  const rest = from.slice(0, -1);
  const other = [...((back ? s.future : s.past) ?? []), snap(s.state)];
  const state = { ...s.state, rows: to.rows, chips: to.chips };
  setSession(tabId, { ...s, state, past: back ? rest : other, future: back ? other : rest });
  return true;
}
export const undoPlan = (tabId: string): boolean => step(tabId, true);
export const redoPlan = (tabId: string): boolean => step(tabId, false);

/** Drops the sessions of tabs no longer open (`live`: the open tabs' ids): a closed tab keeps none. */
export function pruneSessions(live: (tabId: string) => boolean): void {
  const { sessions } = useRebaseSessions.getState();
  const gone = Object.keys(sessions).filter((id) => !live(id));
  if (gone.length === 0) return;
  const next = { ...sessions };
  for (const id of gone) delete next[id];
  useRebaseSessions.setState({ sessions: next });
}
