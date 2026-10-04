import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ forgeProjectByPath: vi.fn() }));
vi.mock('../../api/client', () => ({ api, errorMessage: (e: unknown) => String((e as { message?: string })?.message ?? e) }));
const branches = vi.hoisted(() => ({ checkoutLocal: vi.fn(), checkoutRemote: vi.fn() }));
vi.mock('../../branches/checkout', () => branches);
const remotes = vi.hoisted(() => ({ addForkRemote: vi.fn() }));
vi.mock('../../remotes/addRemote', () => remotes);
const fetching = vi.hoisted(() => ({ runFetch: vi.fn(async () => {}) }));
vi.mock('../../app/fetchSchedule', () => fetching);

const { checkoutMr, checkoutState } = await import('./checkout');
const { patchForge, useForge } = await import('../mrStore');
const { useRuntime } = await import('../../app/runtime');
const { useToast } = await import('../../ui/toast');
const { mrOf, projectOf } = await import('../testMrs');

const DEV = 'd'.repeat(40);
const FIX = 'f'.repeat(40);
type Group = { name: string; branches: Array<{ name: string; fullName: string; target: string }> };
const group = (name: string, branch?: [string, string]): Group => ({ name, branches: branch ? [{ name: branch[0], fullName: `refs/remotes/${name}/${branch[0]}`, target: branch[1] }] : [] });
function tab(sidebar: { locals?: Array<{ name: string; upstream: string | null; isHead?: boolean }>; remotes?: Group[] }, refreshTo?: { remotes: Group[] }) {
  const info = { remotes: [{ name: 'origin', url: 'https://gitlab.example.com/group/project.git', host: 'gitlab.example.com', path: 'group/project', hostKind: 'gitlab' }] };
  useRuntime.setState({
    tabs: { t: { repo: { id: 4 }, info, sidebar: { locals: sidebar.locals ?? [], remotes: sidebar.remotes ?? [], worktrees: [], stashes: [], tags: [] } } as never },
    refresh: vi.fn(async () => {
      if (!refreshTo) return;
      const cur = useRuntime.getState().tabs.t as never as { sidebar: object; info: typeof info };
      useRuntime.setState({ tabs: { t: { ...cur, sidebar: { ...cur.sidebar, remotes: refreshTo.remotes }, info: { remotes: [...info.remotes, { name: 'alice', url: 'x', host: 'gitlab.example.com', path: 'alice/project', hostKind: 'gitlab' }] } } as never } });
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useForge.setState({ byTab: {} });
  patchForge('t', { kind: 'gitlab', remote: 'origin', project: projectOf() });
  useToast.getState().dismiss();
});

describe("checking out an MR/PR's branch (spec #4 §4 \"4B\")", () => {
  it('a local branch that already tracks the source is checked out', async () => {
    tab({ locals: [{ name: 'dev', upstream: 'refs/remotes/origin/dev' }] });
    await checkoutMr('t', mrOf(12));
    expect(branches.checkoutLocal).toHaveBeenCalledWith('t', 'dev');
  });

  it('a fetched source branch is checked out as a new local branch', async () => {
    tab({ remotes: [group('origin', ['dev', DEV])] });
    await checkoutMr('t', mrOf(12));
    expect(branches.checkoutRemote).toHaveBeenCalledWith('t', 'origin', 'dev', DEV);
    expect(fetching.runFetch).not.toHaveBeenCalled();
  });

  it('a source branch not fetched yet is fetched first', async () => {
    tab({ remotes: [group('origin')] }, { remotes: [group('origin', ['dev', DEV])] });
    await checkoutMr('t', mrOf(12));
    expect(fetching.runFetch).toHaveBeenCalledWith('t', false, 'origin');
    expect(branches.checkoutRemote).toHaveBeenCalledWith('t', 'origin', 'dev', DEV);
  });

  it("checks out an MR from a fork that isn't a remote yet by adding it first", async () => {
    const fork = projectOf('alice/project');
    api.forgeProjectByPath.mockResolvedValue(fork);
    remotes.addForkRemote.mockResolvedValue('alice');
    tab({ remotes: [group('origin')] }, { remotes: [group('origin'), group('alice', ['fix', FIX])] });
    const mr = mrOf(14, { sourceProject: 'alice/project', sourceBranch: 'fix' });
    expect(checkoutState('t', mr)).toEqual({ label: "Add alice's fork and check out", disabled: null });
    await checkoutMr('t', mr);
    expect(api.forgeProjectByPath).toHaveBeenCalledWith(4, 'alice/project');
    expect(remotes.addForkRemote).toHaveBeenCalledWith('t', fork);
    expect(branches.checkoutRemote).toHaveBeenCalledWith('t', 'alice', 'fix', FIX);
  });

  it("says so when the branch is gone from the remote", async () => {
    tab({ remotes: [group('origin')] }, { remotes: [group('origin')] });
    await checkoutMr('t', mrOf(12));
    expect(useToast.getState().message).toBe("origin/dev isn't on the remote any more");
    expect(branches.checkoutRemote).not.toHaveBeenCalled();
  });

  it('is "Checked out" while HEAD tracks the source branch', () => {
    tab({ locals: [{ name: 'dev', upstream: 'refs/remotes/origin/dev', isHead: true }] });
    expect(checkoutState('t', mrOf(12))).toEqual({ label: 'Checked out', disabled: 'dev is checked out' });
    tab({ locals: [] });
    expect(checkoutState('t', mrOf(12))).toEqual({ label: 'Check out', disabled: null });
  });

  it('never moves a same-named local branch that tracks another remote: uses <remote>-<branch>', async () => {
    tab({ locals: [{ name: 'dev', upstream: 'refs/remotes/other/dev' }], remotes: [group('origin', ['dev', DEV])] });
    await checkoutMr('t', mrOf(12));
    expect(branches.checkoutRemote).toHaveBeenCalledWith('t', 'origin', 'dev', DEV, 'origin-dev');
  });

  it('switches to <remote>-<branch> when it already tracks the source', async () => {
    tab({ locals: [{ name: 'dev', upstream: 'refs/remotes/other/dev' }, { name: 'origin-dev', upstream: 'refs/remotes/origin/dev' }], remotes: [group('origin', ['dev', DEV])] });
    await checkoutMr('t', mrOf(12));
    expect(branches.checkoutLocal).toHaveBeenCalledWith('t', 'origin-dev');
  });
});
