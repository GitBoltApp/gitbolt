import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { LocalBranch } from '../../api/gen/LocalBranch';
import { useRuntime } from '../../app/runtime';
import { patchForge, writeEpoch } from '../mrStore';
import { mrOf } from '../testMrs';
import { branchMrs, createMr } from './deps';
import { inProgressOf, stackEnvOf } from './env';

const project = { kind: 'gitlab' as const, id: 42, host: 'gitlab.example.com', path: 'group/project', name: 'project', owner: 'group', webUrl: '', defaultBranch: 'main', cloneHttps: '', cloneSsh: '', forkOf: null, updatedAt: null, archived: false };
const lb = (name: string, target: string): LocalBranch => ({
  name, fullName: `refs/heads/${name}`, target, upstream: null, ahead: 0, behind: 0, gone: false, tipTime: 0, summary: '', author: '',
  isHead: false, worktree: null, checkedOut: null, pushTarget: null, pushBehind: null, rewritten: null,
});
const row = (id: string, parents: string[]) => ({ id, parents }) as never;

describe("the stack predicates' tab inputs", () => {
  beforeEach(() => {
    patchForge('e', { kind: 'gitlab', remote: 'origin', project, byRef: {}, upstreams: {} });
    useRuntime.getState().patch('e', {
      repo: { id: 1, path: '/r' }, worktree: '/r',
      graph: { rows: [row('d2', ['d1']), row('d1', ['m'])], labels: [], worktrees: [{ path: '/r', isMain: true, inProgress: 'merge' }], head: { branch: 'refs/heads/develop', target: null, detached: false, unborn: false } },
      sidebar: { locals: [lb('develop', 'd2'), lb('feature/b', 'b1')], remotes: [{ name: 'origin', branches: [{ name: 'release', fullName: 'refs/remotes/origin/release', target: 'd2' }] }], worktrees: [], stashes: [], tags: [] },
    } as never);
  });

  it("finds a merged bottom gone locally and on the remote through the target remote's ref the poll asked about", () => {
    const merged = mrOf(1, { sourceBranch: 'feature/a', targetBranch: 'main', state: 'merged' });
    patchForge('e', { byRef: { 'refs/remotes/origin/feature/a': merged } });
    const of = branchMrs('e');
    expect(of('feature/a')).toEqual(merged);
    expect(of('nothing')).toBeNull();
  });

  it("reads the project's default branch, the local branches and their tips", () => {
    const env = stackEnvOf('e')!;
    expect([env.defaultBranch, env.locals.has('feature/b'), env.tipOf('develop'), env.tipOf('gone')]).toEqual(['main', true, 'd2', null]);
  });

  it("reads the active worktree's operation", () => {
    expect(inProgressOf('e')).toBe('merge');
  });

  it("a stack member's create bumps the write epoch, so a poll already under way drops its stale answer", async () => {
    vi.spyOn(api, 'forgeCreateMr').mockResolvedValue({ kind: 'created', mr: mrOf(7) } as never);
    const before = writeEpoch('e');
    await createMr({ tabId: 'e', repoId: 1, worktree: '/r' }, { remote: 'origin' } as never);
    expect(writeEpoch('e')).toBe(before + 1);
  });
});
