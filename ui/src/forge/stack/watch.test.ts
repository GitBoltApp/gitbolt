import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { LocalBranch } from '../../api/gen/LocalBranch';
import { useRuntime } from '../../app/runtime';
import { useToast } from '../../ui/toast';
import { promptFor, resetPrompted } from './watch';

const retargetAndRebase = vi.fn();
vi.mock('./retarget', async (orig) => ({ ...(await orig<typeof import('./retarget')>()), retargetAndRebase: (...a: unknown[]) => retargetAndRebase(...a) }));
const mrs: Record<string, ForgeMr> = {};
const project = { kind: 'gitlab' as const, id: 42, host: 'gitlab.example.com', path: 'group/project', name: 'project', owner: 'group', webUrl: '', defaultBranch: 'main', cloneHttps: '', cloneSsh: '', forkOf: null, updatedAt: null, archived: false };
vi.mock('./deps', () => ({ forgeTarget: () => ({ remote: 'origin', kind: 'gitlab', project }), branchMrs: () => (b: string) => mrs[b] ?? null, useForge: { subscribe: () => () => {} } }));
vi.mock('../../stacks/detect', () => ({ stacksOf: () => [], stackBase: () => null, stackFor: () => stk.s }));
const stk = vi.hoisted(() => ({ s: null as unknown }));

const mr = (number: number, source: string, target: string, state: ForgeMr['state'] = 'open'): ForgeMr => ({
  number, title: `MR ${number}`, state, author: { id: 1, username: 'ada', name: 'Ada', avatarUrl: null, webUrl: '', email: null },
  sourceProject: 'group/project', sourceBranch: source, targetProject: 'group/project', targetBranch: target, headSha: `head${number}`,
  webUrl: '', pipeline: null, review: { decision: 'none', approvals: 0, approvalsRequired: null, reviews: [] }, conflicts: false, labels: [], updatedAt: number, stacked: true,
});
const lb = (name: string): LocalBranch => ({
  name, fullName: `refs/heads/${name}`, target: `${name}-tip`, upstream: `refs/remotes/origin/${name}`, ahead: 0, behind: 0, gone: false, tipTime: 0, summary: '', author: '',
  isHead: false, worktree: null, checkedOut: null, pushTarget: `origin/${name}`, pushBehind: 0, rewritten: null,
});
const tab = (head: string, locals = ['feature/a', 'feature/b']) => useRuntime.getState().patch('t', {
  repo: { id: 1, path: '/r' }, worktree: '/r',
  graph: { rows: [], labels: [], worktrees: [], head: { branch: `refs/heads/${head}`, target: null, detached: false, unborn: false } },
  sidebar: { locals: locals.map(lb), remotes: [], worktrees: [], stashes: [], tags: [] },
} as never);

describe('the after-merge prompt (Ruling 11)', () => {
  beforeEach(() => {
    resetPrompted();
    retargetAndRebase.mockReset();
    useToast.getState().dismiss();
    for (const k of Object.keys(mrs)) delete mrs[k];
    mrs['feature/a'] = mr(1, 'feature/a', 'main', 'merged');
    mrs['feature/b'] = mr(2, 'feature/b', 'feature/a');
    stk.s = null;
  });

  it('a sticky toast whose action runs the flow, once per merged MR', () => {
    tab('feature/b');
    promptFor('t');
    const s = useToast.getState();
    expect([s.message, s.sticky, s.action?.label]).toEqual(['!1 was merged.', true, 'Retarget the next MR and rebase the stack']);
    s.action!.run();
    expect(retargetAndRebase.mock.calls[0][1]).toMatchObject({ merged: { number: 1 }, next: { number: 2 }, retarget: true });
    useToast.getState().dismiss();
    promptFor('t');
    expect(useToast.getState().message).toBeNull();
  });

  it('the action rechecks: HEAD moved since the prompt, no retarget', () => {
    tab('feature/b');
    promptFor('t');
    const action = useToast.getState().action!;
    tab('feature/a');
    action.run();
    expect(retargetAndRebase).not.toHaveBeenCalled();
    expect(useToast.getState().message).toBe('Check out feature/b first');
  });

  it('the native/GitHub path: the forge already retargeted, so the action is Rebase the stack without !1', () => {
    mrs['feature/b'] = mr(2, 'feature/b', 'main');
    stk.s = { branches: ['feature/a', 'feature/b'], base: 'refs/remotes/origin/main', leftBehind: [] };
    tab('feature/b');
    promptFor('t');
    const s = useToast.getState();
    expect(s.action?.label).toBe('Rebase the stack without !1');
    s.action!.run();
    expect(retargetAndRebase.mock.calls[0][1]).toMatchObject({ retarget: false });
  });

  it('with the top not checked out it only says what to do', () => {
    tab('feature/a');
    promptFor('t');
    expect(useToast.getState()).toMatchObject({ message: '!1 was merged: check out feature/b to retarget !2 and rebase the stack', sticky: true, action: null });
  });

  it('nothing merged: no prompt', () => {
    mrs['feature/a'] = mr(1, 'feature/a', 'main', 'open');
    tab('feature/b');
    promptFor('t');
    expect(useToast.getState().message).toBeNull();
  });

  it("the merged bottom's local branch was deleted (the usual cleanup): still prompted, its MR's head the drop point", () => {
    tab('feature/b', ['feature/b']);
    promptFor('t');
    useToast.getState().action!.run();
    expect(retargetAndRebase.mock.calls[0][1]).toMatchObject({ merged: { number: 1 }, branches: ['feature/b'], dropFrom: ['head1'] });
  });

  it('environment branches: main → production merged, feature MRs on main: no prompt', () => {
    for (const k of Object.keys(mrs)) delete mrs[k];
    mrs.main = mr(10, 'main', 'production', 'merged');
    mrs['feature/a'] = mr(11, 'feature/a', 'main');
    mrs['feature/b'] = mr(12, 'feature/b', 'main');
    tab('feature/b', ['main', 'feature/a', 'feature/b']);
    promptFor('t');
    expect(useToast.getState().message).toBeNull();
  });
});
