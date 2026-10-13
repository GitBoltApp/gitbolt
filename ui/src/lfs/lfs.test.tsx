import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { LfsSide } from '../api/gen/LfsSide';
import type { LfsStatusPayload } from '../api/gen/LfsStatusPayload';
import type { MenuRow } from '../menu/types';

const api = vi.hoisted(() => ({
  lfsStatus: vi.fn(async (_repo: number) => ({ used: true, version: '3.4.1', installUrl: 'https://git-lfs.com', filter: true, patterns: ['*.psd'] }) as LfsStatusPayload),
  lfsTracked: vi.fn(async (_repo: number, _wt: string, paths: string[]) => paths.filter((p) => p.endsWith('.psd'))),
  lfsDownload: vi.fn(async () => ({ outcome: { missing: [] as string[] } })),
  lfsPull: vi.fn(async () => ({ outcome: { missing: [] } })),
  lfsFetch: vi.fn(async () => ({ outcome: { missing: [] } })),
  lfsTrack: vi.fn(async () => ({ outcome: null })),
  lfsUntrack: vi.fn(async () => ({ outcome: null })),
  openUrl: vi.fn(async () => null),
}));
vi.mock('../api/client', () => ({ api, errorMessage: String, onEvent: () => () => {} }));
const runWrite = vi.hoisted(() => vi.fn(async (_ctx: unknown, send: () => Promise<{ outcome: unknown }>, opts?: { onSuccess?: (o: unknown) => unknown }) => {
  const { outcome } = await send();
  await opts?.onSuccess?.(outcome);
  return outcome;
}));
vi.mock('../write/client', () => ({ runWrite }));
const show = vi.hoisted(() => vi.fn());
vi.mock('../ui/toastStore', () => ({ useToast: { getState: () => ({ show }) } }));
const tab = vi.hoisted(() => ({ current: { id: 't1', kind: 'repo' } as { id: string; kind: string } | null }));
vi.mock('../app/actions', async (orig) => ({ ...(await orig<typeof import('../app/actions')>()), activeTab: () => tab.current }));

const { RepoContext } = await import('../app/repoContext');
const { createRepoViewStore, RepoViewContext, targetFor } = await import('../repo/store');
const { fakeServices } = await import('../repo/testServices');
const { useRuntime } = await import('../app/runtime');
const { EMPTY_PROFILE, useAppState } = await import('../app/state');
const { getAction } = await import('../app/actions');
const { buildMenu } = await import('../menu/registry');
const { useLfs, lfsDownloaded, onLfsEvent, onLfsFocus, REFRESH_MS } = await import('./store');
const { LfsMark } = await import('./LfsMark');
const { LfsNotice } = await import('./LfsNotice');
const { LfsPlaceholder, lfsMissing } = await import('./LfsPlaceholder');
const { extPattern } = await import('./feature');

const A = 'a'.repeat(40);
const P = 'b'.repeat(40);
const OID = 'c'.repeat(64);
const graph = { rows: [{ id: A, kind: 'commit', lane: 0, color: 0, segments: [], summary: 's', bodyFirstLine: '', authorName: 'A', authorEmail: 'a@x', authorTime: 0, committerTime: 0, parents: [P], mrRefs: [], wip: null }], labels: [], maxLanes: 1, pinnedRefs: [], head: { branch: 'refs/heads/main', target: A, detached: false, unborn: false }, truncated: false, worktrees: [] } as unknown as GraphPayload;
const file = { path: 'art/logo.psd', oldPath: null, status: 'M', additions: null, deletions: null, old: { kind: 'object' as const, oid: 'o'.repeat(40) }, new: { kind: 'object' as const, oid: 'n'.repeat(40) }, submodule: false };

function inTab(ui: React.ReactNode, repoId = 1) {
  const store = createRepoViewStore(repoId, '/r', graph, fakeServices());
  return render(<RepoContext value={{ tabId: 't1', repoId, path: '/r', worktree: '/r', info: null }}><RepoViewContext value={store}>{ui}</RepoViewContext></RepoContext>);
}

const side = (over: Partial<LfsSide> = {}): LfsSide => ({ oid: OID, size: 3355443, downloaded: false, pointer: `version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 3355443\n`, ...over });
const blob = (lfs?: LfsSide) => ({ size: lfs?.size ?? 10, binary: false, encoding: '', eol: 'none' as const, text: lfs && !lfs.downloaded ? null : 'x', base64: null, hash: null, ...(lfs ? { lfs } : {}) });
const contents = (old?: LfsSide, neu?: LfsSide): DiffContentsPayload => ({ old: blob(old), new: blob(neu), tooLarge: false, eolOnly: false, image: false });

beforeEach(() => {
  vi.clearAllMocks();
  useLfs.setState({ status: {}, tracked: {}, epoch: 0 });
  tab.current = { id: 't1', kind: 'repo' };
});

describe('Git LFS state', () => {
  it('asks which rows LFS stores in one batch, only in a repository that uses LFS', async () => {
    const { container } = inTab(<>{['a.psd', 'b.txt', 'c/d.psd'].map((p) => <LfsMark key={p} path={p} />)}</>);
    await waitFor(() => expect(screen.getAllByTestId('lfs-mark')).toHaveLength(2));
    expect(container.querySelectorAll('.lfs-mark')).toHaveLength(3);
    expect(container.querySelector('.lfs-mark-off')).toHaveAttribute('aria-hidden', 'true');
    expect(api.lfsStatus).toHaveBeenCalledTimes(1);
    expect(api.lfsTracked).toHaveBeenCalledTimes(1);
    expect(api.lfsTracked).toHaveBeenCalledWith(1, '/r', ['a.psd', 'b.txt', 'c/d.psd']);
    fireEvent.mouseEnter(screen.getAllByTestId('lfs-mark')[0]);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Stored with Git LFS');
  });

  it('marks nothing and asks nothing more when the repository doesn\'t use LFS', async () => {
    api.lfsStatus.mockResolvedValueOnce({ used: false, version: '3.4.1', installUrl: 'https://git-lfs.com', filter: true, patterns: ['*.psd'] });
    const { container } = inTab(<LfsMark path="a.psd" />, 2);
    await waitFor(() => expect(useLfs.getState().status[2]).toBeDefined());
    expect(container.querySelector('.lfs-mark')).toBeNull();
    expect(api.lfsTracked).not.toHaveBeenCalled();
  });

  it('a change on disk, or a pull or checkout, reads the status and the known paths again, once settled', async () => {
    vi.useFakeTimers();
    try {
      useLfs.setState({ status: { 11: { used: true, version: '3.4.1', installUrl: 'https://git-lfs.com', filter: true, patterns: ['*.psd'] }, 15: { used: false, version: '3.4.1', installUrl: 'https://git-lfs.com', filter: true, patterns: [] } }, tracked: { '11|/r': { 'a.psd': true, 'b.txt': false } } });
      onLfsEvent({ type: 'repoChanged', repo: 11, kinds: ['head'], worktrees: [], versions: {} });
      onLfsEvent({ type: 'repoChanged', repo: 15, kinds: ['worktree'], worktrees: [], versions: {} });
      onLfsEvent({ type: 'opFinished', op: 1, kind: 'pull', repo: 11, outcome: 'ok', message: null, command: null });
      onLfsEvent({ type: 'repoChanged', repo: 12, kinds: ['head'], worktrees: [], versions: {} });
      expect(api.lfsStatus).not.toHaveBeenCalled();
      await act(async () => { vi.advanceTimersByTime(REFRESH_MS); });
      expect(api.lfsStatus).toHaveBeenCalledExactlyOnceWith(11);
      expect(api.lfsTracked).toHaveBeenCalledWith(11, '/r', ['a.psd', 'b.txt']);
      expect(useLfs.getState().tracked['11|/r']).toEqual({ 'a.psd': true, 'b.txt': false });
      // A failed LFS write: git-lfs's version is read again too.
      onLfsEvent({ type: 'opFinished', op: 2, kind: 'lfs', repo: 11, outcome: 'failed', message: 'x', command: null });
      await act(async () => { vi.advanceTimersByTime(REFRESH_MS); });
      expect(api.lfsStatus).toHaveBeenLastCalledWith(11, true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('on the window\'s focus, a repository read without git-lfs is read again', async () => {
    useLfs.setState({ status: { 13: { used: true, version: null, installUrl: 'https://git-lfs.com', filter: true, patterns: [] }, 14: { used: true, version: '3.4.1', installUrl: 'https://git-lfs.com', filter: true, patterns: [] } } });
    onLfsFocus();
    await waitFor(() => expect(useLfs.getState().status[13]?.version).toBe('3.4.1'));
    expect(api.lfsStatus).toHaveBeenCalledExactlyOnceWith(13, true);
  });

  it('a download moves the epoch the diff views reload on', () => {
    lfsDownloaded();
    expect(useLfs.getState().epoch).toBe(1);
  });
});

describe('the status bar notice', () => {
  const activate = (repo: number) => {
    useAppState.setState({ loaded: true, profile: { ...EMPTY_PROFILE, id: 'default', tabs: [{ id: 't1', kind: 'repo', path: '/r', alias: null }], activeTab: 't1' } });
    useRuntime.setState({ tabs: { t1: { repo: { id: repo } } as never } });
  };

  it('says git-lfs is missing in a repository that uses LFS, and links to the install page', async () => {
    api.lfsStatus.mockResolvedValueOnce({ used: true, version: null, installUrl: 'https://git-lfs.com', filter: true, patterns: ['*.psd'] });
    activate(3);
    render(<LfsNotice />);
    const notice = await screen.findByTestId('lfs-missing');
    expect(notice).toHaveTextContent("This repository uses Git LFS, but git-lfs isn't installed: files check out as pointers");
    fireEvent.click(screen.getByRole('button', { name: 'Install git-lfs' }));
    expect(api.openUrl).toHaveBeenCalledWith('https://git-lfs.com');
  });

  it('shows nothing when git-lfs is installed, or the repository doesn\'t use LFS', async () => {
    api.lfsStatus.mockResolvedValueOnce({ used: false, version: null, installUrl: 'https://git-lfs.com', filter: true, patterns: ['*.psd'] });
    activate(4);
    render(<LfsNotice />);
    await waitFor(() => expect(useLfs.getState().status[4]).toBeDefined());
    expect(screen.queryByTestId('lfs-missing')).toBeNull();
    activate(5);
    await waitFor(() => expect(useLfs.getState().status[5]).toBeDefined());
    expect(screen.queryByTestId('lfs-missing')).toBeNull();
  });
});

describe('the "not downloaded" placeholder', () => {
  it('only LFS sides that aren\'t downloaded count', () => {
    expect(lfsMissing(contents(side({ downloaded: true }), side()))).toHaveLength(1);
    expect(lfsMissing(contents())).toHaveLength(0);
  });

  it('names the size, shows the pointer on request, and downloads the file at the diff\'s commits', async () => {
    const target = targetFor(file, { kind: 'commit', id: A, parent: 0 } as never);
    inTab(<LfsPlaceholder target={target} contents={contents(undefined, side())} sides={{ old: P, new: A }} />);
    expect(screen.getByTestId('lfs-placeholder')).toHaveTextContent('LFS file (3.2 MB), not downloaded');
    expect(screen.queryByLabelText('LFS pointer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show pointer' }));
    expect(screen.getByLabelText('LFS pointer')).toHaveTextContent(`oid sha256:${OID}`);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download' })); });
    expect(api.lfsDownload).toHaveBeenCalledWith(1, '/r', 'art/logo.psd', [P, A], [OID]);
    expect(useLfs.getState().epoch).toBe(1);
    expect(show).not.toHaveBeenCalled();
  });

  it('without git-lfs, Download is off and says where to get it', async () => {
    api.lfsStatus.mockResolvedValueOnce({ used: true, version: null, installUrl: 'https://git-lfs.com', filter: true, patterns: ['*.psd'] });
    const target = targetFor(file, { kind: 'commit', id: A, parent: 0 } as never);
    inTab(<LfsPlaceholder target={target} contents={contents(undefined, side())} sides={{ old: P, new: A }} />, 9);
    expect(await screen.findByTestId('lfs-install-hint')).toHaveTextContent("git-lfs isn't installed, so it can't be downloaded.");
    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Install git-lfs' }));
    expect(api.openUrl).toHaveBeenCalledWith('https://git-lfs.com');
    expect(api.lfsDownload).not.toHaveBeenCalled();
  });

  it('two sizes read old → new; a file the remote didn\'t have says so', async () => {
    api.lfsDownload.mockResolvedValueOnce({ outcome: { missing: [OID] } });
    const target = targetFor(file, { kind: 'commit', id: A, parent: 0 } as never);
    inTab(<LfsPlaceholder target={target} contents={contents(side({ size: 1024 }), side({ oid: 'd'.repeat(64) }))} sides={{ old: 'worktree', new: A }} />);
    expect(screen.getByTestId('lfs-placeholder')).toHaveTextContent('LFS file (1.0 KB → 3.2 MB), not downloaded');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download' })); });
    expect(api.lfsDownload).toHaveBeenCalledWith(1, '/r', 'art/logo.psd', [A], [OID, 'd'.repeat(64)]);
    expect(show).toHaveBeenCalledWith("git-lfs didn't find art/logo.psd on the remote", { error: true });
  });
});

describe('LFS actions and the file menu', () => {
  type Action = Extract<MenuRow, { kind: 'action' }>;
  const write = { tabId: 't1', repoId: 7, worktree: '/r' };
  const fileRows = (path: string) => buildMenu('file', { path } as never, { write } as never).filter((r): r is Action => r.kind === 'action' && r.id.startsWith('file.lfs'));
  const ready = (status: { used: boolean; version: string | null }, patterns = ['*.psd']) => {
    useRuntime.setState({ tabs: { t1: { repo: { id: 7, path: '/r' }, worktree: '/r' } as never } });
    useLfs.setState({ status: { 7: { ...status, installUrl: 'https://git-lfs.com', filter: true, patterns } } });
  };

  it('LFS: Pull and LFS: Fetch need a repository that uses LFS and git-lfs', async () => {
    const pull = getAction('lfs.pull')!;
    const fetch = getAction('lfs.fetch')!;
    expect(pull.label).toBe('LFS: Pull');
    ready({ used: false, version: '3.4.1' });
    expect(pull.when!()).toBe(false);
    ready({ used: true, version: null });
    expect(fetch.when!()).toBe(false);
    ready({ used: true, version: '3.4.1' });
    expect(pull.when!() && fetch.when!()).toBe(true);
    await pull.run();
    expect(api.lfsPull).toHaveBeenCalledWith(7, '/r');
    await fetch.run();
    expect(api.lfsFetch).toHaveBeenCalledWith(7, '/r');
    expect(useLfs.getState().epoch).toBe(2);
    tab.current = null;
    expect(pull.when!()).toBe(false);
  });

  it('a file row offers Track *.<ext> with git-lfs installed, Stop tracking for a file LFS stores', async () => {
    ready({ used: false, version: null });
    expect(fileRows('art/logo.psd')).toEqual([]);
    ready({ used: false, version: '3.4.1' });
    const [track] = fileRows('art/logo.psd');
    expect(track.label).toBe('Track *.psd with LFS');
    track.run();
    await waitFor(() => expect(api.lfsTrack).toHaveBeenCalledWith(7, '/r', '*.psd'));
    await waitFor(() => expect(show).toHaveBeenCalledWith('Tracking *.psd with Git LFS: commit .gitattributes to share it'));
    expect(api.lfsStatus).toHaveBeenCalledWith(7);
    ready({ used: true, version: '3.4.1' });
    useLfs.setState({ tracked: { '7|/r': { 'art/logo.psd': true } } });
    const [untrack] = fileRows('art/logo.psd');
    expect(untrack.label).toBe('Stop tracking *.psd');
    untrack.run();
    await waitFor(() => expect(api.lfsUntrack).toHaveBeenCalledWith(7, '/r', '*.psd'));
    expect(fileRows('Makefile')).toEqual([]);
  });

  it('without git lfs install, Track and Pull say to run it', async () => {
    ready({ used: false, version: '3.4.1' });
    api.lfsStatus.mockResolvedValueOnce({ used: true, version: '3.4.1', installUrl: 'https://git-lfs.com', filter: false, patterns: ['*.psd'] });
    fileRows('art/logo.psd')[0].run();
    await waitFor(() => expect(show).toHaveBeenCalledWith("Tracking *.psd with Git LFS, but git-lfs isn't set up in this repository yet: run git lfs install before you commit", { tone: 'warning', detail: 'git lfs install' }));
    ready({ used: true, version: '3.4.1' });
    api.lfsPull.mockResolvedValueOnce({ outcome: { missing: [], notSetUp: true } } as never);
    await getAction('lfs.pull')!.run();
    expect(show).toHaveBeenLastCalledWith("Fetched the LFS files. git-lfs isn't set up in this repository, so the files stay pointers: run git lfs install", { tone: 'warning', detail: 'git lfs install' });
  });

  it('nothing while it isn\'t known whether LFS stores the file; no Stop tracking for another rule\'s file', () => {
    ready({ used: true, version: '3.4.1' });
    useLfs.setState({ tracked: {} });
    expect(fileRows('art/logo.psd')).toEqual([]);
    ready({ used: true, version: '3.4.1' }, ['assets/**']);
    useLfs.setState({ tracked: { '7|/r': { 'assets/logo.psd': true, 'b.png': false } } });
    expect(fileRows('assets/logo.psd')).toEqual([]);
    expect(fileRows('b.png').map((r) => r.label)).toEqual(['Track *.png with LFS']);
  });

  it('extension patterns', () => {
    expect(extPattern('a/b/logo.psd')).toBe('*.psd');
    expect(extPattern('archive.tar.gz')).toBe('*.gz');
    for (const none of ['Makefile', '.gitignore', 'dir.d/file', 'trailing.', 'odd.[x]']) expect(extPattern(none)).toBeNull();
  });
});
