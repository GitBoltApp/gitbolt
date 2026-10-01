import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRuntime } from '../app/runtime';
import type { SideItem } from '../sidebar/model';
import type { MenuRow } from './types';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RowPayload } from '../api/gen/RowPayload';
import { createCommitMessageCache } from '../api/commitMessages';
import type { CommitMessage } from '../api/gen/CommitMessage';
import type { EditorContextMenuEvent } from '../diff/monaco/host';
import { createRepoViewStore, fileViewTarget, targetFor } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { useToast } from '../ui/toast';
import { compare, copyMessage, fileMenuEnv, fileTargetOf, folderTargetOf, monacoTargetOf, sidebarItemMenu, sidebarRemoteMenu, splitRemoteRef, upstreamOf, type FileTarget, type MenuEnv } from './menuEnv';
import { buildMenu } from './registry';

// `compare`/`copyMessage` reach the real clipboard (api/transport); fix round 1, item 7's unit
// tests for them mock it, as DiffPanel.openIn.test.tsx and others do.
const copyText = vi.hoisted(() => vi.fn(async (_text: string) => {}));
vi.mock('../api/transport', () => ({ copyText }));

const row = (id: string, parents: string[], wip: string | null = null): RowPayload => ({
  id, kind: wip ? 'wip' : 'commit', lane: 0, color: 0, segments: [], summary: id, bodyFirstLine: '', authorName: '', authorEmail: '', authorTime: 0, committerTime: 0, parents, mrRefs: [],
  wip: wip ? { worktreePath: wip, worktreeName: null, modified: 1, added: 0, deleted: 0, renamed: 0, conflicted: 0 } : null,
});
const remote = (remote: string, branch: string) => ({ fullName: `refs/remotes/${remote}/${branch}`, remote, host: 'gitlab.example.com', hostKind: 'gitlab' as const });
const label = (r: number, name: string, local: boolean, remotes: ReturnType<typeof remote>[], extra: Partial<RefLabel> = {}): RefLabel => ({ row: r, name, local: local ? `refs/heads/${name}` : null, remotes, tag: false, isHead: false, worktree: null, ...extra });

// wip → c0 (main, origin/main) → c1 → c2 ; topic (local only) at t0, origin/topic at t1 ; lone at l0
const graphOf = (labels: RefLabel[]): GraphPayload => ({
  rows: [row('wip', ['c0'], '/wt/main'), row('c0', ['c1']), row('c1', ['c2']), row('c2', []), row('t0', ['t1']), row('t1', ['c2']), row('l0', ['c2'])],
  labels, maxLanes: 1, pinnedRef: null, head: { branch: 'refs/heads/main', target: 'c0', detached: false, unborn: false }, truncated: false,
});
const labels = [
  label(1, 'main', true, [remote('origin', 'main')], { isHead: true }),
  label(4, 'topic', true, []),
  label(5, 'topic', false, [remote('up/stream', 'topic'), remote('origin', 'topic')]),
  label(6, 'lone', true, []),
  label(6, 'v1', false, [], { tag: true }),
];
const indexOf = (g: GraphPayload) => new Map(g.rows.map((r, i) => [r.id, i] as const));

describe('upstreamOf (the file menu ⎇, spec §7)', () => {
  const g = graphOf(labels);
  const up = (sha: string) => upstreamOf(g, indexOf(g), sha);

  it("a branch tip: its label's remote-tracking branch", () => {
    expect(up('c0')).toEqual({ remote: 'origin', branch: 'main' });
  });
  it("a commit below a tip: the branch it belongs to (the graph's membership)", () => {
    expect(up('c2')).toEqual({ remote: 'origin', branch: 'main' });
  });
  it('a local branch ahead of its remote: the same-named remote branch, origin first; a remote name may hold "/"', () => {
    expect(up('t0')).toEqual({ remote: 'origin', branch: 'topic' });
    const g2 = graphOf([label(4, 'topic', true, []), label(5, 'topic', false, [remote('up/stream', 'topic')])]);
    expect(upstreamOf(g2, indexOf(g2), 't0')).toEqual({ remote: 'up/stream', branch: 'topic' });
  });
  it('none known: a local-only branch, a commit outside the loaded history', () => {
    expect(up('l0')).toBeNull();
    expect(up('nope')).toBeNull();
  });
});

describe('fileTargetOf', () => {
  const g = graphOf(labels);
  const store = createRepoViewStore(1, '/repo', g, fakeServices());
  const change = (path: string, status = 'M') => ({ path, oldPath: null, status, additions: 1, deletions: 1, old: status === 'A' ? { kind: 'absent' as const } : { kind: 'object' as const, oid: 'a'.repeat(40) }, new: status === 'D' ? { kind: 'absent' as const } : { kind: 'object' as const, oid: 'b'.repeat(40) }, submodule: false });

  it('a commit file: that commit, its branch upstream, the repo as root, a read-only copy to open', () => {
    const spec = { kind: 'commit' as const, id: 'c1', parent: 0 };
    const t = fileTargetOf(store.getState(), spec, targetFor(change('src/a.php'), spec), true);
    expect(t).toMatchObject({ path: 'src/a.php', root: '/repo', sha: 'c1', upstream: { remote: 'origin', branch: 'main' }, changed: true, deleted: false });
    expect(t.openIn).toEqual({ worktree: '/repo', path: 'src/a.php', line: null, source: { kind: 'object', oid: 'b'.repeat(40) }, fallback: null });
  });

  it('a file the commit deleted points at the parent (where it still exists)', () => {
    const spec = { kind: 'commit' as const, id: 'c1', parent: 0 };
    expect(fileTargetOf(store.getState(), spec, targetFor(change('gone.txt', 'D'), spec), true)).toMatchObject({ sha: 'c2', deleted: true });
  });

  it("a WIP file: no commit, the worktree as root, the working-tree file to open, HEAD's upstream", () => {
    const spec = { kind: 'wip' as const, worktree: '/wt/main', staged: true };
    const t = fileTargetOf(store.getState(), spec, targetFor(change('src/a.php'), spec), true);
    expect(t).toMatchObject({ sha: null, root: '/wt/main', upstream: { remote: 'origin', branch: 'main' } });
    expect(t.openIn).toEqual({ worktree: '/wt/main', path: 'src/a.php', line: null, source: { kind: 'worktree', worktree: '/wt/main' }, fallback: { kind: 'object', oid: 'b'.repeat(40) } });
  });

  it('compares: the "to" side; with the working tree, none', () => {
    const spec = { kind: 'compare' as const, from: 'c2', to: 't0' };
    expect(fileTargetOf(store.getState(), spec, targetFor(change('x'), spec), true)).toMatchObject({ sha: 't0', upstream: { remote: 'origin', branch: 'topic' } });
    const wt = { kind: 'worktree' as const, from: 'c2', worktree: '/wt/main' };
    expect(fileTargetOf(store.getState(), wt, targetFor(change('x'), wt), true)).toMatchObject({ sha: null, root: '/wt/main' });
  });

  it('K99: a commit that is a linked worktree\'s HEAD resolves against that worktree; other commits against the repo', () => {
    const g2 = graphOf([...labels, label(3, 'agent', true, [], { worktree: '/wt/agent' })]);
    const st = createRepoViewStore(1, '/repo', g2, fakeServices());
    const at = (id: string) => ({ kind: 'commit' as const, id, parent: 0 });
    const root = (id: string) => fileTargetOf(st.getState(), at(id), targetFor(change('a.php'), at(id)), true);
    expect(root('c2')).toMatchObject({ root: '/wt/agent' });
    expect(root('c2').openIn.worktree).toBe('/wt/agent');
    expect(root('c1').root).toBe('/repo');
    expect(folderTargetOf(st.getState(), at('c2'), 'src', 'src/a.php')).toMatchObject({ root: '/wt/agent' });
    expect(folderTargetOf(st.getState(), at('c1'), 'src', 'src/a.php')).toMatchObject({ root: '/repo' });
    // Copy path ▸ Abs copies the path in that worktree too.
    const rows = buildMenu<FileTarget, MenuEnv>('file', root('c2'), fileMenuEnv(st));
    const copy = rows.find((r) => r.kind === 'action' && r.id === 'file.copyPath');
    copyText.mockClear();
    (copy as Extract<MenuRow, { kind: 'action' }>).variants!.find((v) => v.id === 'abs')!.run();
    expect(copyText).toHaveBeenCalledWith('/wt/agent/a.php');
  });

  it("K99: a linked worktree's WIP row resolves against that worktree", () => {
    const spec = { kind: 'wip' as const, worktree: '/wt/other', staged: false };
    expect(folderTargetOf(store.getState(), spec, 'src', 'src/a.php')).toMatchObject({ root: '/wt/other' });
  });

  it('an unchanged file from "View all files": its commit', () => {
    const spec = { kind: 'commit' as const, id: 'c0', parent: 0 };
    expect(fileTargetOf(store.getState(), spec, fileViewTarget('README.md', 'c0', spec), false)).toMatchObject({ sha: 'c0', changed: false });
  });
});

// Fix round 1, item 7: direct unit tests for `compare` and `copyMessage` (the commit menu's
// actions), not only through `fileMenuEnv`'s mocked `act`.
describe('compare (the commit menu\'s Compare with HEAD / Compare with working tree)', () => {
  afterEach(() => copyText.mockClear());

  it('two commits (Compare with HEAD): selects both, from → to; the anchor and the keyboard stay on `from` (K27)', () => {
    const store = createRepoViewStore(1, '/repo', graphOf(labels), fakeServices());
    compare(store, 'c1', 'c2');
    const s = store.getState();
    expect(s.selection).toMatchObject({ kind: 'compare', from: 'c1', to: 'c2' });
    const i = s.indexById.get('c1')!;
    expect([s.picks.anchor, s.picks.cursor]).toEqual([i, i]);
    s.exitCompare();
    expect(store.getState().selection).toMatchObject({ kind: 'commit', id: 'c1' });
  });

  it('with the working tree: the open worktree, its WIP row picked too', () => {
    const store = createRepoViewStore(1, '/repo', { ...graphOf(labels), openWorktree: '/wt/main' }, fakeServices());
    compare(store, 'c0', 'worktree');
    const s = store.getState();
    expect(s.selection).toMatchObject({ kind: 'compareWorktree', from: 'c0', worktree: '/wt/main' });
    expect(s.picks.rows).toEqual([s.indexById.get('c0'), 0]);
  });

  it("with the working tree: the open worktree even when it's clean and another worktree's WIP row is the only one (K37)", () => {
    const g = graphOf(labels);
    const linked = { ...g.rows[0], id: 'wip:/wt/linked', wip: { ...g.rows[0].wip!, worktreePath: '/wt/linked', worktreeName: 'linked' } };
    const store = createRepoViewStore(1, '/repo', { ...g, rows: [linked, ...g.rows.slice(1)], openWorktree: '/wt/main' }, fakeServices());
    compare(store, 'c0', 'worktree');
    const s = store.getState();
    expect(s.selection).toMatchObject({ kind: 'compareWorktree', from: 'c0', worktree: '/wt/main' });
    expect(s.picks.rows).toEqual([s.indexById.get('c0')]);
  });

  it('with the working tree, no open worktree reported: the tab\'s own path', () => {
    const store = createRepoViewStore(1, '/repo', graphOf(labels), fakeServices());
    compare(store, 'c0', 'worktree');
    expect(store.getState().selection).toMatchObject({ kind: 'compareWorktree', from: 'c0', worktree: '/repo' });
  });

  it('an id outside the loaded history: does nothing', () => {
    const store = createRepoViewStore(1, '/repo', graphOf(labels), fakeServices());
    compare(store, 'nope', 'alsoNope');
    expect(store.getState().selection).toEqual({ kind: 'none' });
  });
});

describe('copyMessage', () => {
  afterEach(() => { copyText.mockClear(); useToast.setState({ message: null }); });

  it('a cached message: the summary and body, joined by a blank line', async () => {
    const msg: CommitMessage = { id: 'c1', summary: 'Fix typo', body: 'Details here.' };
    const cache = createCommitMessageCache(async () => msg);
    await cache.get('c1'); // warms the cache, so `copyMessage` finds it already `peek`-able.
    const store = createRepoViewStore(1, '/repo', graphOf(labels), fakeServices({ messages: cache }));
    copyMessage(store, 'c1');
    await vi.waitFor(() => expect(copyText).toHaveBeenCalledWith('Fix typo\n\nDetails here.'));
    expect(useToast.getState().message).toBe('Copied');
  });

  it('a summary with no body: just the summary, and it loads first if not cached', async () => {
    const load = vi.fn(async (): Promise<CommitMessage> => ({ id: 'c2', summary: 'No body here', body: '' }));
    const store = createRepoViewStore(1, '/repo', graphOf(labels), fakeServices({ messages: createCommitMessageCache(load) }));
    copyMessage(store, 'c2');
    expect(load).toHaveBeenCalledWith('c2');
    await vi.waitFor(() => expect(copyText).toHaveBeenCalledWith('No body here'));
  });

  it('a failed load: a "Copy failed" toast, nothing copied', async () => {
    const store = createRepoViewStore(1, '/repo', graphOf(labels), fakeServices({ messages: createCommitMessageCache(async () => { throw new Error('boom'); }) }));
    copyMessage(store, 'c3');
    await vi.waitFor(() => expect(useToast.getState().message).toBe('Copy failed'));
    expect(copyText).not.toHaveBeenCalled();
  });
});

describe('monacoTargetOf (the Monaco menu\'s target)', () => {
  const g = graphOf(labels);
  const store = createRepoViewStore(1, '/repo', g, fakeServices());
  const spec = { kind: 'commit' as const, id: 'c1', parent: 0 };
  const change = (path: string) => ({ path, oldPath: null, status: 'M', additions: 1, deletions: 1, old: { kind: 'object' as const, oid: 'a'.repeat(40) }, new: { kind: 'object' as const, oid: 'b'.repeat(40) }, submodule: false });
  const diff = targetFor(change('src/a.php'), spec);
  const event = (over: Partial<EditorContextMenuEvent> = {}): EditorContextMenuEvent => ({ path: diff.path, side: 'modified', line: 5, selection: null, selectionText: '', x: 0, y: 0, ...over });

  it('no diff open: null', () => {
    expect(monacoTargetOf(store.getState(), event())).toBeNull();
  });

  it("the modified side: the commit's own sha, its branch upstream, a single-line location", () => {
    store.setState({ diff });
    const t = monacoTargetOf(store.getState(), event({ line: 5 }));
    expect(t).toMatchObject({ path: 'src/a.php', sha: 'c1', lines: [5, 5], upstream: { remote: 'origin', branch: 'main' } });
    expect(t!.openIn).toEqual({ worktree: '/repo', path: 'src/a.php', line: 5, source: diff.new, fallback: null });
  });

  it("the original side: the commit's parent (the version it diffs against), same branch/upstream", () => {
    store.setState({ diff });
    const t = monacoTargetOf(store.getState(), event({ side: 'original' }));
    expect(t).toMatchObject({ sha: 'c2', upstream: { remote: 'origin', branch: 'main' } });
  });

  it('a multi-line selection: both line numbers, and the selected text', () => {
    store.setState({ diff });
    const t = monacoTargetOf(store.getState(), event({ selection: { startLine: 5, endLine: 7 }, selectionText: 'enum Suit…' }));
    expect(t).toMatchObject({ lines: [5, 7], selectionText: 'enum Suit…' });
  });
});

// Plan 1C Task 15b: the sidebar's configured upstream, and the sidebar item menus.
describe('upstreamOf with the sidebar (configured upstreams)', () => {
  const g = graphOf(labels);
  const local = (name: string, upstream: string | null, gone = false) => ({ name, fullName: `refs/heads/${name}`, target: 't', upstream, ahead: 0, behind: 0, gone, tipTime: 0, summary: '', author: '', isHead: false, worktree: null });
  const sidebarOf = (locals: ReturnType<typeof local>[]) => ({ locals, remotes: [{ name: 'origin', host: null, hostKind: 'gitlab' as const, branches: [] }, { name: 'up/stream', host: null, hostKind: 'generic' as const, branches: [] }], worktrees: [], stashes: [], tags: [] });

  it('splits a remote ref by the sidebar remote names (a name may hold "/")', () => {
    expect(splitRemoteRef('refs/remotes/up/stream/feat/x', ['origin', 'up/stream'])).toEqual({ remote: 'up/stream', branch: 'feat/x' });
    expect(splitRemoteRef('refs/remotes/origin/main', [])).toEqual({ remote: 'origin', branch: 'main' });
    expect(splitRemoteRef('refs/heads/main', ['origin'])).toBeNull();
  });

  it("a local branch's configured upstream beats the same-named inference", () => {
    const sb = sidebarOf([local('main', 'refs/remotes/origin/other'), local('topic', 'refs/remotes/up/stream/topic-2')]);
    expect(upstreamOf(g, indexOf(g), 'c0', sb)).toEqual({ remote: 'origin', branch: 'other' });
    expect(upstreamOf(g, indexOf(g), 't0', sb)).toEqual({ remote: 'up/stream', branch: 'topic-2' });
    // Below the tip, through the first-parent membership.
    expect(upstreamOf(g, indexOf(g), 'c2', sb)).toEqual({ remote: 'origin', branch: 'other' });
  });

  it('a branch with no upstream (or a gone one) has none; one the sidebar does not know is inferred', () => {
    const sb = sidebarOf([local('topic', null), local('lone', 'refs/remotes/origin/lone', true)]);
    expect(upstreamOf(g, indexOf(g), 't0', sb)).toBeNull();
    expect(upstreamOf(g, indexOf(g), 'l0', sb)).toBeNull();
    // `main` isn't in this sidebar: inferred from its own tip label, as before.
    expect(upstreamOf(g, indexOf(g), 'c0', sb)).toEqual({ remote: 'origin', branch: 'main' });
  });

  it('a branch the sidebar knows with no upstream gets none, even with a same-named remote branch at its tip', () => {
    const sb = sidebarOf([local('main', null)]);
    expect(upstreamOf(g, indexOf(g), 'c0', sb)).toBeNull();
    expect(upstreamOf(g, indexOf(g), 'c2', sb)).toBeNull();
  });

  it('fileTargetOf reads the open tab\'s sidebar', () => {
    const store = createRepoViewStore(7, '/repo', g, fakeServices());
    useRuntime.setState({ tabs: { t: { repo: { id: 7 }, sidebar: sidebarOf([local('main', 'refs/remotes/origin/other')]) } as never } });
    const spec = { kind: 'commit' as const, id: 'c1', parent: 0 };
    const change = { path: 'a', oldPath: null, status: 'M', additions: 1, deletions: 1, old: { kind: 'absent' as const }, new: { kind: 'object' as const, oid: 'b'.repeat(40) }, submodule: false };
    expect(fileTargetOf(store.getState(), spec, targetFor(change, spec), true).upstream).toEqual({ remote: 'origin', branch: 'other' });
    useRuntime.setState({ tabs: {} });
  });
});

describe('the sidebar item menus', () => {
  const g = graphOf(labels);
  const store = () => createRepoViewStore(7, '/repo', g, fakeServices({ remotesSnapshot: () => [{ name: 'origin', host: 'gitlab.example.com', path: 'acme/shop', hostKind: 'gitlab' as const }] }));
  const side = (over: object = {}) => ({ locals: [], remotes: [{ name: 'origin', hostKind: 'gitlab' as const, branches: [] }], worktrees: [], stashes: [], tags: [], ...over });
  const info = { remotes: [{ name: 'origin', url: 'ssh://gitlab.example.com/acme/shop.git', host: 'gitlab.example.com', path: 'acme/shop', hostKind: 'gitlab' as const }], mainWorktree: null, commonDir: '/repo/.git' };
  const item = (kind: string, extra: object): SideItem => ({ key: 'k', kind, name: 'x', target: 'c1', time: 0, ...extra }) as SideItem;
  const labelsOf = (rows: MenuRow[]) => rows.map((r) => (r.kind === 'separator' ? '---' : r.label));
  const branchLocal = { name: 'main', fullName: 'refs/heads/main', target: 'c0', upstream: 'refs/remotes/origin/main', ahead: 0, behind: 0, gone: false, tipTime: 0, summary: '', author: '', isHead: true, worktree: null };
  beforeEach(() => useRuntime.setState({ tabs: { t: { repo: { id: 7 }, sidebar: side(), info } as never } }));
  afterEach(() => useRuntime.setState({ tabs: {} }));

  it("a local branch: the branch label's commit menu (its upstream as the Remote copy) and Show in graph", () => {
    const rows = sidebarItemMenu(store(), item('local', { name: 'main', target: 'c0', branch: branchLocal }))();
    expect(labelsOf(rows)).toEqual(['Copy branch name', 'Copy SHA', 'Copy message', 'Forge link', '---', 'Compare with HEAD', '---', 'Show in graph']);
    const copy = rows.find((r) => r.kind === 'action' && r.label === 'Copy branch name') as Extract<MenuRow, { kind: 'action' }>;
    expect(copy.variants!.find((v) => v.id === 'remote')!.disabledReason).toBeUndefined();
    expect(copy.variants!.find((v) => v.id === 'local')!.disabledReason).toBeUndefined();
  });

  it('a remote branch: no local copy; the name is remote/branch', () => {
    const rows = sidebarItemMenu(store(), item('remote', { name: 'topic', remote: 'origin', target: 't1', branch: { name: 'topic', fullName: 'refs/remotes/origin/topic', target: 't1', tipTime: 0, summary: '', author: '' } }))();
    const copy = rows.find((r) => r.kind === 'action' && r.label === 'Copy branch name') as Extract<MenuRow, { kind: 'action' }>;
    expect(copy.tooltip).toBe('Copy "origin/topic"');
    expect(copy.variants!.find((v) => v.id === 'local')!.disabledReason).toBe('No local branch');
  });

  it('a tag, a stash and a worktree', () => {
    expect(labelsOf(sidebarItemMenu(store(), item('tag', { name: 'v1', target: 'c1', tag: { name: 'v1', fullName: 'refs/tags/v1', target: 'c1', time: 0 } }))())).toEqual(['Copy tag name', '---', 'Forge link', '---', 'Show in graph']);
    expect(labelsOf(sidebarItemMenu(store(), item('stash', { target: 'c1', stash: { index: 0, id: 'c1', message: 'WIP', time: 0 } }))())).toEqual(['Copy SHA', 'Copy message', '---', 'Show in graph']);
    const wt = { path: '/wt/x', name: 'x', branch: 'x', head: 'c1', isMain: false, isCurrent: false };
    expect(labelsOf(sidebarItemMenu(store(), item('worktree', { target: 'c1', worktree: wt }))())).toEqual(['Copy path', 'Copy branch name', 'Copy SHA', '---', 'Open in file manager', '---', 'Show in graph']);
  });

  it('a remote: its name, redacted URL from the repo info, and its project page', () => {
    const rows = sidebarRemoteMenu(store(), 'origin')();
    expect(labelsOf(rows)).toEqual(['Copy remote name', 'Copy URL', '---', 'Forge link']);
    expect((rows.find((r) => r.kind === 'action' && r.label === 'Copy URL') as Extract<MenuRow, { kind: 'action' }>).disabledReason).toBeUndefined();
  });
});
