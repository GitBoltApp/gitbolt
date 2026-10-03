import { afterEach, describe, expect, it, vi } from 'vitest';
import { setOrigin, type Origin } from '../ui/arm/origin';
import { useToast } from '../ui/toast';
import { squashSelection } from './squash';
import { oid, plan } from './testPlan';

const rebasePlan = vi.hoisted(() => vi.fn());
const interactiveRebase = vi.hoisted(() => vi.fn());
const open = vi.hoisted(() => vi.fn(async () => true));
const confirmAction = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: { rebasePlan, interactiveRebase } }));
vi.mock('../write/ctx', () => ({ writeCtx: (tabId: string) => ({ tabId, repoId: 1, worktree: '/r' }) }));
vi.mock('./open', () => ({ openRebaseEditor: open, REBASE_VIEW: 'irebase' }));
vi.mock('../ui/ConfirmDialog', async (orig) => ({ ...(await orig<typeof import('../ui/ConfirmDialog')>()), confirmAction }));

const ok = { outcome: { status: 'done', commits: 3, fastForward: false }, journal: { undo: null, redo: null }, staging: {}, wip: null };
afterEach(() => { vi.clearAllMocks(); setOrigin(null); });

describe('multi-select Squash (spec #3 §2)', () => {
  it('runs directly: the selection gathered above the oldest, squashed into it, messages merged oldest first', async () => {
    rebasePlan.mockResolvedValue(plan({ chips: [] }));
    interactiveRebase.mockResolvedValue(ok);
    await squashSelection('t1', 'topic', [oid('e'), oid('c'), oid('b')], oid('a'), false);
    expect(rebasePlan).toHaveBeenCalledWith(1, '/r', 'topic', oid('a'));
    const req = interactiveRebase.mock.calls[0][2];
    expect(req.rows.map((r: { oid: string; action: string }) => `${r.oid[0]}:${r.action}`)).toEqual(['d:pick', 'e:squash', 'c:squash', 'b:pick', 'a:pick']);
    expect(req.rows[3].message).toBe('B\n\nC\n\nE\n');
    expect(useToast.getState().message).toBe('Squashed 3 commits into bbbbbbb');
  });

  it('interactively: the editor, preset the same way', async () => {
    await squashSelection('t1', 'topic', [oid('e'), oid('b')], oid('a'), true);
    expect(open).toHaveBeenCalledWith('t1', { branch: 'topic', base: oid('a'), preset: { rows: { [oid('e')]: 'squash' }, gather: oid('b') } });
  });

  it("its autostash question arms the Squash row it started from, its menu held until then", async () => {
    const close = vi.fn();
    const row: Origin = { el: document.createElement('button'), rect: null, via: 'pointer', control: true, menu: { close }, holds: 0 };
    setOrigin(row);
    rebasePlan.mockImplementation(async () => {
      expect(row.holds).toBe(1);
      setOrigin(null); // the plan's await: another click may have moved the current origin
      return plan({ chips: [] });
    });
    interactiveRebase.mockRejectedValueOnce({ kind: 'Conflict', message: 'x', commandId: null, stderr: null, detail: { kind: 'autostashConflict', paths: ['a.txt'], target: 'main' } }).mockResolvedValueOnce(ok);
    await squashSelection('t1', 'topic', [oid('e'), oid('b')], oid('a'), false);
    expect(confirmAction).toHaveBeenCalledTimes(1);
    expect((confirmAction.mock.calls[0] as unknown[])[1]).toBe(row);
    expect(interactiveRebase.mock.calls[1][2].confirmAutostash).toBe(true);
    expect(row.holds).toBe(0);
    expect(close).toHaveBeenCalled();
  });

  it("a plan it can't load: an error toast, the hold released", async () => {
    const row: Origin = { el: document.createElement('button'), rect: null, via: 'pointer', control: true, menu: { close: vi.fn() }, holds: 0 };
    setOrigin(row);
    rebasePlan.mockRejectedValue({ kind: 'InvalidInput', message: 'topic is not checked out here' });
    await squashSelection('t1', 'topic', [oid('e'), oid('b')], oid('a'), false);
    expect(useToast.getState().message).toBe("Couldn't squash: topic is not checked out here");
    expect(interactiveRebase).not.toHaveBeenCalled();
    expect(row.holds).toBe(0);
  });

  it('a plan with a problem: refused with an error toast, nothing sent', async () => {
    rebasePlan.mockResolvedValue(plan({ chips: [] }));
    // The oldest isn't in the plan: the gather is ignored, and A has nothing below to squash into.
    await squashSelection('t1', 'topic', [oid('a'), oid('z')], oid('0'), false);
    expect(useToast.getState().message).toBe('Nothing below aaaaaaa A to squash it into');
    expect(interactiveRebase).not.toHaveBeenCalled();
  });
});
