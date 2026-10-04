import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./CreateMrFlyout', () => ({ CreateMrFlyout: () => null }));
const head = vi.hoisted(() => ({ branch: 'feature/login' as string | null }));
vi.mock('../../sync/push', async (orig) => ({ ...(await orig<typeof import('../../sync/push')>()), headBranchOf: () => head.branch }));

const { buildMenu } = await import('../../menu/registry');
const { getAction } = await import('../../app/actions');
const { pushHooks } = await import('../../sync/push');
const { useRuntime } = await import('../../app/runtime');
const { EMPTY_PROFILE, useAppState } = await import('../../app/state');
const { closeFlyout, flyoutOf } = await import('../../ui/flyout/flyout');
const { EMPTY_FORGE, patchForge, useForge } = await import('../mrStore');
await import('./feature');

const project = (kind: 'gitlab' | 'github') => ({
  kind, id: 42, host: kind === 'gitlab' ? 'gitlab.example.com' : 'github.com', path: 'group/project', name: 'project', owner: 'group', webUrl: 'w',
  defaultBranch: 'main', cloneHttps: '', cloneSsh: '', forkOf: null, updatedAt: null, archived: false,
});
function seed(kind: 'gitlab' | 'github' = 'gitlab', mapped = true) {
  const p = project(kind);
  useForge.setState({ byTab: { t1: { ...EMPTY_FORGE } } });
  if (mapped) patchForge('t1', { kind, remote: 'origin', project: p, mapped: ['origin', 'fork'] });
  useRuntime.setState({ tabs: { t1: { status: 'ready', repo: { id: 7, name: 'shop', path: '/r/shop' } } } } as never);
  useAppState.setState({ profile: { ...EMPTY_PROFILE, tabs: [{ id: 't1' }], activeTab: 't1' } as never });
  closeFlyout('t1');
}
const target = (name: string) => ({ sha: 'a'.repeat(40), mrRefs: [], isWip: false, isStash: false, branch: { name, local: `refs/heads/${name}`, remotes: [] } });
const env = { write: { tabId: 't1', repoId: 7, worktree: '/r/shop' } } as never;
const rowOf = (name: string) => buildMenu('commit', target(name), env).find((r) => r.kind === 'action' && r.id === 'forge.createMr') as { label: string; tooltip: string; run(): void } | undefined;

beforeEach(() => { head.branch = 'feature/login'; });

describe('Create MR/PR entry points (spec #4 §4 "4C")', () => {
  it("branch menus name the forge's noun for a branch that isn't the default, and open the flyout", () => {
    seed();
    const row = rowOf('feature/login');
    expect(row).toMatchObject({ label: 'Create merge request…', tooltip: 'Create a merge request from feature/login on GitLab' });
    row!.run();
    expect(flyoutOf('t1')).toMatchObject({ kind: 'createMr', props: { branch: 'feature/login' } });
    expect(rowOf('main')).toBeUndefined();
    seed('github');
    expect(rowOf('feature/login')).toMatchObject({ label: 'Create pull request…', tooltip: 'Create a pull request from feature/login on GitHub' });
  });

  it('without a forge project there is no row, no palette action and no toast link', () => {
    seed('gitlab', false);
    expect(rowOf('feature/login')).toBeUndefined();
    expect(getAction('forge.createMr')!.when!()).toBe(false);
    expect(pushHooks.afterNewBranch!('t1', 'feature/login', 'origin')).toBeNull();
  });

  it('a branch that already has an open MR gets no Create row (4B offers Open instead); a merged one does', () => {
    seed();
    const mr = { number: 5, state: 'open', sourceBranch: 'feature/login' } as never;
    patchForge('t1', { byRef: { 'refs/remotes/origin/feature/login': mr }, upstreams: { 'refs/heads/feature/login': 'refs/remotes/origin/feature/login' } });
    expect(rowOf('feature/login')).toBeUndefined();
    expect(pushHooks.afterNewBranch!('t1', 'feature/login', 'origin')).toBeNull();
    patchForge('t1', { byRef: { 'refs/remotes/origin/feature/login': { ...(mr as object), state: 'merged' } as never } });
    expect(rowOf('feature/login')).toBeDefined();
  });

  it("another project's open MR from a branch of the same name doesn't hide Create; the branch's own (through its remote ref) does", () => {
    seed();
    const fork = { number: 9, state: 'open', sourceBranch: 'feature/login', sourceProject: 'someone/project' } as never;
    patchForge('t1', { byRef: { 'refs/remotes/fork/feature/login': fork }, list: { mrs: [fork] } as never });
    expect(rowOf('feature/login')).toBeDefined();
    expect(getAction('forge.createMr')!.when!()).toBe(true);
    expect(pushHooks.afterNewBranch!('t1', 'feature/login', 'origin')).not.toBeNull();
    const own = { number: 5, state: 'draft', sourceBranch: 'feature/login' } as never;
    patchForge('t1', { byRef: { 'refs/remotes/origin/feature/login': own } });
    const withRemote = { ...target('feature/login'), branch: { name: 'feature/login', local: 'refs/heads/feature/login', remotes: [{ fullName: 'refs/remotes/origin/feature/login' }] } };
    expect(buildMenu('commit', withRemote as never, env).some((r) => r.kind === 'action' && r.id === 'forge.createMr')).toBe(false);
  });

  it("the push toast's link shows only for a push to a remote on the target's forge", () => {
    seed();
    expect(pushHooks.afterNewBranch!('t1', 'feature/login', 'fork')).not.toBeNull();
    expect(pushHooks.afterNewBranch!('t1', 'feature/login', 'mirror')).toBeNull();
  });

  it('the palette action (Ctrl+P) follows HEAD', () => {
    seed();
    const a = getAction('forge.createMr')!;
    expect([a.label, a.group, a.when!()]).toEqual(['Create MR/PR…', 'Repository', true]);
    void a.run();
    expect(flyoutOf('t1')).toMatchObject({ kind: 'createMr', props: { branch: 'feature/login' } });
    head.branch = 'main';
    expect(a.when!()).toBe(false);
    head.branch = null;
    expect(a.when!()).toBe(false);
  });

  it('the push toast links "Create MR" for a branch the push created', () => {
    seed();
    const link = pushHooks.afterNewBranch!('t1', 'feature/login', 'origin');
    expect(link?.label).toBe('Create MR');
    link!.run();
    expect(flyoutOf('t1')).toMatchObject({ kind: 'createMr', props: { branch: 'feature/login' } });
    expect(pushHooks.afterNewBranch!('t1', 'main', 'origin')).toBeNull();
    seed('github');
    expect(pushHooks.afterNewBranch!('t1', 'feature/login', 'origin')?.label).toBe('Create PR');
  });
});
