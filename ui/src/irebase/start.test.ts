import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { centerViewOf, closeCenterView, openCenterView, registerCenterView } from '../repo/centerView';
import { useToast } from '../ui/toast';
import { REBASE_VIEW } from './open';
import { editSession, editState, NO_PREDICTION, sessionOf, setSession } from './session';
import { fromPlan, setActions } from './model';
import { cancelRebase, reloadRebase, startRebase } from './start';
import { oid, plan } from './testPlan';

const interactiveRebase = vi.hoisted(() => vi.fn());
const rebasePlan = vi.hoisted(() => vi.fn());
const confirmAction = vi.hoisted(() => vi.fn());
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: { interactiveRebase, rebasePlan } }));
vi.mock('../ui/ConfirmDialog', async (orig) => ({ ...(await orig<typeof import('../ui/ConfirmDialog')>()), confirmAction }));

const ctx = { tabId: 't1', repoId: 1, worktree: '/r' };
const ok = (outcome: unknown) => ({ outcome, journal: { undo: null, redo: null }, staging: {}, wip: null });
function open() {
  setSession('t1', { ctx, opened: { branch: 'topic', base: 'main' }, state: fromPlan(plan()), prediction: NO_PREDICTION, moved: null, editing: null });
  openCenterView('t1', REBASE_VIEW, {});
}

beforeAll(() => { registerCenterView(REBASE_VIEW, () => null); });
afterEach(() => { closeCenterView('t1'); setSession('t1', undefined); vi.clearAllMocks(); });

describe('Start, Cancel and Reload (spec #3 §4.1, §5)', () => {
  it('Start sends the plan, closes the editor at once and drops the session when it went through', async () => {
    open();
    editState('t1', (s) => setActions(s, [oid('d')], 'squash'));
    interactiveRebase.mockImplementation(async () => {
      expect(centerViewOf('t1')).toBeNull(); // back on the graph while it runs
      expect(sessionOf('t1')!.running).toBe(true); // entry points don't bring the editor back over it
      return ok({ status: 'done', commits: 4, fastForward: false });
    });
    await startRebase('t1');
    const [repo, wt, req] = interactiveRebase.mock.calls[0];
    expect([repo, wt]).toEqual([1, '/r']);
    expect(req).toMatchObject({ branch: 'topic', base: 'main', expect: { 'refs/heads/topic': oid('e') } });
    expect(req.rows.map((r: { action: string }) => r.action)).toEqual(['pick', 'squash', 'pick', 'pick', 'pick']);
    expect(req.rows[2].message).toBe('C\n\nD\n');
    expect(sessionOf('t1')).toBeUndefined();
  });

  it('a finished rebase with a warning toasts as a warning, the warning under it (3C T13)', async () => {
    open();
    interactiveRebase.mockResolvedValue(ok({ status: 'done', commits: 4, fastForward: false, warning: "feature/a wasn't deleted: it changed during the rebase" }));
    await startRebase('t1');
    expect(useToast.getState()).toMatchObject({ message: 'Rebased topic onto main', tone: 'warning', detail: "feature/a wasn't deleted: it changed during the rebase" });
  });

  it('a stop whose new message a hook refused toasts the warning (3C final fix M1, M2)', async () => {
    open();
    const warning = "The new message wasn't applied: Rejected. Type it again to retry, or Continue to keep the old one.";
    interactiveRebase.mockResolvedValue(ok({ status: 'stopped', kind: 'rebase', files: 0, warning }));
    await startRebase('t1');
    expect(useToast.getState()).toMatchObject({ message: warning, tone: 'warning' });
  });

  it('RefMoved brings the editor back, the plan as it was, with Reload', async () => {
    open();
    editState('t1', (s) => setActions(s, [oid('e')], 'drop'));
    interactiveRebase.mockRejectedValue({ kind: 'RefMoved', message: 'refs/heads/topic moved' });
    await startRebase('t1');
    expect(centerViewOf('t1')?.kind).toBe(REBASE_VIEW);
    expect(sessionOf('t1')!.moved).toBe('refs/heads/topic moved');
    expect(sessionOf('t1')!.running).toBe(false);
    expect(sessionOf('t1')!.state.rows[0].action).toBe('drop');
    rebasePlan.mockResolvedValue(plan());
    await reloadRebase('t1');
    expect(rebasePlan).toHaveBeenCalledWith(1, '/r', 'topic', 'main');
    expect(sessionOf('t1')!.moved).toBeNull();
    expect(sessionOf('t1')!.state.rows[0].action).toBe('drop');
  });

  it('a problem keeps Start from sending', async () => {
    open();
    editState('t1', (s) => setActions(s, [oid('a')], 'squash'));
    await startRebase('t1');
    expect(interactiveRebase).not.toHaveBeenCalled();
    expect(centerViewOf('t1')?.kind).toBe(REBASE_VIEW);
  });

  it('Cancel: an untouched plan closes at once; an edited one asks (in place) first', async () => {
    open();
    await cancelRebase('t1');
    expect(confirmAction).not.toHaveBeenCalled();
    expect(centerViewOf('t1')).toBeNull();
    open();
    editState('t1', (s) => setActions(s, [oid('e')], 'drop'));
    confirmAction.mockResolvedValue(false);
    await cancelRebase('t1');
    expect(confirmAction.mock.calls[0][0]).toMatchObject({ arm: 'Click again to discard your rebase plan', danger: true });
    expect(centerViewOf('t1')?.kind).toBe(REBASE_VIEW);
    confirmAction.mockResolvedValue(true);
    await cancelRebase('t1');
    expect(centerViewOf('t1')).toBeNull();
    expect(sessionOf('t1')).toBeUndefined();
  });

  it('declining the autostash question changes nothing: back to the editor, the plan intact', async () => {
    open();
    editState('t1', (s) => setActions(s, [oid('e')], 'drop'));
    interactiveRebase.mockRejectedValue({ kind: 'Conflict', message: 'x', commandId: null, stderr: null, detail: { kind: 'autostashConflict', paths: ['a.txt'], target: 'main' } });
    confirmAction.mockResolvedValue(false);
    await startRebase('t1');
    expect(confirmAction).toHaveBeenCalledTimes(1);
    expect(interactiveRebase).toHaveBeenCalledTimes(1);
    expect(centerViewOf('t1')?.kind).toBe(REBASE_VIEW);
    expect(sessionOf('t1')!.running).toBe(false);
    expect(sessionOf('t1')!.state.rows[0].action).toBe('drop');
  });

  it('a throw out of the write (a question that fails) keeps the plan: the editor back, no longer running', async () => {
    open();
    editState('t1', (s) => setActions(s, [oid('e')], 'drop'));
    interactiveRebase.mockRejectedValue({ kind: 'Conflict', message: 'x', commandId: null, stderr: null, detail: { kind: 'autostashConflict', paths: ['a.txt'], target: 'main' } });
    confirmAction.mockRejectedValue(new Error('the dialog went away'));
    await startRebase('t1');
    expect(sessionOf('t1')!.running).toBe(false);
    expect(centerViewOf('t1')?.kind).toBe(REBASE_VIEW);
    expect(sessionOf('t1')!.state.rows[0].action).toBe('drop');
    expect(useToast.getState().message).toBe("Couldn't start the rebase: the dialog went away");
  });

  it('a failure (toasted) keeps the plan: the editor comes back with it', async () => {
    open();
    editState('t1', (s) => setActions(s, [oid('e')], 'drop'));
    interactiveRebase.mockRejectedValue({ kind: 'Io', message: 'the disk is full', commandId: null, stderr: null });
    await startRebase('t1');
    expect(centerViewOf('t1')?.kind).toBe(REBASE_VIEW);
    expect(sessionOf('t1')!.state.rows[0].action).toBe('drop');
    expect(sessionOf('t1')!.moved).toBeNull();
  });

  it('Reload onto a moved base drops the old base\'s prediction', async () => {
    open();
    editSession('t1', (s) => ({ ...s, prediction: { status: 'ready', byRow: { [oid('c')]: ['a.txt'] }, first: oid('c'), note: null } }));
    rebasePlan.mockResolvedValue(plan());
    await reloadRebase('t1');
    expect(sessionOf('t1')!.prediction.byRow).toEqual({ [oid('c')]: ['a.txt'] });
    rebasePlan.mockResolvedValue(plan({ baseOid: oid('9') }));
    await reloadRebase('t1');
    expect(sessionOf('t1')!.prediction).toEqual(NO_PREDICTION);
  });
});
