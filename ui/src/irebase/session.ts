import { create } from 'zustand';
import type { WriteCtx } from '../write/client';
import type { EditorState, Preset } from './model';

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
}

export const useRebaseSessions = create<{ sessions: Record<string, RebaseSession | undefined> }>(() => ({ sessions: {} }));

export const sessionOf = (tabId: string): RebaseSession | undefined => useRebaseSessions.getState().sessions[tabId];

export function setSession(tabId: string, s: RebaseSession | undefined): void {
  useRebaseSessions.setState((x) => ({ sessions: { ...x.sessions, [tabId]: s } }));
}

export function editSession(tabId: string, f: (s: RebaseSession) => RebaseSession): void {
  const s = sessionOf(tabId);
  if (s) setSession(tabId, f(s));
}

export const editState = (tabId: string, f: (s: EditorState) => EditorState): void => editSession(tabId, (s) => ({ ...s, state: f(s.state) }));

/** Drops the sessions of tabs no longer open (`live`: the open tabs' ids): a closed tab keeps none. */
export function pruneSessions(live: (tabId: string) => boolean): void {
  const { sessions } = useRebaseSessions.getState();
  const gone = Object.keys(sessions).filter((id) => !live(id));
  if (gone.length === 0) return;
  const next = { ...sessions };
  for (const id of gone) delete next[id];
  useRebaseSessions.setState({ sessions: next });
}
