import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MenuRow } from '../menu/types';
import { chipCopyRows, chipManageRows } from './chipMenu';
import { addChip, fromPlan, moveChip, type EditorState } from './model';
import { NO_PREDICTION, editState, sessionOf, setSession } from './session';
import { oid, plan } from './testPlan';

const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../ui/ConfirmDialog', () => ({ confirmAction: confirm }));
const copy = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../api/transport', () => ({ copyText: copy }));

const ctx = { tabId: 't1', repoId: 1, worktree: '/r' };
const show = (f: (s: EditorState) => EditorState = (s) => s) =>
  setSession('t1', { ctx, opened: { branch: 'topic', base: 'main' }, state: f(fromPlan(plan())), prediction: NO_PREDICTION, moved: null, editing: null });
const rows = (branch: string) => chipManageRows({ tabId: 't1', branch }).filter((r): r is Extract<MenuRow, { kind: 'action' }> => r.kind === 'action');
const chip = (branch: string) => sessionOf('t1')!.state.chips.find((c) => c.branch === branch);
const flush = () => new Promise((r) => setTimeout(r, 0));
afterEach(() => { setSession('t1', undefined); confirm.mockClear(); });

describe('the editor chip menu (UX R1.3)', () => {
  it('Delete branch arms in place, then strikes the chip out; Restore brings it back', async () => {
    show();
    expect(rows('x').map((r) => r.label)).toEqual(['Delete branch']);
    rows('x')[0].run();
    await flush();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ arm: 'Click again to delete x', danger: true }));
    expect(chip('x')!.deleted).toBe(true);
    expect(rows('x').map((r) => r.label)).toEqual(['Restore']);
    rows('x')[0].run();
    expect(chip('x')!.deleted).toBe(false);
  });

  it('a declined confirm changes nothing', async () => {
    show();
    confirm.mockResolvedValueOnce(false);
    rows('x')[0].run();
    await flush();
    expect(chip('x')!.deleted).toBe(false);
  });

  it('a moved chip offers "Remove from this plan\'s changes": back on its row', () => {
    show((s) => moveChip(s, 'x', oid('d')));
    expect(rows('x').map((r) => r.label)).toEqual(['Delete branch', "Remove from this plan's changes"]);
    rows('x')[1].run();
    expect(chip('x')!.at).toBe(oid('b'));
  });

  it('an added chip: Delete drops it; a locked one, the rebased branch\'s and the base\'s get Copy only', async () => {
    show((s) => addChip(s, 'n', oid('c')) as EditorState);
    rows('n')[0].run();
    await flush();
    expect(chip('n')).toBeUndefined();
    expect(rows('y')).toEqual([]);
    expect(rows('topic')).toEqual([]);
    expect(rows('main')).toEqual([]);
    const [c] = chipCopyRows({ tabId: 't1', branch: 'main' });
    expect(c.kind === 'action' && c.label).toBe('Copy branch name');
    if (c.kind === 'action') c.run();
    expect(copy).toHaveBeenCalledWith('main');
  });

  it('each menu action is one plan Undo step', async () => {
    show();
    rows('x')[0].run();
    await flush();
    expect(sessionOf('t1')!.past).toHaveLength(1);
    editState('t1', (s) => s);
    expect(sessionOf('t1')!.past).toHaveLength(1);
  });
});
