import { api } from '../api/client';
import { toGbError } from '../errors/describe';
import { useToast } from '../ui/toast';
import { currentOrigin } from '../ui/arm/origin';
import { holdOrigin } from '../ui/arm/store';
import { MENU_HOLD_MS, runWrite } from '../write/client';
import { writeCtx } from '../write/ctx';
import { fromPlan, problems, toRequest, type Preset } from './model';
import { openRebaseEditor } from './open';

/**
 * Multi-select Squash (spec #3 §2, §4.3). The selected commits (newest first) fold into the
 * oldest, their messages merged, oldest first. Direct, it's one interactive rebase with no
 * editor; `interactive` opens the editor with that preset ("Squash interactively…"). Commits
 * between them keep their places. The squashed ones move next to the oldest, so a conflict pauses
 * as any rebase does.
 */
export async function squashSelection(tabId: string, branch: string, oids: string[], base: string, interactive: boolean): Promise<void> {
  const oldest = oids[oids.length - 1];
  const preset: Preset = { rows: Object.fromEntries(oids.slice(0, -1).map((o) => [o, 'squash' as const])), gather: oldest };
  if (interactive) {
    await openRebaseEditor(tabId, { branch, base, preset });
    return;
  }
  // The Squash row: its questions (autostash) arm it in place, its menu held open while the plan
  // loads and the write's first answer comes (integrate.ts's pattern).
  const origin = currentOrigin();
  const release = holdOrigin();
  const ctx = writeCtx(tabId);
  if (!ctx) return release();
  let state;
  try {
    state = fromPlan(await api.rebasePlan(ctx.repoId, ctx.worktree, branch, base), preset);
  } catch (e) {
    release();
    useToast.getState().show(`Couldn't squash: ${toGbError(e).message}`, { error: true });
    return;
  }
  const why = problems(state);
  if (why.length > 0) {
    release();
    useToast.getState().show(why[0], { error: true });
    return;
  }
  const { rows, chips } = toRequest(state);
  // An armed row keeps its menu open whatever the hold: let go once it asked, or after
  // MENU_HOLD_MS (a slow write's questions use the popover), or when it's done.
  const cap = setTimeout(release, MENU_HOLD_MS);
  try {
    await runWrite(ctx, (_confirmed, asked) => api.interactiveRebase(ctx.repoId, ctx.worktree, { branch, base, expect: state.expect, rows, chips, confirmAutostash: asked.autostash }), {
      origin,
      onSuccess: (o) => { if (o.status === 'done') useToast.getState().show(`Squashed ${oids.length} commits into ${oldest.slice(0, 7)}`); },
    });
  } finally {
    clearTimeout(cap);
    release();
  }
}
