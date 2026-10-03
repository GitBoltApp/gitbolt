// ui/src/stacks/rebase.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { PlanRow } from '../api/gen/PlanRow';
import type { RebasePlanPayload } from '../api/gen/RebasePlanPayload';
import { useToast } from '../ui/toast';
import type { Stack } from './detect';
import { rebaseConfirm, rebaseStack, rebaseStackRow, stackPlan } from './rebase';

const confirm = vi.fn();
vi.mock('../ui/ConfirmDialog', () => ({ confirmWith: (...a: unknown[]) => confirm(...a) }));
const ask = vi.fn();
vi.mock('../ui/ChoiceDialog', () => ({ askChoice: (...a: unknown[]) => ask(...a) }));
const openEditor = vi.fn();
vi.mock('../irebase/open', () => ({ openRebaseEditor: (...a: unknown[]) => openEditor(...a), REBASE_VIEW: 'irebase' }));

const ctx = { tabId: 't', repoId: 1, worktree: '/r' };
const ok = (outcome: unknown) => ({ outcome, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [], paused: null }, staging: { undo: null, redo: null, off: null }, wip: null });
const stack: Stack = { branches: ['feature/a', 'feature/b', 'feature/c'], base: 'refs/remotes/origin/main', leftBehind: [] };
const row = (oid: string, upstream = false): PlanRow => ({ oid, summary: oid, message: `${oid}\n`, authorName: 'Ada', authorEmail: 'ada@example.com', authorTime: 1, upstream });
const plan = (over: Partial<RebasePlanPayload> = {}): RebasePlanPayload => ({
  branch: 'feature/c', base: 'refs/remotes/origin/main', baseOid: 'm', baseSummary: 'Main moves', baseChips: [],
  rows: [row('c1'), row('b1'), row('a1')], merges: 0, behind: 1,
  chips: [{ branch: 'feature/a', at: 'a1', locked: null }, { branch: 'feature/b', at: 'b1', locked: null }],
  branches: ['feature/a', 'feature/b', 'feature/c', 'main'],
  expect: { 'refs/heads/feature/a': 'a1', 'refs/heads/feature/b': 'b1', 'refs/heads/feature/c': 'c1', 'refs/remotes/origin/main': 'm' },
  ...over,
});
/** feature/a's commit is already in origin/main under another id. */
const aInBase = () => plan({ rows: [row('c1'), row('b1'), row('a1', true)] });

describe('stackPlan (spec #3 §3.11)', () => {
  it("every row picks; a chip per lower member at its row; git moves the top; the plan's tips expected", () => {
    expect(stackPlan(stack, plan())).toEqual({
      branch: 'feature/c', base: 'refs/remotes/origin/main',
      expect: plan().expect,
      rows: [{ oid: 'c1', action: 'pick' }, { oid: 'b1', action: 'pick' }, { oid: 'a1', action: 'pick' }],
      chips: [{ branch: 'feature/a', at: { kind: 'row', oid: 'a1' } }, { branch: 'feature/b', at: { kind: 'row', oid: 'b1' } }],
    });
  });

  it("the base ref's expected tip is the plan's (unpeeled: an annotated tag's own object), never the base's peeled oid (3C F3)", () => {
    const tagged = plan({ base: 'refs/tags/v1', baseOid: 'peeled', expect: { ...plan().expect, 'refs/tags/v1': 'tagobj' } });
    expect(stackPlan({ ...stack, base: 'refs/tags/v1' }, tagged).expect['refs/tags/v1']).toBe('tagobj');
  });

  it('a member already in the base: its row drops, as git would, and its chip stays (Review Focus 1)', () => {
    const p = stackPlan(stack, aInBase());
    expect(p.rows.map((r) => r.action)).toEqual(['pick', 'pick', 'drop']);
    expect(p.chips).toEqual([{ branch: 'feature/a', at: { kind: 'stay' } }, { branch: 'feature/b', at: { kind: 'row', oid: 'b1' } }]);
  });

  it("a branch in range that isn't a member stays (Ruling 4)", () => {
    const p = stackPlan(stack, plan({ chips: [...plan().chips, { branch: 'main', at: 'a1', locked: null }] }));
    expect(p.chips).toEqual([
      { branch: 'feature/a', at: { kind: 'row', oid: 'a1' } },
      { branch: 'feature/b', at: { kind: 'row', oid: 'b1' } },
      { branch: 'main', at: { kind: 'stay' } },
    ]);
  });
});

describe('rebaseConfirm', () => {
  it('counts the branches; predicted conflicts warn; staying and left-behind branches are named (Review Focus 1, 5)', () => {
    const req = stackPlan(stack, plan());
    expect(rebaseConfirm(stack, req, 0)).toEqual({ arm: 'Click again to rebase 3 branches onto origin/main', caption: undefined, tone: 'positive' });
    expect(rebaseConfirm(stack, req, 2)).toEqual({ arm: 'Click again to rebase 3 branches onto origin/main (conflicts at 2 commits)', caption: '2 commits will conflict.', tone: 'warn' });
    const behind = { ...stack, leftBehind: ['feature/x'] };
    expect(rebaseConfirm(behind, stackPlan(behind, aInBase()), 0)).toEqual({
      arm: 'Click again to rebase 2 branches onto origin/main',
      caption: 'feature/a is already in origin/main and stays where it is. feature/x stays on the old commits.',
      tone: 'positive',
    });
  });

  it("a member the plan has no chip for (a stale graph stack) isn't called already in the base", () => {
    const stale = stackPlan(stack, plan({ chips: [{ branch: 'feature/b', at: 'b1', locked: null }] }));
    expect(rebaseConfirm(stack, stale, 0)).toEqual({ arm: 'Click again to rebase 2 branches onto origin/main', caption: 'feature/a stays where it is.', tone: 'positive' });
  });
});

describe('rebaseConfirm: non-member chips', () => {
  it('names branches sent as stay (up to 2, then +N more)', () => {
    const p = (extra: string[]) => stackPlan(stack, plan({ chips: [{ branch: 'feature/a', at: 'a1', locked: null }, { branch: 'feature/b', at: 'b1', locked: null }, ...extra.map((b) => ({ branch: b, at: 'a1', locked: null }))] }));
    expect(rebaseConfirm(stack, p(['main']), 0).caption).toBe('main stays where it is.');
    expect(rebaseConfirm(stack, p(['main', 'dev']), 0).caption).toBe('main and dev stay where they are.');
    expect(rebaseConfirm(stack, p(['main', 'dev', 'x', 'y']), 0).caption).toBe('main, dev +2 more stay where they are.');
  });
});

describe('rebaseStackRow (spec #3 §4.3)', () => {
  const t = (name: string) => ({ sha: 's', mrRefs: [], isWip: false, isStash: false, branch: { name, local: `refs/heads/${name}`, remotes: [] } });
  const lb = (name: string, target: string, worktree: string | null = null) => ({ name, fullName: `refs/heads/${name}`, target, worktree });
  const sidebar = (locals = [lb('feature/a', 'a1'), lb('feature/b', 'b1'), lb('feature/c', 'c1')]) => ({ locals, remotes: [{ name: 'origin', branches: [{ fullName: 'refs/remotes/origin/main', target: 'm' }] }] });
  const env = (over: object = {}) => ({ stackOf: (b: string) => (stack.branches.includes(b) ? stack : null), sidebar: sidebar(), inProgress: null, isAncestor: () => false, worktreeShown: (p: string) => p, headBranch: 'feature/c', ...over }) as never;
  const run = vi.fn();
  const labels = (rows: ReturnType<typeof rebaseStackRow>) => rows.map((r) => (r.kind === 'action' ? r.label : ''));

  it('on any member, named for the base; not off the stack', () => {
    for (const b of stack.branches) expect(labels(rebaseStackRow(t(b), env(), run))).toEqual(['Rebase stack onto origin/main']);
    expect(rebaseStackRow(t('feature/a'), env(), run)[0]).toMatchObject({ tooltip: 'Rebase feature/a → feature/b → feature/c onto origin/main, moving every branch' });
    expect(rebaseStackRow(t('main'), env(), run)).toEqual([]);
  });

  it('greyed when the graph cuts through the stack', () => {
    expect(rebaseStackRow(t('feature/a'), env({ stackOf: () => ({ ...stack, partial: true }) }), run)[0]).toMatchObject({ disabledReason: 'Load more history first' });
  });

  it('hidden when the stack already sits on the base', () => {
    expect(rebaseStackRow(t('feature/b'), env({ isAncestor: (a: string, b: string) => a === 'm' && b === 'a1' }), run)).toEqual([]);
  });

  it('greyed during another operation, while a member is checked out in another worktree (Review Focus 2), or while HEAD is not the top (Ruling 11)', () => {
    expect(rebaseStackRow(t('feature/a'), env({ inProgress: 'merge' }), run)[0]).toMatchObject({ disabledReason: 'Finish or abort the merge first' });
    const away = env({ sidebar: sidebar([lb('feature/a', 'a1'), lb('feature/b', 'b1', '/wt/b'), lb('feature/c', 'c1')]) });
    expect(rebaseStackRow(t('feature/a'), away, run)[0]).toMatchObject({ disabledReason: 'feature/b is checked out in /wt/b' });
    expect(rebaseStackRow(t('feature/a'), env({ headBranch: 'feature/a' }), run)[0]).toMatchObject({ disabledReason: 'Check out feature/c first' });
  });
});

describe('rebaseStack', () => {
  beforeEach(() => { vi.restoreAllMocks(); confirm.mockReset(); ask.mockReset(); openEditor.mockReset(); useToast.getState().dismiss(); });

  it('reads the top onto the base, arms in place with the predicted conflicts, then sends the plan as one interactive rebase', async () => {
    const read = vi.spyOn(api, 'rebasePlan').mockResolvedValue(plan());
    vi.spyOn(api, 'predictRebase').mockResolvedValue({ rows: [{ oid: 'b1', conflicts: ['x.txt'] }], off: null });
    const send = vi.spyOn(api, 'interactiveRebase').mockResolvedValue(ok({ status: 'done', commits: 3, fastForward: false }) as never);
    confirm.mockResolvedValue({ ok: true, checked: false });
    await rebaseStack(ctx, stack);
    expect(read).toHaveBeenCalledWith(1, '/r', 'feature/c', 'refs/remotes/origin/main');
    expect(confirm.mock.calls[0][0]).toMatchObject({ title: 'Rebase the stack onto origin/main?', arm: 'Click again to rebase 3 branches onto origin/main (conflicts at 1 commit)', tone: 'warn' });
    expect(send.mock.calls[0].slice(0, 2)).toEqual([1, '/r']);
    expect(send.mock.calls[0][2]).toMatchObject(stackPlan(stack, plan()));
    expect(useToast.getState().message).toBe('Rebased 3 branches onto origin/main');
    expect(useToast.getState().tone).toBeNull();
  });

  it('a member already in the base is sent as stay, and the toast counts only the branches that moved', async () => {
    vi.spyOn(api, 'rebasePlan').mockResolvedValue(aInBase());
    vi.spyOn(api, 'predictRebase').mockResolvedValue({ rows: [], off: null });
    const send = vi.spyOn(api, 'interactiveRebase').mockResolvedValue(ok({ status: 'done', commits: 2, fastForward: false }) as never);
    confirm.mockResolvedValue({ ok: true, checked: false });
    await rebaseStack(ctx, stack);
    expect(confirm.mock.calls[0][0]).toMatchObject({ arm: 'Click again to rebase 2 branches onto origin/main', caption: 'feature/a is already in origin/main and stays where it is.' });
    expect(send.mock.calls[0][2].chips).toEqual([{ branch: 'feature/a', at: { kind: 'stay' } }, { branch: 'feature/b', at: { kind: 'row', oid: 'b1' } }]);
    expect(useToast.getState().message).toBe('Rebased 2 branches onto origin/main');
  });

  it("a done or up-to-date outcome's warning is toasted as a warning", async () => {
    vi.spyOn(api, 'rebasePlan').mockResolvedValue(plan());
    vi.spyOn(api, 'predictRebase').mockResolvedValue({ rows: [], off: null });
    vi.spyOn(api, 'interactiveRebase')
      .mockResolvedValueOnce(ok({ status: 'done', commits: 3, fastForward: false, warning: "feature/a wasn't deleted" }) as never)
      .mockResolvedValueOnce(ok({ status: 'upToDate', warning: 'Something else' }) as never);
    confirm.mockResolvedValue({ ok: true, checked: false });
    await rebaseStack(ctx, stack);
    expect(useToast.getState()).toMatchObject({ message: 'Rebased 3 branches onto origin/main', detail: "feature/a wasn't deleted", tone: 'warning' });
    await rebaseStack(ctx, stack);
    expect(useToast.getState()).toMatchObject({ message: 'The stack is already on origin/main', detail: 'Something else', tone: 'warning' });
  });

  it('not confirmed: nothing runs; a failed prediction never blocks', async () => {
    vi.spyOn(api, 'rebasePlan').mockResolvedValue(plan());
    vi.spyOn(api, 'predictRebase').mockRejectedValue(new Error('boom'));
    const send = vi.spyOn(api, 'interactiveRebase');
    confirm.mockResolvedValue({ ok: false, checked: false });
    await rebaseStack(ctx, stack);
    expect(confirm.mock.calls[0][0]).toMatchObject({ arm: 'Click again to rebase 3 branches onto origin/main', tone: 'positive' });
    expect(send).not.toHaveBeenCalled();
  });

  it('merges in the range: refuses (never flattens silently) and offers the editor', async () => {
    vi.spyOn(api, 'rebasePlan').mockResolvedValue(plan({ merges: 2 }));
    const send = vi.spyOn(api, 'interactiveRebase');
    ask.mockResolvedValue({ choice: 'editor' });
    await rebaseStack(ctx, stack);
    expect(ask.mock.calls[0][0]).toMatchObject({ title: 'Rebase the stack onto origin/main?', body: 'This would flatten 2 merge commits: use the interactive rebase editor.' });
    expect(openEditor).toHaveBeenCalledWith('t', { branch: 'feature/c', base: 'refs/remotes/origin/main' });
    expect(send).not.toHaveBeenCalled();
  });

  it('already on the base, or nothing left to replay: says so, runs nothing', async () => {
    const allIn = plan({ rows: [row('c1', true), row('b1', true), row('a1', true)] });
    vi.spyOn(api, 'rebasePlan').mockResolvedValueOnce(plan({ behind: 0 })).mockResolvedValueOnce(allIn);
    await rebaseStack(ctx, stack);
    expect(useToast.getState().message).toBe('The stack is already on origin/main');
    await rebaseStack(ctx, stack);
    expect(useToast.getState().message).toBe('feature/c is already in origin/main');
    expect(confirm).not.toHaveBeenCalled();
  });
});
