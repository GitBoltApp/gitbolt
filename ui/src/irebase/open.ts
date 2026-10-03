import { api } from '../api/client';
import type { RebasePlanPayload } from '../api/gen/RebasePlanPayload';
import { useAppState } from '../app/state';
import { activateTab } from '../app/tabs';
import { toGbError } from '../errors/describe';
import { centerViewOf, openCenterView } from '../repo/centerView';
import { useToast } from '../ui/toast';
import { writeCtx } from '../write/ctx';
import { laneColors } from './colors';
import { dirty, fromPlan } from './model';
import { NO_PREDICTION, sessionOf, setSession, type OpenRebase } from './session';

/** The center view's kind (spec #3 §4.1: the editor replaces the graph area). `feature.ts` registers it. */
export const REBASE_VIEW = 'irebase';

/**
 * Opens the interactive rebase editor in tab `tabId`: `branch` (checked out in the tab's active
 * worktree) onto `base`, rows preset as `preset` says. It's the contract's entry point (the
 * branch chip menu, "Interactive rebase from here", "Squash interactively…", the palette, and
 * 3D's "Rebase stack"). False when it didn't open (a toast says why).
 *
 * The tab's open session is never silently replaced. While Start's write runs, the tab is only
 * focused (another target also gets a toast to wait). An edited plan comes back as it is: for the
 * same target (worktree, branch, base and preset) quietly, for another with a toast to finish or
 * cancel it first. An untouched plan is reloaded, or gives way to the new target.
 */
export async function openRebaseEditor(tabId: string, opts: OpenRebase): Promise<boolean> {
  const ctx = writeCtx(tabId);
  if (!ctx) return false;
  const open = sessionOf(tabId);
  if (open) {
    const same = open.ctx.worktree === ctx.worktree && sameTarget(open.opened, opts);
    const was = `${open.opened.branch} onto ${open.opened.base}`;
    if (open.running) {
      if (useAppState.getState().profile.activeTab !== tabId) useAppState.getState().updateProfile((p) => activateTab(p, tabId));
      if (!same) useToast.getState().show(`Rebasing ${was}: wait for it to finish`);
      return false;
    }
    if (dirty(open.state)) {
      if (centerViewOf(tabId)?.kind !== REBASE_VIEW) openCenterView(tabId, REBASE_VIEW, {});
      if (!same) useToast.getState().show(`Finish or cancel the interactive rebase of ${was} first`);
      return same;
    }
  }
  let plan: RebasePlanPayload;
  try {
    plan = await api.rebasePlan(ctx.repoId, ctx.worktree, opts.branch, opts.base);
  } catch (e) {
    useToast.getState().show(`Couldn't open the interactive rebase: ${toGbError(e).message}`, { error: true });
    return false;
  }
  if (plan.rows.length === 0) {
    useToast.getState().show(`${opts.branch} has no commits to rebase onto ${opts.base}`);
    return false;
  }
  setSession(tabId, { ctx, opened: opts, state: fromPlan(plan, opts.preset), prediction: NO_PREDICTION, moved: null, editing: null, colors: laneColors(tabId) });
  openCenterView(tabId, REBASE_VIEW, {});
  return true;
}

const presetKey = (o: OpenRebase) => JSON.stringify([o.preset?.gather ?? null, Object.entries(o.preset?.rows ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
const sameTarget = (a: OpenRebase, b: OpenRebase) => a.branch === b.branch && a.base === b.base && presetKey(a) === presetKey(b);
