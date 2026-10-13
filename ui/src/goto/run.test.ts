// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  openFileAt: vi.fn(async (_t: string, _p: string, _c: string, _o: object) => true),
  selectCommit: vi.fn(() => true),
  recordPlace: vi.fn(),
  openMrView: vi.fn(),
  openExternal: vi.fn(),
  setActiveWorktree: vi.fn(),
  loadCommit: vi.fn(async (_t: string, _s: string, _l: number | null) => true),
  forgeMrDetail: vi.fn(),
  readClipboardText: vi.fn(async (): Promise<string> => ''),
}));
vi.mock('../nav/repoPlaces', () => ({ openFileAt: m.openFileAt }));
vi.mock('../app/graphNav', () => ({ selectCommit: m.selectCommit }));
vi.mock('../nav/history', () => ({ recordPlace: m.recordPlace }));
vi.mock('../forge/poll', () => ({ openMrView: m.openMrView }));
vi.mock('../markdown/actions', () => ({ openExternal: m.openExternal }));
vi.mock('../worktrees/active', () => ({ setActiveWorktree: m.setActiveWorktree }));
vi.mock('../find/findStore', () => ({ loadCommit: m.loadCommit }));
vi.mock('../api/client', () => ({ api: { forgeMrDetail: m.forgeMrDetail } }));
vi.mock('../api/transport', () => ({ readClipboardText: m.readClipboardText }));

const { useAppState } = await import('../app/state');
const { useRuntime } = await import('../app/runtime');
const { useTabViews } = await import('../app/tabStores');
const { useFileListPrefs, FILE_LIST_PREFS_STORAGE_KEY } = await import('../files/fileListPrefs');
const { useFileReveal } = await import('../files/reveal');
const { useMarkdownOverride } = await import('../diff/markdownOverride');
const { useToast } = await import('../ui/toastStore');
const { create } = await import('zustand');
const { runGoto, gotoText, gotoClipboard } = await import('./run');

const SHA = '3f2a9c1d4e5b6a7980c1d2e3f4a5b6c7d8e9f001';
const DEEP = 'a0b1c2d3e4f5061728394a5b6c7d8e9f00112233';
const WT = '/home/ada/harbor';
const MR_URL = 'https://github.com/octo-org/widget/pull/123456';

let rows: Array<{ id: string; wip?: { worktreePath: string } }>;
function seed() {
  rows = [{ id: SHA }];
  const store = { subscribe: () => () => {}, getState: () => ({ indexById: new Map([[SHA, 0]]), graph: { rows }, selection: { kind: 'none' } }) };
  useAppState.setState({ profile: { ...useAppState.getState().profile, tabs: [{ id: 't1', kind: 'repo', path: WT, alias: null }, { id: 't2', kind: 'repo', path: '/home/ada/lighthouse', alias: null }], activeTab: 't1' } });
  useRuntime.setState({ tabs: { t1: { repo: { id: 1, path: WT, name: 'harbor', worktree: WT }, worktree: WT, graph: { worktrees: [{ path: WT, head: SHA }] } } } } as never);
  useTabViews.setState({ views: { t1: { repo: 1, services: {}, store } } as never });
}
const file = (over: object = {}) => ({ kind: 'file' as const, tabId: 't1', worktree: WT, path: 'src/app.php', lines: null, note: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  useFileListPrefs.setState({ allFiles: false, wipAllFiles: false, mode: 'path' });
  useFileReveal.setState({ req: null });
  useMarkdownOverride.setState({ path: null });
  useToast.getState().dismiss();
});

describe('runGoto', () => {
  it('selects a commit as a navigation place, once loaded (a deeper window through find)', async () => {
    await runGoto({ kind: 'commit', tabId: 't1', sha: DEEP, limit: 3100, missing: null });
    expect(m.loadCommit).toHaveBeenCalledWith('t1', DEEP, 3100);
    expect(m.recordPlace).toHaveBeenCalledWith('t1', { kind: 'commit', sha: DEEP });
    expect(m.selectCommit).toHaveBeenCalledWith('t1', DEEP, { focus: true });
  });

  it("switches to the tab, and says what the resolver asked when the commit isn't there", async () => {
    useAppState.setState({ profile: { ...useAppState.getState().profile, activeTab: 't2' } });
    m.loadCommit.mockResolvedValueOnce(false);
    await runGoto({ kind: 'commit', tabId: 't1', sha: DEEP, limit: null, missing: { message: 'No commit a0b1c2 in harbor', url: 'https://github.com/o/r/commit/a0b1c2' } });
    expect(useAppState.getState().profile.activeTab).toBe('t1');
    expect(m.selectCommit).not.toHaveBeenCalled();
    expect(useToast.getState()).toMatchObject({ message: 'No commit a0b1c2 in harbor', action: { label: 'Open in browser' } });
  });

  it("opens a clean worktree's file at its HEAD, at the lines, with all files shown and the file revealed", async () => {
    await runGoto(file({ lines: { start: 12, end: 20 } }));
    expect(m.openFileAt).toHaveBeenCalledWith('t1', 'src/app.php', SHA, expect.objectContaining({ record: true, line: { side: 'modified', line: 12, end: 20 } }));
    expect(useFileListPrefs.getState().allFiles).toBe(true);
    expect(useFileReveal.getState().req).toMatchObject({ tabId: 't1', path: 'src/app.php', folder: false });
  });

  it("opens the working copy when the worktree has changes; Markdown's lines in its source; a note after", async () => {
    rows.unshift({ id: `wip:${WT}`, wip: { worktreePath: WT } });
    await runGoto(file({ path: 'docs/a.md', lines: { start: 3, end: 3 }, note: "Showing the working copy of docs/a.md, not v2's" }));
    expect(m.openFileAt).toHaveBeenCalledWith('t1', 'docs/a.md', 'worktree', expect.anything());
    expect(useFileListPrefs.getState().wipAllFiles).toBe(true);
    expect(useMarkdownOverride.getState().path).toBe('docs/a.md');
    expect(useToast.getState().message).toBe("Showing the working copy of docs/a.md, not v2's");
  });

  it("shows a CSV file's lines in its source, not its table", async () => {
    await runGoto(file({ path: 'data/plants.csv', lines: { start: 4, end: 4 } }));
    expect(useMarkdownOverride.getState().path).toBe('data/plants.csv');
  });

  it("switches the tab's worktree for a path in another worktree of its repository", async () => {
    await runGoto(file({ worktree: '/home/ada/harbor/.wt/fix', path: 'fix.txt' }));
    expect(m.setActiveWorktree).toHaveBeenCalledWith('t1', '/home/ada/harbor/.wt/fix');
  });

  it('shows a folder in the tree for the session (the saved Path/Tree untouched), the MR view closed', async () => {
    localStorage.removeItem(FILE_LIST_PREFS_STORAGE_KEY);
    await runGoto({ kind: 'folder', tabId: 't1', worktree: WT, path: 'src/lib' });
    expect(m.selectCommit).toHaveBeenCalledWith('t1', SHA);
    expect(useFileListPrefs.getState()).toMatchObject({ mode: 'tree', allFiles: true });
    expect(localStorage.getItem(FILE_LIST_PREFS_STORAGE_KEY)).toBeNull();
    expect(useFileReveal.getState().req).toMatchObject({ path: 'src/lib', folder: true });
  });

  describe('View all files after the file closes', () => {
    const watch = () => {
      const store = create<{ diff: object | null; indexById: Map<string, number>; graph: { rows: unknown[] }; selection: object }>(() => ({ diff: null, indexById: new Map([[SHA, 0]]), graph: { rows }, selection: { kind: 'none' } }));
      useTabViews.setState({ views: { t1: { repo: 1, services: {}, store } } as never });
      m.openFileAt.mockImplementationOnce(async () => { store.setState({ diff: { key: 'k' } }); return true; });
      return store;
    };

    it('goes back off when the file is closed, if the paste turned it on', async () => {
      const store = watch();
      await runGoto(file());
      expect(useFileListPrefs.getState().allFiles).toBe(true);
      store.setState({ diff: null });
      expect(useFileListPrefs.getState().allFiles).toBe(false);
    });

    it('stays on when it was on already', async () => {
      const store = watch();
      useFileListPrefs.setState({ allFiles: true });
      await runGoto(file());
      store.setState({ diff: null });
      expect(useFileListPrefs.getState().allFiles).toBe(true);
    });

    it('is left alone when the user toggled it meanwhile', async () => {
      const store = watch();
      await runGoto(file());
      useFileListPrefs.getState().set({ allFiles: false });
      useFileListPrefs.getState().set({ allFiles: true });
      store.setState({ diff: null });
      expect(useFileListPrefs.getState().allFiles).toBe(true);
    });
  });

  it('opens an MR once the forge says it is one', async () => {
    m.forgeMrDetail.mockResolvedValueOnce({ value: {} });
    await runGoto({ kind: 'mr', tabId: 't1', number: 123456, forge: 'github', project: 'octo-org/widget', url: MR_URL });
    expect(m.openMrView).toHaveBeenCalledWith('t1', 123456);
  });

  it("says a number isn't an MR/PR, offering the browser rather than opening it", async () => {
    m.forgeMrDetail.mockRejectedValueOnce({ kind: 'NotFound', message: 'Not Found' });
    await runGoto({ kind: 'mr', tabId: 't1', number: 123456, forge: 'github', project: 'octo-org/widget', url: MR_URL });
    expect(m.openMrView).not.toHaveBeenCalled();
    expect(m.openExternal).not.toHaveBeenCalled();
    const t = useToast.getState();
    expect(t.message).toBe("#123456 isn't a pull request in octo-org/widget");
    t.action?.run();
    expect(m.openExternal).toHaveBeenCalledWith(MR_URL);
  });

  it('says nothing when the clipboard has no text (an image) or can\'t be read', async () => {
    m.readClipboardText.mockRejectedValueOnce(new Error('The clipboard contents were not available in the requested format'));
    await gotoClipboard();
    expect(useToast.getState().message).toBeNull();
  });

  it('lets a newer paste take over from one still on its way', async () => {
    let release!: () => void;
    const slow = new Promise<null>((r) => { release = () => r(null); });
    const tab = { tabId: 't1', active: true, loaded: true, name: 'harbor', path: WT, repo: 1, worktree: WT, worktrees: [WT], branch: 'main', remotes: [], forge: null };
    const env = (over: object) => ({ tabs: () => [tab], peek: async () => null, load: async () => null, open: async () => null, locate: async () => null, refTip: () => null, files: async () => [], pathKind: async () => null, caseless: false, ...over });
    // Alone, it would say "No commit 3f2a9c1d in this repository".
    const first = gotoText('3f2a9c1d', env({ locate: () => slow }));
    await gotoText('just words', env({}));
    release();
    await first;
    expect(useToast.getState().message).toBeNull();
  });
});
