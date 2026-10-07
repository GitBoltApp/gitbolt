import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { LocalBranch } from '../../api/gen/LocalBranch';
import type { StackView } from '../../api/gen/StackView';
import type { Stack } from '../../stacks/detect';
import { baseBranch, createStackRow, createSummary, memberPlans, runCreateStack, submitLabel } from './create';

const createMr = vi.fn();
vi.mock('./deps', () => ({ createMr: (...a: unknown[]) => createMr(...a), noteForgeWritten: () => {} }));

const mr = (number: number, source: string, target: string, state: ForgeMr['state'] = 'open'): ForgeMr => ({
  number, title: `MR ${number}`, state, author: { id: 1, username: 'ada', name: 'Ada', avatarUrl: null, webUrl: '', email: null },
  sourceProject: 'group/project', sourceBranch: source, targetProject: 'group/project', targetBranch: target, headSha: null,
  webUrl: '', pipeline: null, review: { decision: 'none', approvals: 0, approvalsRequired: null, reviews: [] }, conflicts: false, labels: [], labelColors: {}, updatedAt: number, autoMerge: null, stacked: false,
});
const project = { kind: 'gitlab' as const, id: 42, host: 'gitlab.example.com', path: 'group/project', name: 'project', owner: 'group', webUrl: '', defaultBranch: 'main', cloneHttps: '', cloneSsh: '', forkOf: null, updatedAt: null, archived: false, ownerAvatarUrl: null };
const target = { remote: 'origin', kind: 'gitlab' as const, project };
const ctx = { tabId: 't', repoId: 1, worktree: '/r' };
const view = (members: StackView['members'], mode: StackView['mode'] = 'managed'): StackView => ({ remote: 'origin', project: 'group/project', kind: 'gitlab', mode, members });
const member = (branch: string, targetBranch: string, m: ForgeMr | null, title = `Work on ${branch}`) => ({ branch, targetBranch, mr: m, prefill: m && m.state !== 'closed' ? null : { title, description: 'Why' } });
const lb = (name: string, over: Partial<LocalBranch> = {}): LocalBranch => ({
  name, fullName: `refs/heads/${name}`, target: 'x'.repeat(40), upstream: `refs/remotes/origin/${name}`, ahead: 0, behind: 0, gone: false, tipTime: 0, summary: '', author: '',
  isHead: false, worktree: null, checkedOut: null, pushTarget: `origin/${name}`, pushBehind: 0, rewritten: null, ...over,
});
const stack: Stack = { branches: ['feature/a', 'feature/b', 'feature/c'], base: 'refs/remotes/origin/main', leftBehind: [] };
const chip = (name: string) => ({ branch: { local: `refs/heads/${name}` } }) as never;
const sidebar = (locals: LocalBranch[]) => ({ locals, remotes: [], worktrees: [], stashes: [], tags: [] }) as never;

describe('memberPlans and the submit label (Rulings 6, 7)', () => {
  it('creates where there is none (or only a closed one), retargets a wrong target, keeps a right one, refuses a merged one', () => {
    const plans = memberPlans(view([
      member('feature/a', 'main', mr(1, 'feature/a', 'main')),
      member('feature/b', 'feature/a', mr(2, 'feature/b', 'main')),
      member('feature/c', 'feature/b', mr(3, 'feature/c', 'feature/b', 'closed')),
      member('feature/d', 'feature/c', null),
    ]));
    expect(plans.map((p) => p.kind)).toEqual(['ok', 'retarget', 'create', 'create']);
    expect(plans[2]).toMatchObject({ title: 'Work on feature/c', description: 'Why', target: 'feature/b' });
    expect(submitLabel(plans, 'gitlab')).toBe('Create 2 MRs and retarget 1');
    expect(memberPlans(view([member('feature/a', 'main', mr(1, 'feature/a', 'main', 'merged'))]))[0].kind).toBe('merged');
  });

  it('says what it will do, in the forge noun', () => {
    const c = { kind: 'create' as const, branch: 'b', target: 'a', title: 't', description: '' };
    const r = { kind: 'retarget' as const, branch: 'b', target: 'a', mr: mr(2, 'b', 'main') };
    expect(submitLabel([c], 'github')).toBe('Create 1 PR');
    expect(submitLabel([c, c, c], 'gitlab')).toBe('Create 3 MRs');
    expect(submitLabel([r], 'github')).toBe('Retarget 1 PR');
    expect(submitLabel([], 'gitlab')).toBeNull();
  });

  it("names the base as the forge's branch", () => {
    expect(baseBranch('refs/remotes/origin/main', 'origin')).toBe('main');
    expect(baseBranch('refs/remotes/upstream/release/1', 'origin')).toBe('release/1');
    expect(baseBranch('refs/heads/main', 'origin')).toBe('main');
  });
});

describe('runCreateStack', () => {
  beforeEach(() => { vi.restoreAllMocks(); createMr.mockReset(); });

  it('goes bottom first, retargets and creates, then writes the tables (managed)', async () => {
    const v = view([member('feature/a', 'main', mr(1, 'feature/a', 'feature/x')), member('feature/b', 'feature/a', null), member('feature/c', 'feature/b', null)]);
    const retarget = vi.spyOn(api, 'forgeRetarget').mockResolvedValue(mr(1, 'feature/a', 'main'));
    createMr.mockResolvedValueOnce({ mr: mr(5, 'feature/b', 'feature/a'), failed: [] }).mockResolvedValueOnce({ mr: mr(6, 'feature/c', 'feature/b'), failed: [] });
    const sync = vi.spyOn(api, 'forgeSyncStack').mockResolvedValue({ edited: [1, 5, 6], unchanged: [], failed: [] });
    const r = await runCreateStack(ctx, target, v, memberPlans(v), { 'feature/b': ' Parser ' }, true);
    expect(retarget).toHaveBeenCalledWith(1, 1, 'main');
    expect(createMr.mock.calls[0]).toEqual([ctx, { remote: 'origin', source: { project: 'group/project', branch: 'feature/b' }, targetBranch: 'feature/a', title: 'Parser', description: 'Why', draft: true, reviewers: [], assignees: [], labels: [], squash: null, deleteSourceBranch: null }]);
    expect(createMr.mock.calls[1][1]).toMatchObject({ targetBranch: 'feature/b', title: 'Work on feature/c' });
    expect(sync).toHaveBeenCalledWith(1, ['feature/a', 'feature/b', 'feature/c'], 'main');
    expect(r).toEqual({ created: [5, 6], retargeted: [1], failed: null, rest: [], table: [] });
    expect(createSummary(r, 'gitlab')).toEqual({ message: 'Created !5 and !6; retargeted !1', error: false, warning: false });
  });

  it('the first failure stops the rest; what was created still gets its table', async () => {
    const v = view([member('feature/a', 'main', null), member('feature/b', 'feature/a', null), member('feature/c', 'feature/b', null)]);
    createMr.mockResolvedValueOnce({ mr: mr(5, 'feature/a', 'main'), failed: [] }).mockRejectedValueOnce({ kind: 'InvalidInput', message: 'Another open merge request already exists for this source branch', commandId: null, stderr: null });
    vi.spyOn(api, 'forgeSyncStack').mockResolvedValue({ edited: [], unchanged: [], failed: [{ number: 5, message: 'refused (403)' }] });
    const r = await runCreateStack(ctx, target, v, memberPlans(v), {}, false);
    expect(createMr).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ created: [5], failed: { branch: 'feature/b', action: 'create' }, rest: ['feature/c'], table: [{ number: 5, message: 'refused (403)' }] });
    expect(createSummary(r, 'gitlab')).toEqual({
      message: "Created !5; feature/b's MR wasn't created: Another open merge request already exists for this source branch; not created: feature/c",
      detail: "Couldn't update the stack table in !5: refused (403)", error: true, warning: true,
    });
  });

  it('a native stack gets no table', async () => {
    const v = view([member('feature/a', 'main', null)], 'native');
    createMr.mockResolvedValueOnce({ mr: mr(5, 'feature/a', 'main'), failed: [] });
    const sync = vi.spyOn(api, 'forgeSyncStack');
    await runCreateStack(ctx, target, v, memberPlans(v), {}, false);
    expect(sync).not.toHaveBeenCalled();
  });
});

describe('createStackRow (the Sync group, after Push stack)', () => {
  const env = (locals: LocalBranch[], over: object = {}) => ({ stackOf: () => stack, sidebar: sidebar(locals), inProgress: null, ...over }) as never;
  const pushed = [lb('feature/a'), lb('feature/b'), lb('feature/c')];
  const none = () => null;

  it('offers Create stack MRs/PRs… on any member while one is missing or mistargeted', () => {
    const open = vi.fn();
    const rows = createStackRow(chip('feature/b'), env(pushed), target, none, open);
    expect(rows.map((r) => r.kind === 'action' && [r.label, r.tooltip, r.disabledReason])).toEqual([['Create stack MRs…', 'One MR per branch, each targeting the branch below it', undefined]]);
    if (rows[0].kind === 'action') rows[0].run();
    expect(open).toHaveBeenCalledWith(stack);
    expect((createStackRow(chip('feature/b'), env(pushed), { ...target, kind: 'github' }, none, open)[0] as { label: string }).label).toBe('Create stack PRs…');
  });

  it('is hidden when every member has its MR on the right target, or without a forge or a stack', () => {
    const all = (b: string) => ({ 'feature/a': mr(1, 'feature/a', 'main'), 'feature/b': mr(2, 'feature/b', 'feature/a'), 'feature/c': mr(3, 'feature/c', 'feature/b', 'draft') })[b] ?? null;
    expect(createStackRow(chip('feature/b'), env(pushed), target, all, vi.fn())).toEqual([]);
    expect(createStackRow(chip('feature/b'), env(pushed), null, none, vi.fn())).toEqual([]);
    expect(createStackRow(chip('feature/b'), env(pushed, { stackOf: () => null }), target, none, vi.fn())).toEqual([]);
  });

  it('asks for a push first: a member ahead, rewritten, unpublished, or on another remote (Ruling 5)', () => {
    const reason = (locals: LocalBranch[]) => (createStackRow(chip('feature/b'), env(locals), target, none, vi.fn())[0] as { disabledReason?: string }).disabledReason;
    expect(reason([lb('feature/a', { ahead: 1 }), lb('feature/b'), lb('feature/c')])).toBe('Push the stack first');
    expect(reason([lb('feature/a'), lb('feature/b', { pushTarget: null, upstream: null }), lb('feature/c')])).toBe('Push the stack first');
    expect(reason([lb('feature/a'), lb('feature/b'), lb('feature/c', { pushTarget: 'fork/feature/c', upstream: 'refs/remotes/fork/feature/c' })])).toBe('Push the stack first');
    expect((createStackRow(chip('feature/b'), env(pushed, { inProgress: 'rebase' }), target, none, vi.fn())[0] as { disabledReason?: string }).disabledReason).toBe('Finish or abort the rebase first');
  });
});
