import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeProject } from '../api/gen/ForgeProject';

const api = vi.hoisted(() => ({ addRemote: vi.fn(async () => ({ outcome: null, journal: {}, staging: {}, wip: null })) }));
const runFetch = vi.hoisted(() => vi.fn(async () => {}));
const toast = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({ api }));
vi.mock('../app/fetchSchedule', () => ({ runFetch }));
vi.mock('../ui/toast', () => ({ useToast: { getState: () => ({ show: toast }) } }));
vi.mock('../write/ctx', () => ({ writeCtx: (tabId: string) => ({ tabId, repoId: 7, worktree: '/r/shop' }) }));
vi.mock('../write/client', () => ({
  runWrite: vi.fn(async (_ctx: unknown, send: () => Promise<{ outcome: unknown }>, opts: { onSuccess?: (o: unknown) => void } = {}) => {
    const r = await send();
    opts.onSuccess?.(r.outcome);
    return r.outcome;
  }),
}));

const { addForkRemote, addRemoteAndFetch } = await import('./addRemote');
const { hostName } = await import('./match');
const { useRuntime } = await import('../app/runtime');

const fork: ForgeProject = {
  kind: 'gitlab', id: 77, host: 'gitlab.example.com', path: 'alice/project', name: 'project', owner: 'alice', webUrl: 'w',
  defaultBranch: 'main', cloneHttps: 'https://gitlab.example.com/alice/project.git', cloneSsh: 'git@gitlab.example.com:alice/project.git', forkOf: 'group/project', updatedAt: 1, archived: false,
};
const setRemotes = (remotes: Array<{ name: string; url: string; host: string | null; path: string | null }>) =>
  useRuntime.setState({ tabs: { t1: { status: 'ready', repo: { id: 7 }, info: { remotes: remotes.map((r) => ({ ...r, hostKind: 'gitlab' })) } } } as never });

beforeEach(() => vi.clearAllMocks());

describe('adding remotes', () => {
  it('adds, says so, and fetches only the new remote', async () => {
    expect(await addRemoteAndFetch('t1', 'bob', '/srv/bob.git')).toBe(true);
    expect(api.addRemote).toHaveBeenCalledWith(7, '/r/shop', 'bob', '/srv/bob.git');
    expect(toast).toHaveBeenCalledWith('Added remote bob');
    expect(runFetch).toHaveBeenCalledWith('t1', false, 'bob');
  });

  it("a fork is named after its owner, over origin's scheme", async () => {
    setRemotes([{ name: 'origin', url: 'git@gitlab.example.com:group/project.git', host: 'gitlab.example.com', path: 'group/project' }, { name: 'alice', url: 'x', host: 'other.example', path: 'x/y' }]);
    expect(await addForkRemote('t1', fork)).toBe('alice-2');
    expect(api.addRemote).toHaveBeenCalledWith(7, '/r/shop', 'alice-2', 'git@gitlab.example.com:alice/project.git');
    expect(toast).toHaveBeenCalledWith("Added alice's fork as alice-2");
  });

  it("with no origin, the remote on the fork's parent project picks the scheme", async () => {
    setRemotes([{ name: 'up', url: 'x', host: 'h', path: 'z' }, { name: 'main', url: 'git@gitlab.example.com:Group/Project.git', host: 'gitlab.example.com', path: 'Group/Project' }]);
    await addForkRemote('t1', fork);
    expect(api.addRemote).toHaveBeenCalledWith(7, '/r/shop', 'alice', 'git@gitlab.example.com:alice/project.git');
  });

  it('a fork that is already a remote is reused, not added again', async () => {
    setRemotes([{ name: 'upstream-alice', url: 'u', host: 'gitlab.example.com', path: 'alice/project' }]);
    expect(await addForkRemote('t1', fork)).toBe('upstream-alice');
    expect(api.addRemote).not.toHaveBeenCalled();
  });

  it.each([['https://h:8443/o/p.git'], ['git@h:o/p.git']])('a fork on a ported host counts as added when a remote reaches it at %s', async (url) => {
    setRemotes([{ name: 'o', url, host: 'h', path: 'o/p' }]);
    expect(await addForkRemote('t1', { ...fork, host: 'h:8443', path: 'O/p' })).toBe('o');
    expect(api.addRemote).not.toHaveBeenCalled();
  });

  it('hostName drops the port and the case', () => {
    expect(hostName('H:8443')).toBe('h');
    expect(hostName('gitlab.example.com')).toBe('gitlab.example.com');
    expect(hostName(null)).toBe('');
  });
});
