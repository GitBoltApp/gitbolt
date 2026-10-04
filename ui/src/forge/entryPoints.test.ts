import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefLabel } from '../api/gen/RefLabel';
import type { CommitTarget, MenuEnv } from '../menu/menuEnv';

const poll = vi.hoisted(() => ({ openMrView: vi.fn() }));
vi.mock('./poll', () => poll);

await import('./entryPoints');
const { buildMenu } = await import('../menu/registry');
const { getAction } = await import('../app/actions');
const { patchForge, useForge } = await import('./mrStore');
const { useRuntime } = await import('../app/runtime');
const { EMPTY_PROFILE, useAppState } = await import('../app/state');
const { mrOf } = await import('./testMrs');

const SHA = 'a'.repeat(40);
const origin = { fullName: 'refs/remotes/origin/dev', remote: 'origin' };
const env = (labels: RefLabel[] = []) => ({ write: { tabId: 't', repoId: 4, worktree: '/r' }, labelsAt: () => labels }) as unknown as MenuEnv;
const target = (over: Partial<CommitTarget> = {}): CommitTarget => ({ sha: SHA, mrRefs: [], isWip: false, isStash: false, branch: { name: 'dev', local: 'refs/heads/dev', remotes: [origin] }, ...over });
const rowsOf = (t: CommitTarget, e = env()) => buildMenu<CommitTarget, MenuEnv>('commit', t, e).filter((r) => r.kind === 'action');

beforeEach(() => {
  vi.clearAllMocks();
  useForge.setState({ byTab: {} });
  patchForge('t', { kind: 'gitlab', byRef: { 'refs/remotes/origin/dev': mrOf(12, { title: 'Dev work' }) } });
});

describe('Open MR/PR rows (spec #4 §4 "4B")', () => {
  it("a branch's menu opens its MR in the view", () => {
    const [row] = rowsOf(target());
    expect(row).toMatchObject({ id: 'commit.openMr.12', label: 'Open MR !12', tooltip: 'Show merge request !12 (Dev work) in GitBolt' });
    if (row?.kind === 'action') row.run();
    expect(poll.openMrView).toHaveBeenCalledWith('t', 12);
  });

  it("a branch whose only link is its upstream (a sidebar Local row) finds it too", () => {
    patchForge('t', { byRef: { 'refs/remotes/origin/old': mrOf(9, { state: 'merged' }) }, upstreams: { 'refs/heads/old': 'refs/remotes/origin/old' } });
    expect(rowsOf(target({ branch: { name: 'old', local: 'refs/heads/old', remotes: [] } })).map((r) => r.kind === 'action' && r.label)).toEqual(['Open MR !9']);
  });

  it("a plain commit row offers its branches' MRs (the branch's last commit), not its tags'", () => {
    const dev = { row: 0, name: 'dev', local: 'refs/heads/dev', tag: false, isHead: false, worktree: null, checkedOut: null, remotes: [{ ...origin, host: null, hostKind: 'gitlab' }] } as RefLabel;
    const tag = { ...dev, name: 'v1', local: null, tag: true, remotes: [] } as RefLabel;
    expect(rowsOf(target({ branch: null }), env([dev, tag])).map((r) => r.kind === 'action' && r.label)).toEqual(['Open MR !12']);
  });

  it('nothing on WIP and stash rows, nor without a forge target; PRs on GitHub', () => {
    expect(rowsOf(target({ isWip: true }))).toEqual([]);
    expect(rowsOf(target({ isStash: true }))).toEqual([]);
    patchForge('t', { kind: 'github' });
    expect(rowsOf(target()).map((r) => r.kind === 'action' && r.label)).toEqual(['Open PR #12']);
    patchForge('t', { kind: null });
    expect(rowsOf(target())).toEqual([]);
  });
});

describe('the palette action', () => {
  it("opens the current branch's MR/PR, and is offered only when it has one", () => {
    const a = getAction('forge.openMr')!;
    expect(a.label).toBe('Open MR/PR for the current branch');
    useAppState.setState({ profile: { ...EMPTY_PROFILE, tabs: [{ id: 't', kind: 'repo', path: '/r', alias: null }], activeTab: 't' } });
    useRuntime.setState({ tabs: { t: { sidebar: { locals: [{ name: 'dev', fullName: 'refs/heads/dev', upstream: 'refs/remotes/origin/dev', isHead: true }] } } as never } });
    expect(a.when?.()).toBe(true);
    void a.run();
    expect(poll.openMrView).toHaveBeenCalledWith('t', 12);
    useRuntime.setState({ tabs: { t: { sidebar: { locals: [{ name: 'main', fullName: 'refs/heads/main', upstream: 'refs/remotes/origin/main', isHead: true }] } } as never } });
    expect(a.when?.()).toBe(false);
  });
});
