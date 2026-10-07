import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalBranch } from '../api/gen/LocalBranch';

const api = vi.hoisted(() => ({
  forgeRepoProjects: vi.fn(),
  forgeAccounts: vi.fn(),
  forgeBranchMrs: vi.fn(),
  forgeMrList: vi.fn(),
  forgeMrDetail: vi.fn(),
  forgeMrDiscussions: vi.fn(),
  forgeCachedMrs: vi.fn(),
}));
vi.mock('../api/client', () => ({ api, errorMessage: (e: unknown) => (e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e)) }));
const flyout = vi.hoisted(() => ({ openFlyout: vi.fn(), shownFlyout: vi.fn((): { kind: string; props: unknown } | null => null) }));
vi.mock('../ui/flyout/flyout', () => flyout);

const { ACTIVATE_GAP_MS, fastPollWanted, loadMrDetail, openMrView, POLL_COST, pollForge, ratePacing, refreshMr } = await import('./poll');
const { staleText } = await import('./ForgeStale');
const { dropForge, EMPTY_FORGE, forgeScratch, forgeOf, noteForgeWritten, patchForge, useForge } = await import('./mrStore');
const { backoffMs } = await import('./poller');
const { useRuntime } = await import('../app/runtime');
const { DEFAULT_SETTINGS, EMPTY_REPO_SETTINGS, useAppState } = await import('../app/state');
const { clampFetchInterval } = await import('../settings/schema');
const { detailOf, mrOf, projectOf } = await import('./testMrs');

const project = projectOf();
const target = { remote: 'origin', host: 'gitlab.example.com', path: 'group/project', account: 'gitlab', project, error: null };
const fresh = <T,>(value: T) => ({ value, notModified: false, pollIntervalSecs: null, fetchedAt: 1 });
const branch = (name: string, upstream: string | null, tipTime: number) => ({ name, fullName: `refs/heads/${name}`, upstream, tipTime, gone: false }) as LocalBranch;
const running = mrOf(5, { state: 'draft', pipeline: { status: 'running', webUrl: null } });

beforeEach(() => {
  vi.clearAllMocks();
  dropForge('t');
  useForge.setState({ byTab: {} });
  useAppState.setState({ settings: { ...DEFAULT_SETTINGS, fetchIntervalSecs: 300 } });
  useRuntime.setState({ tabs: { t: { status: 'ready', repo: { id: 4 }, sidebar: { locals: [branch('dev', 'refs/remotes/origin/dev', 5), branch('old', 'refs/remotes/origin/old', 9), branch('loose', null, 1)] } } as never } });
  api.forgeRepoProjects.mockResolvedValue({ remotes: [target], target: 'origin' });
  api.forgeAccounts.mockResolvedValue([{ account: { host: 'gitlab.example.com', user: { username: 'ada' } }, status: { kind: 'ok' } }]);
  api.forgeBranchMrs.mockResolvedValue({ kind: 'gitlab', remote: 'origin', mrs: [{ remoteRef: 'refs/remotes/origin/dev', mr: mrOf(12) }], history: [], fetchedAt: 1, pollIntervalSecs: 30 });
  api.forgeMrList.mockResolvedValue({ kind: 'gitlab', remote: 'origin', project, filter: 'all', mrs: [mrOf(12), running], fetchedAt: 1, pollIntervalSecs: null });
  api.forgeMrDetail.mockResolvedValue(fresh(detailOf(mrOf(12))));
  api.forgeMrDiscussions.mockResolvedValue(fresh([]));
  api.forgeCachedMrs.mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

describe('pollForge (spec #4 §3.4)', () => {
  it('a full poll maps the badges, the list and the open MR, and says a pipeline runs', async () => {
    patchForge('t', { openMr: 12 });
    const out = await pollForge('t', 'timer');
    expect(api.forgeRepoProjects).toHaveBeenCalledWith(4, false);
    expect(api.forgeBranchMrs).toHaveBeenCalledWith(4, ['refs/remotes/origin/old', 'refs/remotes/origin/dev']);
    const f = forgeOf('t');
    expect([f.kind, f.remote, f.me]).toEqual(['gitlab', 'origin', 'ada']);
    expect(f.byRef['refs/remotes/origin/dev']?.number).toBe(12);
    expect(f.history).toEqual({});
    expect(f.upstreams['refs/heads/dev']).toBe('refs/remotes/origin/dev');
    expect(f.list?.mrs.map((m) => m.number)).toEqual([12, 5]);
    expect([f.details[12]?.value.mr.number, f.discussions[12], f.error, f.failures]).toEqual([12, [], null, 0]);
    expect(f.updatedAt).not.toBeNull();
    expect(out).toEqual({ runningPipeline: true, serverIntervalMs: 30_000, pipelineKey: `5:${'5'.padStart(40, '0')}` });
  });

  it('after an account change the next poll asks the forges again, once', async () => {
    forgeScratch.recheck.add('t');
    await pollForge('t', 'write');
    expect(api.forgeRepoProjects).toHaveBeenLastCalledWith(4, true);
    await pollForge('t', 'write');
    expect(api.forgeRepoProjects).toHaveBeenLastCalledWith(4, false);
  });

  it('activation asks the forges for the projects again; a fast poll reads only the list and the open MR', async () => {
    await pollForge('t', 'activate');
    expect(api.forgeRepoProjects).toHaveBeenCalledWith(4, true);
    vi.clearAllMocks();
    await pollForge('t', 'fast');
    expect(api.forgeRepoProjects).not.toHaveBeenCalled();
    expect(api.forgeBranchMrs).not.toHaveBeenCalled();
    expect(api.forgeAccounts).not.toHaveBeenCalled();
    expect(api.forgeMrList).toHaveBeenCalledWith(4, 'all');
  });

  it("a target whose project can't be loaded keeps the section and says why, and doesn't fall back to another remote", async () => {
    const lost = { ...target, remote: 'origin', path: 'upstream/widget', project: null, error: 'Not found on gitlab.example.com' };
    api.forgeRepoProjects.mockResolvedValue({ remotes: [lost, { ...target, remote: 'fork' }], target: 'origin', targetChosen: true });
    const out = await pollForge('t', 'timer');
    const f = forgeOf('t');
    expect([f.kind, f.remote, f.project, f.list, f.target, f.targetChosen]).toEqual(['gitlab', 'origin', null, null, 'origin', true]);
    expect(f.error).toBe('upstream/widget: Not found on gitlab.example.com');
    expect(f.remoteErrors).toEqual({ origin: 'Not found on gitlab.example.com' });
    expect(f.failures).toBe(1);
    expect(api.forgeMrList).not.toHaveBeenCalled();
    expect(out.serverIntervalMs).toBeGreaterThan(0);
  });

  it('a repository without a forge target has no MR/PR UI', async () => {
    api.forgeRepoProjects.mockResolvedValue({ remotes: [{ ...target, account: null, project: null }], target: null });
    patchForge('t', { kind: 'gitlab', byRef: { r: mrOf(1) } });
    expect(await pollForge('t', 'timer')).toEqual({ runningPipeline: false, serverIntervalMs: null });
    expect([forgeOf('t').kind, forgeOf('t').byRef, forgeOf('t').list]).toEqual([null, {}, null]);
    expect(api.forgeBranchMrs).not.toHaveBeenCalled();
  });

  it('a failed poll keeps the data and backs off; a rate limit waits until its reset', async () => {
    await pollForge('t', 'timer');
    api.forgeMrList.mockRejectedValueOnce({ kind: 'Network', message: "Couldn't reach gitlab.example.com: timed out" });
    const out = await pollForge('t', 'timer');
    expect(forgeOf('t').error).toBe("Couldn't reach gitlab.example.com: timed out");
    expect(forgeOf('t').list?.mrs).toHaveLength(2);
    expect(forgeOf('t').byRef['refs/remotes/origin/dev']?.number).toBe(12);
    expect(out).toEqual({ runningPipeline: false, serverIntervalMs: backoffMs(clampFetchInterval(300) * 1000, 1), failed: true });
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000);
    api.forgeMrList.mockRejectedValueOnce({ kind: 'RateLimited', message: 'limited', detail: { kind: 'rateLimited', until: 1_003_600 } });
    expect((await pollForge('t', 'timer')).serverIntervalMs).toBe(3_600_000);
    expect(forgeOf('t').failures).toBe(2);
    expect(forgeOf('t').limitedUntil).toBe(1_003_600_000);
    expect(staleText(forgeOf('t'), 1_000_000_000)).toMatch(/^Rate limited until \d{1,2}:\d{2}/);
    await pollForge('t', 'timer');
    expect([forgeOf('t').error, forgeOf('t').failures, forgeOf('t').limitedUntil]).toEqual([null, 0, null]);
  });

  it('badges that fail cost only the badges: the list is still asked, and the poll says why', async () => {
    await pollForge('t', 'timer');
    api.forgeBranchMrs.mockRejectedValueOnce({ kind: 'Network', message: "Couldn't reach gitlab.example.com: timed out" });
    api.forgeMrList.mockResolvedValueOnce({ kind: 'gitlab', remote: 'origin', project, filter: 'all', mrs: [mrOf(12)], fetchedAt: 2, pollIntervalSecs: null });
    const out = await pollForge('t', 'timer');
    expect(api.forgeMrList).toHaveBeenCalledTimes(2);
    expect(forgeOf('t').list?.mrs.map((m) => m.number)).toEqual([12]);
    expect(forgeOf('t').byRef['refs/remotes/origin/dev']?.number).toBe(12);
    expect([forgeOf('t').error, forgeOf('t').failures]).toEqual(["Couldn't reach gitlab.example.com: timed out", 0]);
    expect(out.failed).toBe(true);
  });

  it('a low rate-limit budget slows the next poll; a spent one waits for its reset and says so', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000);
    const listWith = (remaining: number) => ({ kind: 'gitlab', remote: 'origin', project, filter: 'all', mrs: [mrOf(12)], fetchedAt: 1, pollIntervalSecs: null, rateLimit: { limitedUntil: null, remaining, resetAt: 1_000_600, limit: 2000 } });
    api.forgeMrList.mockResolvedValueOnce(listWith(1500));
    expect((await pollForge('t', 'timer')).serverIntervalMs).toBe(30_000);
    // 50 left of 2000 (under 10%), 10 minutes to the reset: 16 polls left, one every 36 s at least.
    api.forgeMrList.mockResolvedValueOnce(listWith(50));
    expect((await pollForge('t', 'timer')).serverIntervalMs).toBe(Math.ceil((600_000 * POLL_COST) / 50));
    api.forgeMrList.mockResolvedValueOnce(listWith(0));
    expect((await pollForge('t', 'timer')).serverIntervalMs).toBe(600_000);
    expect(forgeOf('t').limitedUntil).toBe(1_000_600_000);
    expect(staleText(forgeOf('t'), 1_000_000_000)).toMatch(/^Rate limited until \d{1,2}:\d{2}[^.]*\. Last updated/);
  });
});

describe("the last session's cache", () => {
  it("a tab with nothing yet shows the cached list and badges at once, marked stale, until the poll answers", async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000);
    const cachedList = { kind: 'gitlab', remote: 'origin', project, filter: 'all', mrs: [mrOf(7)], fetchedAt: 992_800, pollIntervalSecs: null };
    api.forgeCachedMrs.mockResolvedValue({ kind: 'gitlab', remote: 'origin', project, list: cachedList, badges: { kind: 'gitlab', remote: 'origin', mrs: [{ remoteRef: 'refs/remotes/origin/dev', mr: mrOf(7) }], history: [], fetchedAt: 992_800, pollIntervalSecs: null }, savedAt: 992_800 });
    let seen: ReturnType<typeof forgeOf> | null = null;
    api.forgeRepoProjects.mockImplementationOnce(async () => {
      seen = forgeOf('t');
      return { remotes: [target], target: 'origin' };
    });
    await pollForge('t', 'activate');
    expect(api.forgeCachedMrs).toHaveBeenCalledWith(4, ['refs/remotes/origin/old', 'refs/remotes/origin/dev'], 'all');
    // Before the first request: the cache's, two hours old.
    expect([seen!.list?.mrs[0]?.number, seen!.byRef['refs/remotes/origin/dev']?.number, seen!.cachedAt]).toEqual([7, 7, 992_800_000]);
    expect(staleText(seen!, 1_000_000_000)).toBe('Updated 2 hours ago');
    // The poll answered: fresh, no note.
    expect([forgeOf('t').list?.mrs.map((m) => m.number), forgeOf('t').cachedAt, staleText(forgeOf('t'))]).toEqual([[12, 5], null, null]);
    // Only a tab with nothing yet asks the cache.
    await pollForge('t', 'timer');
    expect(api.forgeCachedMrs).toHaveBeenCalledTimes(1);
  });
});

describe('ratePacing', () => {
  const rl = (remaining: number | null, limitedUntil: number | null = null) => ({ limitedUntil, remaining, resetAt: 2_000, limit: 1000 });
  it('asks nothing of a healthy budget, spreads a low one until the reset, and waits out a spent one', () => {
    expect(ratePacing(undefined, 1_000_000)).toEqual({ floorMs: 0, limitedUntil: null });
    expect(ratePacing(rl(500), 1_000_000)).toEqual({ floorMs: 0, limitedUntil: null });
    expect(ratePacing(rl(30), 1_000_000)).toEqual({ floorMs: Math.ceil((1_000_000 * POLL_COST) / 30), limitedUntil: null });
    expect(ratePacing(rl(0), 1_000_000)).toEqual({ floorMs: 1_000_000, limitedUntil: 2_000_000 });
    expect(ratePacing(rl(900, 1_500), 1_000_000)).toEqual({ floorMs: 500_000, limitedUntil: 1_500_000 });
    expect(ratePacing(rl(0), 2_000_001), 'past the reset').toEqual({ floorMs: 0, limitedUntil: null });
  });
});

describe('a poll that finds nothing new', () => {
  it("keeps every project's owner picture, the target's too, and none for a project without one", async () => {
    const pic = (owner: string) => `https://gitlab.example.com/uploads/${owner}.png`;
    const alice = { ...target, remote: 'alice', path: 'alice/project', project: { ...projectOf('alice/project'), forkOf: 'group/project', ownerAvatarUrl: pic('alice') } };
    const team = { ...target, remote: 'team', path: 'team/project', project: { ...projectOf('team/project'), ownerAvatarUrl: null } };
    const own = { ...target, project: { ...project, ownerAvatarUrl: pic('group') } };
    api.forgeRepoProjects.mockResolvedValue({ remotes: [own, alice, team], target: 'origin' });
    await pollForge('t', 'timer');
    expect(forgeOf('t').ownerAvatars).toEqual({ origin: pic('group'), alice: pic('alice') });
  });

  it("keeps a moved-on merged MR out of the badges, in the stacks' history", async () => {
    const merged = mrOf(9, { state: 'merged' });
    api.forgeBranchMrs.mockResolvedValue({ kind: 'gitlab', remote: 'origin', mrs: [], history: [{ remoteRef: 'refs/remotes/origin/old', mr: merged }], fetchedAt: 1, pollIntervalSecs: 30 });
    await pollForge('t', 'timer');
    expect([forgeOf('t').byRef, forgeOf('t').history['refs/remotes/origin/old']?.number]).toEqual([{}, 9]);
  });

  it('keeps the identities of byRef, list and details', async () => {
    patchForge('t', { openMr: 12 });
    await pollForge('t', 'timer');
    const a = forgeOf('t');
    api.forgeBranchMrs.mockResolvedValue({ kind: 'gitlab', remote: 'origin', mrs: [{ remoteRef: 'refs/remotes/origin/dev', mr: mrOf(12) }], history: [], fetchedAt: 2, pollIntervalSecs: 30 });
    api.forgeMrList.mockResolvedValue({ kind: 'gitlab', remote: 'origin', project, filter: 'all', mrs: [mrOf(12), running], fetchedAt: 2, pollIntervalSecs: null });
    api.forgeMrDetail.mockResolvedValue(fresh(detailOf(mrOf(12))));
    await pollForge('t', 'timer');
    const b = forgeOf('t');
    expect(b.byRef).toBe(a.byRef);
    expect(b.upstreams).toBe(a.upstreams);
    expect(b.list).toBe(a.list);
    expect(b.details).toBe(a.details);
    expect(b.discussions).toBe(a.discussions);
  });

  it('a failing open MR does not fail the poll', async () => {
    patchForge('t', { openMr: 12 });
    api.forgeMrDetail.mockRejectedValue({ message: 'gone' });
    await pollForge('t', 'timer');
    expect([forgeOf('t').error, forgeOf('t').detailErrors[12], forgeOf('t').list?.mrs.length]).toEqual([null, 'gone', 2]);
  });

  it('a dropped tab keeps nothing, and a late result is ignored', async () => {
    await pollForge('t', 'timer');
    dropForge('t');
    expect(useForge.getState().byTab.t).toBeUndefined();
    useRuntime.setState({ tabs: {} });
    await pollForge('t', 'timer');
    expect(useForge.getState().byTab.t).toBeUndefined();
  });
});

describe('opening and loading an MR/PR', () => {
  it('openMrView on the MR already open keeps the view as it is (no remount, no reload)', () => {
    flyout.openFlyout.mockClear();
    flyout.shownFlyout.mockReturnValueOnce({ kind: 'mr', props: { number: 12 } });
    openMrView('t', 12);
    expect(flyout.openFlyout).not.toHaveBeenCalled();
    flyout.shownFlyout.mockReturnValueOnce({ kind: 'mr', props: { number: 12 } });
    openMrView('t', 13);
    expect(flyout.openFlyout).toHaveBeenCalledWith('t', 'mr', { number: 13 });
  });

  it('openMrView opens the flyout; the view loads the MR as it mounts, not openMrView too', () => {
    openMrView('t', 12);
    expect(flyout.openFlyout).toHaveBeenCalledWith('t', 'mr', { number: 12 });
    expect(forgeOf('t').openMr).toBe(12);
    expect(api.forgeMrDetail).not.toHaveBeenCalled();
  });

  it('a detail answered not modified is still stored when it differs (a composite: its checks changed)', async () => {
    await refreshMr('t', 12);
    const checked = detailOf(mrOf(12, { pipeline: { status: 'failed', webUrl: null } }));
    api.forgeMrDetail.mockResolvedValueOnce({ ...fresh(checked), notModified: true });
    api.forgeMrDiscussions.mockResolvedValueOnce({ ...fresh([{ id: 'd1', notes: [], resolvable: false, resolved: false }]), notModified: true });
    await refreshMr('t', 12);
    expect(forgeOf('t').details[12]?.value.mr.pipeline?.status).toBe('failed');
    expect(forgeOf('t').discussions[12]).toHaveLength(1);
  });

  it("a failed load is kept for the card and the view to say", async () => {
    api.forgeMrDetail.mockRejectedValueOnce({ message: 'Not found on gitlab.example.com' });
    await expect(refreshMr('t', 12)).rejects.toBeTruthy();
    expect(forgeOf('t').detailErrors[12]).toBe('Not found on gitlab.example.com');
  });

  it('a failed hover load is not asked again within the window', async () => {
    api.forgeMrDetail.mockRejectedValue({ message: 'nope' });
    await loadMrDetail('t', 12);
    await loadMrDetail('t', 12);
    expect(api.forgeMrDetail).toHaveBeenCalledTimes(1);
  });

  it('loads a detail once while it runs, and not again while it is fresh', async () => {
    await Promise.all([loadMrDetail('t', 12), loadMrDetail('t', 12)]);
    expect(api.forgeMrDetail).toHaveBeenCalledTimes(1);
    await loadMrDetail('t', 12);
    expect(api.forgeMrDetail).toHaveBeenCalledTimes(1);
    await loadMrDetail('t', 12, 0);
    expect(api.forgeMrDetail).toHaveBeenCalledTimes(2);
  });
});

// --- 4B final fix ---
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
const listOf = (filter: string, mrs = [mrOf(12)]) => ({ kind: 'gitlab', remote: 'origin', project, filter, mrs, fetchedAt: 1, pollIntervalSecs: null });

describe('polls and what changes meanwhile', () => {
  it("a filter chosen during a poll keeps its own list, not the old filter's", async () => {
    const late = deferred<unknown>();
    api.forgeMrList.mockReturnValueOnce(late.promise);
    const p = pollForge('t', 'timer');
    await vi.waitFor(() => expect(api.forgeMrList).toHaveBeenCalledWith(4, 'all'));
    patchForge('t', { filter: 'mine', list: listOf('mine', [mrOf(5)]) as never });
    late.resolve(listOf('all'));
    await p;
    expect([forgeOf('t').list?.filter, forgeOf('t').list?.mrs.map((m) => m.number)]).toEqual(['mine', [5]]);
  });

  it("a poll's answers that started before a write's answer are dropped", async () => {
    const late = deferred<unknown>();
    api.forgeMrList.mockReturnValueOnce(late.promise);
    const p = pollForge('t', 'timer');
    await vi.waitFor(() => expect(api.forgeMrList).toHaveBeenCalled());
    const merged = mrOf(12, { state: 'merged' });
    patchForge('t', { list: listOf('all', [merged]) as never }); // the write's answer (putMr)
    noteForgeWritten('t');
    late.resolve(listOf('all'));
    await p;
    expect(forgeOf('t').list?.mrs[0]?.state).toBe('merged');
    await pollForge('t', 'timer'); // the write's own poll
    expect(forgeOf('t').list?.mrs[0]?.state).toBe('open');
  });

  it('refreshMr drops a detail that started before a write', async () => {
    const late = deferred<unknown>();
    api.forgeMrDetail.mockReturnValueOnce(late.promise);
    const p = refreshMr('t', 12);
    noteForgeWritten('t');
    late.resolve(fresh(detailOf(mrOf(12))));
    await p;
    expect(forgeOf('t').details[12]).toBeUndefined();
  });

  it('one poll per tab at a time: a second poller joins it; a write runs after it', async () => {
    const late = deferred<unknown>();
    api.forgeMrList.mockReturnValueOnce(late.promise);
    const a = pollForge('t', 'timer');
    const b = pollForge('t', 'activate');
    const w = pollForge('t', 'write');
    await vi.waitFor(() => expect(api.forgeMrList).toHaveBeenCalledTimes(1));
    late.resolve(listOf('all'));
    expect(await b).toBe(await a);
    await w;
    expect(api.forgeMrList).toHaveBeenCalledTimes(2);
  });

  it('activation polls fully at most every ACTIVATE_GAP_MS per tab, across pollers', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await pollForge('t', 'activate');
    vi.clearAllMocks();
    now.mockReturnValue(1_000_000 + ACTIVATE_GAP_MS - 1);
    await pollForge('t', 'activate');
    expect(api.forgeRepoProjects).not.toHaveBeenCalled();
    expect(api.forgeMrList).not.toHaveBeenCalled();
    now.mockReturnValue(1_000_000 + ACTIVATE_GAP_MS);
    await pollForge('t', 'activate');
    expect(api.forgeRepoProjects).toHaveBeenCalledWith(4, true);
  });
});

describe('fastPollWanted (spec #4 §3.4: a visible running pipeline)', () => {
  const pipe = (status: 'running' | 'pending' | 'success') => ({ pipeline: { status, webUrl: null } });
  const list = (mrs: ReturnType<typeof mrOf>[]) => listOf('all', mrs) as never;
  it('counts a running list row only while the section is expanded', () => {
    const f = { ...EMPTY_FORGE, list: list([mrOf(1, pipe('running'))]) };
    expect(fastPollWanted(f, true)).toBe(true);
    expect(fastPollWanted(f, false)).toBe(false);
  });
  it('a pending pipeline does not count', () => {
    expect(fastPollWanted({ ...EMPTY_FORGE, list: list([mrOf(1, pipe('pending'))]) }, true)).toBe(false);
  });
  it("counts the open MR's running pipeline, from its detail or the list", () => {
    expect(fastPollWanted({ ...EMPTY_FORGE, openMr: 2, details: { 2: { value: detailOf(mrOf(2, pipe('running'))), at: 1 } } }, false)).toBe(true);
    expect(fastPollWanted({ ...EMPTY_FORGE, openMr: 1, list: list([mrOf(1, pipe('running'))]) }, false)).toBe(true);
    expect(fastPollWanted({ ...EMPTY_FORGE, openMr: 2, list: list([mrOf(1, pipe('running')), mrOf(2, pipe('success'))]) }, false)).toBe(false);
  });
  it('counts an open MR the forge is merging (GitLab locks it for moments), until it leaves that state', () => {
    expect(fastPollWanted({ ...EMPTY_FORGE, openMr: 2, details: { 2: { value: detailOf(mrOf(2, { state: 'merging' })), at: 1 } } }, false)).toBe(true);
    expect(fastPollWanted({ ...EMPTY_FORGE, openMr: 2, details: { 2: { value: detailOf(mrOf(2, { state: 'merged' })), at: 1 } } }, false)).toBe(false);
  });
  it('a poll reads the collapsed MR/PR section from the repository settings', async () => {
    useRuntime.setState({ tabs: { t: { status: 'ready', repo: { id: 4, path: '/r' }, sidebar: { locals: [] } } as never } });
    useAppState.setState((s) => ({ profile: { ...s.profile, repos: { '/r': { ...EMPTY_REPO_SETTINGS, collapsed: ['section:mrs'] } } } }));
    expect((await pollForge('t', 'timer')).runningPipeline).toBe(false);
    useAppState.setState((s) => ({ profile: { ...s.profile, repos: {} } }));
    expect((await pollForge('t', 'timer')).runningPipeline).toBe(true);
  });
});
// --- end 4B final fix ---
