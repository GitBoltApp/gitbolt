import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { centerViewOf, closeCenterView, registerCenterView } from '../repo/centerView';
import { useToast } from '../ui/toast';
import { REBASE_VIEW, openRebaseEditor } from './open';
import { editSession, editState, pruneSessions, sessionOf, setSession, useRebaseSessions } from './session';
import { oid, plan } from './testPlan';

const rebasePlan = vi.hoisted(() => vi.fn());
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: { rebasePlan } }));
vi.mock('../write/ctx', () => ({ writeCtx: (tabId: string) => ({ tabId, repoId: 1, worktree: '/r' }) }));

beforeAll(() => { registerCenterView(REBASE_VIEW, () => null); });
afterEach(() => { closeCenterView('t1'); setSession('t1', undefined); rebasePlan.mockReset(); });

describe('openRebaseEditor (spec #3 §4.1; the contract entry point)', () => {
  it('loads the plan, applies the preset and shows the editor in place of the graph', async () => {
    rebasePlan.mockResolvedValue(plan());
    expect(await openRebaseEditor('t1', { branch: 'topic', base: 'main', preset: { rows: { [oid('c')]: 'squash' } } })).toBe(true);
    expect(rebasePlan).toHaveBeenCalledWith(1, '/r', 'topic', 'main');
    const s = sessionOf('t1')!;
    expect(s.state.rows.find((r) => r.oid === oid('c'))!.action).toBe('squash');
    expect(s.opened).toEqual({ branch: 'topic', base: 'main', preset: { rows: { [oid('c')]: 'squash' } } });
    expect(centerViewOf('t1')?.kind).toBe(REBASE_VIEW);
  });

  it('nothing to rebase: a toast, no editor', async () => {
    rebasePlan.mockResolvedValue(plan({ rows: [] }));
    expect(await openRebaseEditor('t1', { branch: 'topic', base: 'main' })).toBe(false);
    expect(useToast.getState().message).toBe('topic has no commits to rebase onto main');
    expect(centerViewOf('t1')).toBeNull();
  });

  it('the same target again: the open session comes back as it was, the plan not reloaded', async () => {
    rebasePlan.mockResolvedValue(plan());
    await openRebaseEditor('t1', { branch: 'topic', base: 'main' });
    editState('t1', (s) => ({ ...s, rows: s.rows.map((r) => (r.oid === oid('c') ? { ...r, action: 'drop' } : r)) }));
    closeCenterView('t1');
    rebasePlan.mockClear();
    expect(await openRebaseEditor('t1', { branch: 'topic', base: 'main' })).toBe(true);
    expect(rebasePlan).not.toHaveBeenCalled();
    expect(sessionOf('t1')!.state.rows.find((r) => r.oid === oid('c'))!.action).toBe('drop');
    expect(centerViewOf('t1')?.kind).toBe(REBASE_VIEW);
  });

  it('another target while a plan is edited: the edited plan comes back, kept, and a toast says why', async () => {
    rebasePlan.mockResolvedValue(plan());
    await openRebaseEditor('t1', { branch: 'topic', base: 'main' });
    editState('t1', (s) => ({ ...s, rows: s.rows.map((r) => (r.oid === oid('c') ? { ...r, action: 'drop' } : r)) }));
    closeCenterView('t1');
    rebasePlan.mockClear();
    expect(await openRebaseEditor('t1', { branch: 'topic', base: oid('a') })).toBe(false);
    expect(rebasePlan).not.toHaveBeenCalled();
    expect(sessionOf('t1')!.opened).toEqual({ branch: 'topic', base: 'main' });
    expect(sessionOf('t1')!.state.rows.find((r) => r.oid === oid('c'))!.action).toBe('drop');
    expect(centerViewOf('t1')?.kind).toBe(REBASE_VIEW);
    expect(useToast.getState().message).toBe('Finish or cancel the interactive rebase of topic onto main first');
  });

  it('the same target with the plan untouched: reloaded', async () => {
    rebasePlan.mockResolvedValue(plan());
    await openRebaseEditor('t1', { branch: 'topic', base: 'main' });
    rebasePlan.mockResolvedValue(plan({ rows: plan().rows.slice(1) }));
    expect(await openRebaseEditor('t1', { branch: 'topic', base: 'main' })).toBe(true);
    expect(rebasePlan).toHaveBeenCalledTimes(2);
    expect(sessionOf('t1')!.state.rows).toHaveLength(4);
  });

  it("while Start's write runs: the tab is focused, the editor not brought back over it", async () => {
    rebasePlan.mockResolvedValue(plan());
    await openRebaseEditor('t1', { branch: 'topic', base: 'main' });
    editState('t1', (s) => ({ ...s, rows: s.rows.map((r) => (r.oid === oid('c') ? { ...r, action: 'drop' } : r)) }));
    editSession('t1', (s) => ({ ...s, running: true }));
    closeCenterView('t1');
    rebasePlan.mockClear();
    useToast.getState().show('before');
    expect(await openRebaseEditor('t1', { branch: 'topic', base: 'main' })).toBe(false);
    expect(rebasePlan).not.toHaveBeenCalled();
    expect(centerViewOf('t1')).toBeNull();
    expect(useToast.getState().message).toBe('before');
    expect(await openRebaseEditor('t1', { branch: 'topic', base: oid('a') })).toBe(false);
    expect(centerViewOf('t1')).toBeNull();
    expect(useToast.getState().message).toBe('Rebasing topic onto main: wait for it to finish');
    expect(sessionOf('t1')!.state.rows.find((r) => r.oid === oid('c'))!.action).toBe('drop');
  });

  it('another target while the plan is untouched: it opens in its place', async () => {
    rebasePlan.mockResolvedValue(plan());
    await openRebaseEditor('t1', { branch: 'topic', base: 'main' });
    expect(await openRebaseEditor('t1', { branch: 'topic', base: 'main', preset: { rows: { [oid('c')]: 'squash' } } })).toBe(true);
    expect(rebasePlan).toHaveBeenCalledTimes(2);
    expect(sessionOf('t1')!.opened.preset).toEqual({ rows: { [oid('c')]: 'squash' } });
  });

  it("a closed tab's session goes with it", async () => {
    rebasePlan.mockResolvedValue(plan());
    await openRebaseEditor('t1', { branch: 'topic', base: 'main' });
    pruneSessions((id) => id !== 't1');
    expect('t1' in useRebaseSessions.getState().sessions).toBe(false);
  });

  it('a refused plan: its reason in an error toast, no editor', async () => {
    rebasePlan.mockRejectedValue({ kind: 'InvalidInput', message: 'Over 1000 commits between main and topic: the editor takes up to 1000' });
    expect(await openRebaseEditor('t1', { branch: 'topic', base: 'main' })).toBe(false);
    expect(useToast.getState().message).toMatch(/the editor takes up to 1000/);
    expect(sessionOf('t1')).toBeUndefined();
  });
});
