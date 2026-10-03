import { api } from '../api/client';
import { toGbError } from '../errors/describe';
import { centerViewOf, closeCenterView, openCenterView } from '../repo/centerView';
import { currentOrigin, type Origin } from '../ui/arm/origin';
import { confirmAction } from '../ui/ConfirmDialog';
import { useToast } from '../ui/toast';
import { runWrite } from '../write/client';
import { toastRebaseOutcome } from './outcome';
import { dirty, problems, reload, toRequest } from './model';
import { REBASE_VIEW } from './open';
import { NO_PREDICTION, editSession, sessionOf, setSession } from './session';

export const flattenWarning = (n: number) => `${n} merge ${n === 1 ? 'commit' : 'commits'} will be flattened into a straight line`;

/** Start Rebase (spec #3 §4.1): back to the graph at once, where the commit panel shows the
 * progress or the stop. RefMoved brings the editor back with Reload (§5). */
export async function startRebase(tabId: string): Promise<void> {
  const s = sessionOf(tabId);
  if (!s || problems(s.state).length > 0) return;
  const { ctx, state } = s;
  const { rows, chips } = toRequest(state);
  editSession(tabId, (x) => ({ ...x, moved: null, editing: null, running: true }));
  closeCenterView(tabId);
  // Nothing was written (a declined question, as a Cancel there; a failure the toast told; a
  // throw out of runWrite): back to the editor, the plan as it was, no longer running.
  const back = () => {
    editSession(tabId, (x) => ({ ...x, running: false }));
    if (sessionOf(tabId) && centerViewOf(tabId)?.kind !== REBASE_VIEW) openCenterView(tabId, REBASE_VIEW, {});
  };
  let out;
  try {
    out = await runWrite(ctx, (_confirmed, asked) => api.interactiveRebase(ctx.repoId, ctx.worktree, { branch: state.branch, base: state.base.name, expect: state.expect, rows, chips, confirmAutostash: asked.autostash }), {
      handle: (err) => {
        if (err.kind !== 'RefMoved') return false;
        editSession(tabId, (x) => ({ ...x, moved: err.message, running: false }));
        openCenterView(tabId, REBASE_VIEW, {});
        return true;
      },
    });
  } catch (e) {
    back();
    useToast.getState().show(`Couldn't start the rebase: ${toGbError(e).message}`, { error: true });
    return;
  }
  if (out !== null) setSession(tabId, undefined);
  else back();
  // 3C T13: a finished rebase's warning (a chip that moved meanwhile, kept) toasts as one.
  if (out?.status === 'done') toastRebaseOutcome(out, `Rebased ${state.branch} onto ${state.base.name}`);
  else if (out?.status === 'upToDate') toastRebaseOutcome(out, `${state.branch} is unchanged`);
  // 3C final fix M1, M2: a stop whose new message a hook refused says so.
  else toastRebaseOutcome(out);
}

/** Cancel and Esc (spec #3 §4.1): an edited plan arms in place first. */
export async function cancelRebase(tabId: string, origin: Origin | null = currentOrigin()): Promise<void> {
  const s = sessionOf(tabId);
  if (!s) return;
  if (dirty(s.state)) {
    const ok = await confirmAction({ title: 'Discard your rebase plan?', body: 'The changes you made in the editor are lost.', confirmLabel: 'Discard', arm: 'Click again to discard your rebase plan', danger: true }, origin);
    if (!ok) return;
  }
  closeCenterView(tabId);
  setSession(tabId, undefined);
}

/** Reload (spec #3 §5): the new plan, keeping what it can of the edited one. */
export async function reloadRebase(tabId: string): Promise<void> {
  const s = sessionOf(tabId);
  if (!s) return;
  try {
    const plan = await api.rebasePlan(s.ctx.repoId, s.ctx.worktree, s.opened.branch, s.opened.base);
    // Another base: the old prediction says nothing about the new one.
    editSession(tabId, (x) => ({ ...x, state: reload(x.state, plan), moved: null, prediction: plan.baseOid === x.state.base.oid ? x.prediction : NO_PREDICTION }));
  } catch (e) {
    useToast.getState().show(`Couldn't reload the plan: ${(e as { message?: string }).message ?? e}`, { error: true });
  }
}
