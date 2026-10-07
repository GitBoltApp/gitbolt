import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { LocalBranch } from '../../api/gen/LocalBranch';
import { useRuntime } from '../../app/runtime';
import { writeEpoch } from '../mrStore';
import { useToast } from '../../ui/toastStore';
import type { AfterMerge, StackEnv } from './chain';
import { branchOf } from '../../sync/push';
import { afterMergeBlocked, afterMergeLabel, afterMergeRow, rebaseBase, retargetAndRebase } from './retarget';

const rebaseStack = vi.fn();
const pushStack = vi.fn();
vi.mock('../../stacks/rebase', () => ({ rebaseStack: (...a: unknown[]) => rebaseStack(...a) }));
vi.mock('../../stacks/push', () => ({ pushStack: (...a: unknown[]) => pushStack(...a) }));

const mr = (number: number, source: string, target: string, state: ForgeMr['state'] = 'open'): ForgeMr => ({
  number, title: `MR ${number}`, state, author: { id: 1, username: 'ada', name: 'Ada', avatarUrl: null, webUrl: '', email: null },
  sourceProject: 'group/project', sourceBranch: source, targetProject: 'group/project', targetBranch: target, headSha: `head${number}`,
  webUrl: '', pipeline: null, review: { decision: 'none', approvals: 0, approvalsRequired: null, reviews: [] }, conflicts: false, labels: [], labelColors: {}, updatedAt: number, autoMerge: null, stacked: true,
});
const lb = (name: string, over: Partial<LocalBranch> = {}): LocalBranch => ({
  name, fullName: `refs/heads/${name}`, target: `${name}-tip`, upstream: `refs/remotes/origin/${name}`, ahead: 0, behind: 0, gone: false, tipTime: 0, summary: '', author: '',
  isHead: false, worktree: null, checkedOut: null, pushTarget: `origin/${name}`, pushBehind: 0, rewritten: null, ...over,
});
const project = { kind: 'gitlab' as const, id: 42, host: 'gitlab.example.com', path: 'group/project', name: 'project', owner: 'group', webUrl: '', defaultBranch: 'main', cloneHttps: '', cloneSsh: '', forkOf: null, updatedAt: null, archived: false, ownerAvatarUrl: null };
const target = { remote: 'origin', kind: 'gitlab' as const, project };
const ctx = { tabId: 't', repoId: 1, worktree: '/r' };
const merged = mr(1, 'feature/a', 'main', 'merged');
const a: AfterMerge = { merged, next: mr(2, 'feature/b', 'feature/a'), target: 'main', retarget: true, branches: ['feature/b', 'feature/c'], dropFrom: ['a1'] };
const report = (failed: unknown = null, warnings: string[] = []) => ({ steps: [], failed, rest: [], remote: 'origin', warnings });
const setRemoteMain = (has: boolean) => useRuntime.getState().patch('t', { repo: { id: 1 }, sidebar: { locals: [], remotes: [{ name: 'origin', host: null, hostKind: 'gitlab', branches: has ? [{ fullName: 'refs/remotes/origin/main' }] : [] }], worktrees: [], stashes: [], tags: [] } } as never);

describe('the after-merge labels and refusals (Rulings 8, 10)', () => {
  it('says what one click does', () => {
    expect(afterMergeLabel(a, 'gitlab')).toBe('Retarget !2 and rebase the stack');
    expect(afterMergeLabel({ ...a, retarget: false }, 'github')).toBe('Rebase the stack without the merged #1');
  });

  it('needs the top checked out, nothing in progress, and no member in another worktree', () => {
    const env = (over: object = {}) => ({ headBranch: 'feature/c', inProgress: null, locals: [lb('feature/b'), lb('feature/c')], worktreeShown: (p: string) => p, ...over });
    expect(afterMergeBlocked(a, env())).toBeUndefined();
    expect(afterMergeBlocked(a, env({ headBranch: 'feature/b' }))).toBe('Check out feature/c first');
    expect(afterMergeBlocked(a, env({ inProgress: 'merge' }))).toBe('Finish or abort the merge first');
    expect(afterMergeBlocked(a, env({ locals: [lb('feature/b', { worktree: '/w2' }), lb('feature/c')] }))).toBe('feature/b is checked out in /w2');
  });

  it("rebases onto the target remote's branch when the graph has it, else onto the local branch", () => {
    setRemoteMain(true);
    expect(rebaseBase('t', 'origin', 'main')).toBe('refs/remotes/origin/main');
    setRemoteMain(false);
    expect(rebaseBase('t', 'origin', 'main')).toBe('refs/heads/main');
  });
});

describe('retargetAndRebase (spec #4 §4 4D)', () => {
  beforeEach(() => { vi.restoreAllMocks(); rebaseStack.mockReset(); pushStack.mockReset(); useToast.getState().dismiss(); setRemoteMain(true);
    // The refresh after a rebase reads the graph and sidebar: nothing here reaches a real backend.
    vi.spyOn(api, 'graph').mockRejectedValue(new Error('unmocked graph'));
    vi.spyOn(api, 'sidebar').mockRejectedValue(new Error('unmocked sidebar'));
    vi.spyOn(useRuntime.getState(), 'refresh').mockResolvedValue();
  });

  it('retargets first, fetches, rebases without the merged commits, pushes, then writes the tables', async () => {
    const order: string[] = [];
    vi.spyOn(api, 'forgeRetarget').mockImplementation(async () => { order.push('retarget'); return mr(2, 'feature/b', 'main'); });
    const fetch = vi.spyOn(api, 'fetch').mockImplementation(async () => { order.push('fetch'); return { status: 'done' } as never; });
    rebaseStack.mockImplementation(async () => { order.push('rebase'); return { status: 'done', commits: 2, fastForward: false }; });
    pushStack.mockImplementation(async () => { order.push('push'); return report(); });
    const sync = vi.spyOn(api, 'forgeSyncStack').mockImplementation(async () => { order.push('sync'); return { edited: [2, 3], unchanged: [], failed: [] }; });
    await retargetAndRebase(ctx, a, target, null);
    expect(order).toEqual(['retarget', 'fetch', 'rebase', 'push', 'sync']);
    expect(fetch).toHaveBeenCalledWith(1, false, 'origin');
    expect(rebaseStack).toHaveBeenCalledWith(ctx, { branches: ['feature/b', 'feature/c'], base: 'refs/remotes/origin/main', leftBehind: [] }, { drop: { from: ['a1'], branch: 'feature/a' }, origin: null });
    expect(pushStack.mock.calls[0][1].branches).toEqual(['feature/b', 'feature/c']);
    expect(sync).toHaveBeenCalledWith(1, ['feature/a', 'feature/b', 'feature/c'], 'main');
    expect(useToast.getState().message).toBe('Retargeted !2 to main, then rebased and pushed the stack');
  });

  it('pushes from the sidebar as the rebase left it: it refreshes first', async () => {
    const order: string[] = [];
    vi.spyOn(api, 'forgeRetarget').mockImplementation(async () => { order.push('retarget'); return mr(2, 'feature/b', 'main'); });
    vi.spyOn(api, 'fetch').mockImplementation(async () => { order.push('fetch'); return { status: 'done' } as never; });
    vi.spyOn(api, 'forgeSyncStack').mockImplementation(async () => { order.push('sync'); return { edited: [], unchanged: [], failed: [] }; });
    rebaseStack.mockImplementation(async () => { order.push('rebase'); return { status: 'done', commits: 2, fastForward: false }; });
    vi.spyOn(useRuntime.getState(), 'refresh').mockImplementation(async () => {
      order.push('refresh');
      useRuntime.getState().patch('t', { sidebar: { ...useRuntime.getState().tabs.t.sidebar!, locals: [lb('feature/b', { target: 'b-new', ahead: 1 })] } });
    });
    let seen: string | undefined;
    pushStack.mockImplementation(async () => { order.push('push'); seen = branchOf('t', 'feature/b')?.target; return report(); });
    await retargetAndRebase(ctx, a, target, null);
    expect(order).toEqual(['retarget', 'fetch', 'rebase', 'refresh', 'push', 'sync']);
    expect(seen).toBe('b-new');
  });

  it('a cancelled or stopped rebase neither refreshes nor pushes', async () => {
    vi.spyOn(api, 'forgeRetarget').mockResolvedValue(mr(2, 'feature/b', 'main'));
    vi.spyOn(api, 'fetch').mockResolvedValue({ status: 'done' } as never);
    const refresh = vi.spyOn(useRuntime.getState(), 'refresh').mockResolvedValue();
    for (const out of [{ status: 'cancelled' }, { status: 'stopped', kind: 'conflict', files: 1 }]) {
      rebaseStack.mockResolvedValueOnce(out);
      await retargetAndRebase(ctx, a, target, null);
    }
    expect(refresh).not.toHaveBeenCalled();
    expect(pushStack).not.toHaveBeenCalled();
  });

  /** Review Focus 4. */
  it('a failed retarget changes nothing local and says why', async () => {
    vi.spyOn(api, 'forgeRetarget').mockRejectedValue({ kind: 'RateLimited', message: 'gitlab.example.com rate limit reached: try again in 2 min', commandId: null, stderr: null });
    const fetch = vi.spyOn(api, 'fetch');
    await retargetAndRebase(ctx, a, target, null);
    expect(fetch).not.toHaveBeenCalled();
    expect(rebaseStack).not.toHaveBeenCalled();
    expect(pushStack).not.toHaveBeenCalled();
    expect(useToast.getState()).toMatchObject({ message: "Couldn't retarget !2 to main: gitlab.example.com rate limit reached: try again in 2 min" });
  });

  it('already retargeted (GitHub, native GitLab): no retarget; a local base: no fetch', async () => {
    setRemoteMain(false);
    const retarget = vi.spyOn(api, 'forgeRetarget');
    const fetch = vi.spyOn(api, 'fetch');
    rebaseStack.mockResolvedValue({ status: 'done', commits: 2, fastForward: false });
    pushStack.mockResolvedValue(report());
    vi.spyOn(api, 'forgeSyncStack').mockResolvedValue({ edited: [], unchanged: [2, 3], failed: [] });
    await retargetAndRebase(ctx, { ...a, retarget: false }, target, null);
    expect(retarget).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(rebaseStack.mock.calls[0][1].base).toBe('refs/heads/main');
    expect(useToast.getState().message).toBe('Rebased the stack onto main and pushed it');
  });

  it('a failed fetch stops before the rebase and says the retarget happened', async () => {
    vi.spyOn(api, 'forgeRetarget').mockResolvedValue(mr(2, 'feature/b', 'main'));
    vi.spyOn(api, 'fetch').mockRejectedValue({ kind: 'Network', message: 'Could not resolve host', commandId: 3, stderr: null });
    await retargetAndRebase(ctx, a, target, null);
    expect(rebaseStack).not.toHaveBeenCalled();
    expect(useToast.getState()).toMatchObject({ message: "Retargeted !2 to main; the stack wasn't rebased: fetching origin failed (Could not resolve host)", detail: null });
  });

  it("a cancelled rebase stops there; a stopped one (conflict) is #3's, and nothing is pushed", async () => {
    vi.spyOn(api, 'forgeRetarget').mockResolvedValue(mr(2, 'feature/b', 'main'));
    vi.spyOn(api, 'fetch').mockResolvedValue({ status: 'done' } as never);
    rebaseStack.mockResolvedValueOnce({ status: 'cancelled' });
    await retargetAndRebase(ctx, a, target, null);
    expect(useToast.getState().message).toBe("Retargeted !2 to main; the stack wasn't rebased. Use “Rebase the stack without the merged !1” on feature/c");
    useToast.getState().dismiss();
    rebaseStack.mockResolvedValueOnce({ status: 'stopped', kind: 'conflict', files: 1 });
    await retargetAndRebase(ctx, a, target, null);
    expect(pushStack).not.toHaveBeenCalled();
    expect(useToast.getState().message).toBeNull();
  });

  it('a refused or failed rebase keeps its own toast', async () => {
    vi.spyOn(api, 'forgeRetarget').mockResolvedValue(mr(2, 'feature/b', 'main'));
    vi.spyOn(api, 'fetch').mockResolvedValue({ status: 'done' } as never);
    rebaseStack.mockImplementationOnce(async () => { useToast.getState().show('Finish or abort the merge first', { error: true }); return null; });
    await retargetAndRebase(ctx, a, target, null);
    expect(useToast.getState()).toMatchObject({ message: 'Finish or abort the merge first', detail: 'Retargeted !2 to main.' });
    // Nothing retargeted: the refusal stays as it was.
    useToast.getState().dismiss();
    rebaseStack.mockImplementationOnce(async () => { useToast.getState().show('Finish or abort the merge first', { error: true }); return null; });
    await retargetAndRebase(ctx, { ...a, retarget: false }, target, null);
    expect(useToast.getState()).toMatchObject({ message: 'Finish or abort the merge first', detail: null });
  });

  it("the push's server warnings stay in the final toast, under it", async () => {
    vi.spyOn(api, 'forgeRetarget').mockResolvedValue(mr(2, 'feature/b', 'main'));
    vi.spyOn(api, 'fetch').mockResolvedValue({ status: 'done' } as never);
    rebaseStack.mockResolvedValue({ status: 'done', commits: 2, fastForward: false });
    pushStack.mockResolvedValue(report(null, ['remote: pipeline quota almost used']));
    vi.spyOn(api, 'forgeSyncStack').mockResolvedValue({ edited: [2], unchanged: [], failed: [{ number: 3, message: 'refused (403)' }] });
    await retargetAndRebase(ctx, a, target, null);
    expect(useToast.getState()).toMatchObject({
      message: 'Retargeted !2 to main, then rebased and pushed the stack', tone: 'warning', sticky: true,
      detail: "“remote: pipeline quota almost used” Couldn't update the stack table in !3: refused (403)",
    });
  });

  it('the retarget bumps the write epoch, so a poll already under way drops its stale targets', async () => {
    vi.spyOn(api, 'forgeRetarget').mockResolvedValue(mr(2, 'feature/b', 'main'));
    vi.spyOn(api, 'fetch').mockResolvedValue({ status: 'skipped', reason: 'busy' } as never);
    const before = writeEpoch('t');
    await retargetAndRebase(ctx, a, target, null);
    expect(writeEpoch('t')).toBe(before + 1);
  });

  it('a second click while the flow runs starts nothing', async () => {
    const retarget = vi.spyOn(api, 'forgeRetarget').mockResolvedValue(mr(2, 'feature/b', 'main'));
    vi.spyOn(api, 'fetch').mockResolvedValue({ status: 'done' } as never);
    let finish: (v: unknown) => void = () => {};
    rebaseStack.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
    const first = retargetAndRebase(ctx, a, target, null);
    await vi.waitFor(() => expect(rebaseStack).toHaveBeenCalledTimes(1));
    await retargetAndRebase(ctx, a, target, null);
    expect(retarget).toHaveBeenCalledTimes(1);
    finish({ status: 'cancelled' });
    await first;
    rebaseStack.mockResolvedValueOnce({ status: 'cancelled' });
    await retargetAndRebase(ctx, a, target, null);
    expect(retarget).toHaveBeenCalledTimes(2);
  });

  it('the merged head already in the base (merge commit): nothing dropped, the way back is plain Rebase stack; a squash drops and names the row', async () => {
    vi.spyOn(api, 'forgeRetarget').mockResolvedValue(mr(2, 'feature/b', 'main'));
    vi.spyOn(api, 'fetch').mockResolvedValue({ status: 'done' } as never);
    rebaseStack.mockResolvedValue({ status: 'cancelled' });
    const mb = vi.spyOn(api, 'mergeBase').mockResolvedValue('head1');
    await retargetAndRebase(ctx, a, target, null);
    expect(mb).toHaveBeenCalledWith(1, 'head1', 'refs/remotes/origin/main'); // core takes oids or full ref names
    expect(rebaseStack.mock.calls.at(-1)![2].drop).toBeNull();
    expect(useToast.getState().message).toBe("Retargeted !2 to main; the stack wasn't rebased. Use “Rebase stack” on feature/c");
    vi.spyOn(api, 'mergeBase').mockResolvedValue('older');
    await retargetAndRebase(ctx, a, target, null);
    expect(rebaseStack.mock.calls.at(-1)![2].drop).toEqual({ from: ['a1'], branch: 'feature/a' });
  });

  it('the merges/editor hand-off after a retarget still says the stack was not rebased', async () => {
    vi.spyOn(api, 'forgeRetarget').mockResolvedValue(mr(2, 'feature/b', 'main'));
    vi.spyOn(api, 'fetch').mockResolvedValue({ status: 'done' } as never);
    vi.spyOn(api, 'mergeBase').mockResolvedValue(null);
    rebaseStack.mockResolvedValue({ status: 'editor' });
    await retargetAndRebase(ctx, a, target, null);
    expect(useToast.getState().message).toMatch(/^Retargeted !2 to main; the stack wasn't rebased/);
  });

  it('a skipped fetch says why; an up-to-date stack after a retarget says so', async () => {
    vi.spyOn(api, 'forgeRetarget').mockResolvedValue(mr(2, 'feature/b', 'main'));
    const fetch = vi.spyOn(api, 'fetch').mockResolvedValueOnce({ status: 'skipped', reason: 'busy' } as never);
    await retargetAndRebase(ctx, a, target, null);
    expect(useToast.getState().message).toBe("Retargeted !2 to main; the stack wasn't rebased: fetching origin was skipped (another fetch was running)");
    fetch.mockResolvedValue({ status: 'done' } as never);
    rebaseStack.mockResolvedValue({ status: 'upToDate' });
    pushStack.mockResolvedValue(report());
    vi.spyOn(api, 'forgeSyncStack').mockResolvedValue({ edited: [], unchanged: [], failed: [] });
    await retargetAndRebase(ctx, a, target, null);
    expect(useToast.getState().message).toBe('Retargeted !2 to main; the stack was already on main');
  });

  it('an up-to-date stack with nothing retargeted adds no second toast', async () => {
    vi.spyOn(api, 'fetch').mockResolvedValue({ status: 'done' } as never);
    rebaseStack.mockResolvedValue({ status: 'upToDate' });
    pushStack.mockResolvedValue(report());
    vi.spyOn(api, 'forgeSyncStack').mockResolvedValue({ edited: [], unchanged: [2, 3], failed: [] });
    await retargetAndRebase(ctx, { ...a, retarget: false }, target, null);
    expect(useToast.getState().message).toBeNull();
  });

  it("a failed push is Push stack's to report; a table that can't be written is a warning", async () => {
    vi.spyOn(api, 'forgeRetarget').mockResolvedValue(mr(2, 'feature/b', 'main'));
    vi.spyOn(api, 'fetch').mockResolvedValue({ status: 'done' } as never);
    rebaseStack.mockResolvedValue({ status: 'done', commits: 2, fastForward: false });
    pushStack.mockResolvedValueOnce(report({ name: 'feature/b', error: { kind: 'NonFastForward' } }));
    const sync = vi.spyOn(api, 'forgeSyncStack').mockResolvedValue({ edited: [2], unchanged: [], failed: [{ number: 3, message: 'refused (403)' }] });
    await retargetAndRebase(ctx, a, target, null);
    expect(sync).not.toHaveBeenCalled();
    pushStack.mockResolvedValueOnce(report());
    await retargetAndRebase(ctx, a, target, null);
    expect(useToast.getState()).toMatchObject({ message: 'Retargeted !2 to main, then rebased and pushed the stack', tone: 'warning', detail: "Couldn't update the stack table in !3: refused (403)" });
  });
});

describe('afterMergeRow (the Integrate group, after Rebase stack)', () => {
  const mrs: Record<string, ForgeMr> = { 'feature/a': merged, 'feature/b': mr(2, 'feature/b', 'feature/a'), 'feature/c': mr(3, 'feature/c', 'feature/b') };
  const stackEnv = (over: Record<string, ForgeMr> = {}): StackEnv => ({
    mrOf: (b) => ({ ...mrs, ...over })[b] ?? null,
    locals: new Set(['main', 'feature/a', 'feature/b', 'feature/c']),
    defaultBranch: 'main', base: 'main',
    stackOf: () => ({ branches: ['feature/b', 'feature/c'], base: 'refs/remotes/origin/main', leftBehind: [] }),
    tipOf: (b) => `${b}-tip`,
  });
  const env = (head: string) => ({
    sidebar: { locals: [lb('feature/a'), lb('feature/b'), lb('feature/c')], remotes: [], worktrees: [], stashes: [], tags: [] },
    inProgress: null, headBranch: head, worktreeShown: (p: string) => p,
  }) as never;
  const chip = (name: string) => ({ branch: { local: `refs/heads/${name}` } }) as never;

  it('offers the after-merge action on a member, armed for the top', () => {
    const run = vi.fn();
    const rows = afterMergeRow(chip('feature/b'), env('feature/c'), target, stackEnv(), run);
    expect(rows).toHaveLength(1);
    const row = rows[0] as { label: string; disabledReason?: string; run(): void };
    expect([row.label, row.disabledReason]).toEqual(['Retarget !2 and rebase the stack', undefined]);
    row.run();
    expect(run.mock.calls[0][0]).toMatchObject({ next: { number: 2 }, branches: ['feature/b', 'feature/c'], dropFrom: ['head1', 'feature/a-tip'] });
    expect((afterMergeRow(chip('feature/b'), env('feature/b'), target, stackEnv(), run)[0] as { disabledReason?: string }).disabledReason).toBe('Check out feature/c first');
  });

  it('is hidden when nothing merged, there is no forge project, or the merged one is a long-lived branch (main → production)', () => {
    expect(afterMergeRow(chip('feature/b'), env('feature/c'), target, stackEnv({ 'feature/a': mr(1, 'feature/a', 'main') }), vi.fn())).toEqual([]);
    expect(afterMergeRow(chip('feature/b'), env('feature/c'), null, stackEnv(), vi.fn())).toEqual([]);
    const envBranches = stackEnv({ main: mr(10, 'main', 'production', 'merged'), 'feature/b': mr(2, 'feature/b', 'main') });
    expect(afterMergeRow(chip('feature/b'), env('feature/c'), target, { ...envBranches, stackOf: () => null }, vi.fn())).toEqual([]);
  });
});
