import { describe, expect, it, vi } from 'vitest';
import type { LocateResult } from '../api/gen/LocateResult';
import { classify } from './classify';
import { resolveGoto, type GotoEnv, type GotoTab } from './resolve';

const SHA = '3f2a9c1d4e5b6a7980c1d2e3f4a5b6c7d8e9f001';
const OTHER = 'a0b1c2d3e4f5061728394a5b6c7d8e9f00112233';

const harbor: GotoTab = {
  tabId: 't1', active: true, loaded: true, name: 'harbor', path: '/home/ada/harbor', repo: 1, worktree: '/home/ada/harbor', worktrees: ['/home/ada/harbor', '/home/ada/harbor/.wt/fix'], branch: 'main',
  remotes: [{ host: 'gitlab.example.test', path: 'harbor/tools/dock' }],
  forge: { kind: 'gitlab', path: 'harbor/tools/dock', webUrl: 'https://gitlab.example.test/harbor/tools/dock' },
};
const lighthouse: GotoTab = {
  tabId: 't2', active: false, loaded: true, name: 'lighthouse', path: '/home/ada/lighthouse', repo: 2, worktree: '/home/ada/lighthouse', worktrees: ['/home/ada/lighthouse'], branch: 'main',
  remotes: [{ host: 'github.com', path: 'octo-org/lighthouse' }], forge: null,
};
/** A fork: its remote `upstream` is octo-org/widget, its own project ada/widget. */
const widget: GotoTab = {
  tabId: 't3', active: false, loaded: true, name: 'widget', path: '/home/ada/widget', repo: 3, worktree: '/home/ada/widget', worktrees: ['/home/ada/widget'], branch: 'main',
  remotes: [{ host: 'github.com', path: 'ada/widget' }, { host: 'github.com', path: 'octo-org/widget' }],
  forge: { kind: 'github', path: 'ada/widget', webUrl: 'https://github.com/ada/widget' },
};
/** Not shown this session: nothing read about it yet. */
const buoy: GotoTab = {
  tabId: 't4', active: false, loaded: false, name: 'buoy', path: '/home/ada/buoy', repo: null, worktree: '/home/ada/buoy', worktrees: ['/home/ada/buoy'], branch: null, remotes: [], forge: null,
};

function env(over: Partial<GotoEnv> = {}, tabs: GotoTab[] = [harbor, lighthouse]): GotoEnv {
  const commits: Record<number, string[]> = { 1: [SHA], 2: [OTHER] };
  const files: Record<number, string[]> = { 1: ['src/app.php', 'src/lib/util.php', 'README.md'], 2: ['index.ts'], 4: ['docs/a.md'] };
  return {
    tabs: () => tabs,
    // buoy's remotes are on GitHub, the second tab not shown yet (raft) has them on a GitLab.
    peek: vi.fn(async (t: GotoTab) => ({ ...t, branch: t.tabId === 't4' ? 'main' : null, remotes: [t.tabId === 't4' ? { host: 'github.com', path: 'octo-org/buoy' } : { host: 'gitlab.example.test', path: 'harbor/raft' }] })),
    load: vi.fn(async (t: GotoTab) => ({ ...t, repo: 4, forge: { kind: 'github' as const, path: 'octo-org/buoy', webUrl: 'https://github.com/octo-org/buoy' } })),
    open: vi.fn(async () => 4),
    locate: vi.fn(async (repo: number, sha: string): Promise<LocateResult | null> => {
      const id = commits[repo]?.find((c) => c.startsWith(sha)) ?? null;
      return id ? { found: true, limit: null, id, ambiguous: false } : null;
    }),
    refTip: (tabId, name) => (tabId === 't1' && (name === 'main' || name === 'origin/main' || name === 'v1.0') ? SHA : null),
    files: vi.fn(async (repo: number, wt: string) => (wt.endsWith('fix') ? ['fix.txt'] : files[repo] ?? [])),
    pathKind: vi.fn(async (_r: number, _w: string, path: string) => (path === 'notes.txt' ? 'file' as const : path === 'scratch' ? 'dir' as const : null)),
    caseless: false,
    ...over,
  };
}
const go = (text: string, e = env()) => resolveGoto(classify(text), e);

describe('resolveGoto: commits', () => {
  it('finds a commit in the active repository first, then in the other tabs', async () => {
    expect(await go(SHA.slice(0, 7))).toEqual({ kind: 'commit', tabId: 't1', sha: SHA, limit: null, missing: null });
    expect(await go(OTHER.slice(0, 9))).toMatchObject({ kind: 'commit', tabId: 't2', sha: OTHER });
  });

  it('says when no open repository has the commit, or a short hash is ambiguous', async () => {
    expect(await go('deadbe3f1')).toEqual({ kind: 'toast', message: 'No commit deadbe3f1 in harbor or 1 other open repository', url: null });
    expect(await go('deadbe3f1', env({}, [harbor, lighthouse, widget, { ...widget, tabId: 't6' }]))).toMatchObject({ message: 'No commit deadbe3f1 in harbor or 3 other open repositories' });
    expect(await go('deadbe3f1', env({}, [harbor]))).toMatchObject({ message: 'No commit deadbe3f1 in harbor' });
    const amb = env({ locate: async () => ({ found: false, limit: null, id: null, ambiguous: true }) });
    expect(await go('3f2a9c1', amb)).toMatchObject({ kind: 'toast', message: '3f2a9c1 is ambiguous in harbor: paste more of the hash' });
  });

  it("says honestly that tabs not shown yet weren't searched", async () => {
    expect(await go('deadbe3f1', env({}, [harbor, lighthouse, buoy, { ...buoy, tabId: 't5' }]))).toMatchObject({ message: 'No commit deadbe3f1 in harbor or 1 other open repository; 2 tabs not loaded yet' });
  });

  it('ignores a number or a word that happens to be hex', async () => {
    expect(await go('1234567')).toEqual({ kind: 'none' });
    expect(await go('defaced')).toEqual({ kind: 'none' });
  });

  it('carries the window a commit outside the loaded one needs', async () => {
    const deep = env({ locate: async () => ({ found: true, limit: 3100, id: SHA, ambiguous: false }) });
    expect(await go(SHA, deep)).toMatchObject({ kind: 'commit', tabId: 't1', sha: SHA, limit: 3100 });
  });

  it('prefers the commit for hex that is also a branch name, else the branch', async () => {
    const e = env({ refTip: (_t, n) => (n === 'cafe1234' ? OTHER : null) });
    expect(await go('cafe1234', e)).toMatchObject({ kind: 'commit', tabId: 't1', sha: OTHER });
  });
});

describe('resolveGoto: MRs and forge pages', () => {
  it('opens an MR/PR URL only in the tab whose forge project it is, exactly', async () => {
    const url = 'https://gitlab.example.test/harbor/tools/dock/-/merge_requests/12/diffs#note_1';
    expect(await go(url)).toEqual({ kind: 'mr', tabId: 't1', number: 12, forge: 'gitlab', project: 'harbor/tools/dock', url });
    expect(await go('https://GitHub.com/Ada/Widget/pull/7/files', env({}, [harbor, widget]))).toMatchObject({ kind: 'mr', tabId: 't3', number: 7 });
    // No suffix match: a project nested deeper isn't this one.
    expect(await go('https://gitlab.example.test/x/harbor/tools/dock/-/merge_requests/3')).toMatchObject({ kind: 'toast' });
  });

  it("doesn't take a fork's upstream remote for its project's MR, but does for a commit (checked there)", async () => {
    const url = 'https://github.com/octo-org/widget/pull/5';
    expect(await go(url, env({}, [harbor, widget]))).toEqual({ kind: 'toast', message: "#5 belongs to octo-org/widget, which isn't open here (widget's project is ada/widget)", url });
    const fork = env({ locate: async (repo) => (repo === 3 ? { found: true, limit: null, id: OTHER, ambiguous: false } : null) }, [harbor, widget]);
    expect(await go(`https://github.com/octo-org/widget/commit/${OTHER}`, fork)).toMatchObject({ kind: 'commit', tabId: 't3', sha: OTHER });
    const page = 'https://github.com/octo-org/widget/commit/a0b1c2d';
    expect(await go(page, env({}, [harbor, widget]))).toEqual({ kind: 'toast', message: 'No commit a0b1c2d in widget', url: page });
    const file = 'https://github.com/octo-org/widget/blob/main/a.txt';
    expect(await go(file, env({}, [harbor, widget]))).toEqual({ kind: 'toast', message: "octo-org/widget isn't open here (widget's project is ada/widget)", url: file });
  });

  it("offers the browser for an MR whose project isn't open, or open with no account", async () => {
    const url = 'https://gitlab.example.test/harbor/other/-/merge_requests/12';
    expect(await go(url)).toEqual({ kind: 'toast', message: "!12 belongs to harbor/other, which isn't open here", url });
    const pr = 'https://github.com/octo-org/lighthouse/pull/7';
    expect(await go(pr)).toEqual({ kind: 'toast', message: 'No GitHub account for lighthouse: #7 opens in the browser', url: pr });
  });

  it('reads the tabs not shown yet just enough to match, once the shown ones miss', async () => {
    const raft = { ...buoy, tabId: 't5', name: 'raft', path: '/home/ada/raft', worktree: '/home/ada/raft', worktrees: ['/home/ada/raft'] };
    const e = env({}, [harbor, buoy, raft]);
    expect(await go('https://github.com/octo-org/buoy/pull/2', e)).toMatchObject({ kind: 'mr', tabId: 't4', number: 2, project: 'octo-org/buoy' });
    // Both peeked at (their remotes); only the one with a remote on github.com opened.
    expect(e.peek).toHaveBeenCalledTimes(2);
    expect(e.load).toHaveBeenCalledTimes(1);
    expect(e.load).toHaveBeenCalledWith(expect.objectContaining({ tabId: 't4' }));
    const e2 = env({}, [harbor, buoy]);
    await go('https://gitlab.example.test/harbor/tools/dock/-/merge_requests/1', e2);
    expect(e2.peek).not.toHaveBeenCalled();
    expect(e2.load).not.toHaveBeenCalled();
    // Its file page: the branch peeked is the page's, so no note; an unknown checkout, none either.
    expect(await go('https://github.com/octo-org/buoy/blob/main/docs/a.md', env({}, [harbor, buoy]))).toMatchObject({ kind: 'file', tabId: 't4', path: 'docs/a.md', note: null });
    expect(await go('https://github.com/octo-org/buoy/blob/v2/docs/a.md', env({}, [harbor, buoy]))).toMatchObject({ kind: 'file', note: "Showing the working copy of docs/a.md, not v2's" });
    const unknown = env({ peek: async (t) => ({ ...t, branch: null, remotes: [{ host: 'github.com', path: 'octo-org/buoy' }] }) }, [harbor, buoy]);
    expect(await go('https://github.com/octo-org/buoy/blob/v2/docs/a.md', unknown)).toMatchObject({ kind: 'file', note: null });
    // Its commit can't be looked for without a graph: the tab opens and looks.
    expect(await go(`https://github.com/octo-org/buoy/commit/${OTHER}`, env({}, [harbor, buoy])))
      .toEqual({ kind: 'commit', tabId: 't4', sha: OTHER, limit: null, missing: { message: `No commit ${OTHER.slice(0, 6)} in buoy`, url: `https://github.com/octo-org/buoy/commit/${OTHER}` } });
  });

  it("reads !12 and #12 against the active repository's forge", async () => {
    expect(await go('!12')).toEqual({ kind: 'mr', tabId: 't1', number: 12, forge: 'gitlab', project: 'harbor/tools/dock', url: 'https://gitlab.example.test/harbor/tools/dock/-/merge_requests/12' });
    expect(await go('#12')).toEqual({ kind: 'none' });
    expect(await go('harbor/tools/dock!3')).toMatchObject({ kind: 'mr', number: 3 });
    expect(await go('harbor/other!12')).toEqual({ kind: 'toast', message: "!12 belongs to harbor/other, which isn't open here", url: 'https://gitlab.example.test/harbor/other/-/merge_requests/12' });
    expect(await go('!12', env({}, [{ ...lighthouse, active: true }]))).toMatchObject({ kind: 'toast', message: 'lighthouse has no GitLab or GitHub project for !12' });
  });

  it('selects the commit of a forge commit page in its tab; with no account, by its remote', async () => {
    expect(await go(`https://github.com/octo-org/lighthouse/commit/${OTHER.toUpperCase()}`)).toMatchObject({ kind: 'commit', tabId: 't2', sha: OTHER });
    const url = `https://gitlab.example.test/harbor/tools/dock/-/merge_requests/4/diffs?commit_id=${OTHER}`;
    expect(await go(url)).toEqual({ kind: 'toast', message: `No commit ${OTHER.slice(0, 6)} in harbor`, url });
    expect(await go(`https://github.com/octo-org/nowhere/commit/${OTHER}`)).toMatchObject({ kind: 'toast', message: "octo-org/nowhere isn't open here" });
  });

  it('opens a forge file page at its lines, splitting a ref with slashes; another ref shows the working copy, said so', async () => {
    expect(await go('https://gitlab.example.test/harbor/tools/dock/-/blob/feature/x/src/lib/util.php#L12-20'))
      .toEqual({ kind: 'file', tabId: 't1', worktree: '/home/ada/harbor', path: 'src/lib/util.php', lines: { start: 12, end: 20 }, note: "Showing the working copy of src/lib/util.php, not feature/x's" });
    expect(await go('https://gitlab.example.test/harbor/tools/dock/-/blob/main/src/app.php')).toMatchObject({ kind: 'file', path: 'src/app.php', note: null });
    const missing = 'https://gitlab.example.test/harbor/tools/dock/-/blob/main/src/x.php';
    expect(await go(missing)).toEqual({ kind: 'toast', message: 'No file src/x.php in harbor', url: missing });
  });
});

describe('resolveGoto: paths and refs', () => {
  it('opens a relative path in the active worktree, a folder as a folder, an untracked file or folder if it is there', async () => {
    expect(await go('src/app.php:12-14')).toMatchObject({ kind: 'file', tabId: 't1', worktree: '/home/ada/harbor', path: 'src/app.php', lines: { start: 12, end: 14 } });
    expect(await go('src/lib/')).toEqual({ kind: 'folder', tabId: 't1', worktree: '/home/ada/harbor', path: 'src/lib' });
    expect(await go('notes.txt')).toMatchObject({ kind: 'file', path: 'notes.txt' });
    expect(await go('scratch')).toEqual({ kind: 'folder', tabId: 't1', worktree: '/home/ada/harbor', path: 'scratch' });
    expect(await go('src/new.php', env({ pathKind: async () => { throw new Error('gone'); } }))).toEqual({ kind: 'none' });
    expect(await go('src/new.php')).toEqual({ kind: 'toast', message: 'No file src/new.php in harbor', url: null });
  });

  it('ignores a bare name, with a line or dotted, that is no file', async () => {
    for (const t of ['nothing.txt', 'nothing:12', 'v9.9.9', 'hello']) expect(await go(t)).toEqual({ kind: 'none' });
  });

  it('finds an absolute path in the tab and worktree holding it, the deepest worktree first', async () => {
    expect(await go('/home/ada/harbor/.wt/fix/fix.txt:3')).toMatchObject({ kind: 'file', tabId: 't1', worktree: '/home/ada/harbor/.wt/fix', path: 'fix.txt', lines: { start: 3, end: 3 } });
    expect(await go('/home/ada/lighthouse/index.ts')).toMatchObject({ kind: 'file', tabId: 't2', path: 'index.ts' });
    expect(await go('/home/ada/lighthouse')).toEqual({ kind: 'folder', tabId: 't2', worktree: '/home/ada/lighthouse', path: '' });
    expect(await go('/home/ada/harborside/a.txt')).toEqual({ kind: 'toast', message: "/home/ada/harborside/a.txt isn't in an open repository", url: null });
  });

  it("opens the repository of a tab not shown yet to look for a path in it", async () => {
    const e = env({}, [harbor, buoy]);
    expect(await go('/home/ada/buoy/docs/a.md:4', e)).toMatchObject({ kind: 'file', tabId: 't4', path: 'docs/a.md' });
    expect(e.open).toHaveBeenCalledWith('/home/ada/buoy');
  });

  it('matches paths by drive and separators, without case where the file system ignores it', async () => {
    const win: GotoTab = { ...harbor, worktree: 'c:\\Users\\ada\\harbor', worktrees: ['c:\\Users\\ada\\harbor'] };
    const e = env({ caseless: true, files: async () => ['src/App.php'] }, [win]);
    expect(await go('C:\\users\\ada\\harbor\\src\\app.php:7', e)).toMatchObject({ kind: 'file', tabId: 't1', worktree: 'c:\\Users\\ada\\harbor', path: 'src/App.php', lines: { start: 7, end: 7 } });
  });

  it('selects a branch, remote branch or tag tip; other words are ignored', async () => {
    expect(await go('main')).toMatchObject({ kind: 'commit', tabId: 't1', sha: SHA });
    expect(await go('origin/main')).toMatchObject({ kind: 'commit', tabId: 't1', sha: SHA });
    expect(await go('v1.0')).toMatchObject({ kind: 'commit', tabId: 't1', sha: SHA });
    expect(await go('just some words')).toEqual({ kind: 'none' });
  });
});
