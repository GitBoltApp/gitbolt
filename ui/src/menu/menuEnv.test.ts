import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RowPayload } from '../api/gen/RowPayload';
import { createCommitMessageCache } from '../api/commitMessages';
import type { CommitMessage } from '../api/gen/CommitMessage';
import type { EditorContextMenuEvent } from '../diff/monaco/host';
import { createRepoViewStore, fileViewTarget, targetFor } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { useToast } from '../ui/toast';
import { compare, copyMessage, fileTargetOf, monacoTargetOf, upstreamOf } from './menuEnv';

// `compare`/`copyMessage` reach the real clipboard (api/transport); fix round 1, item 7's unit
// tests for them mock it, as DiffPanel.openIn.test.tsx and others do.
const copyText = vi.hoisted(() => vi.fn(async (_text: string) => {}));
vi.mock('../api/transport', () => ({ copyText }));

const row = (id: string, parents: string[], wip: string | null = null): RowPayload => ({
  id, kind: wip ? 'wip' : 'commit', lane: 0, color: 0, segments: [], summary: id, bodyFirstLine: '', authorName: '', authorEmail: '', authorTime: 0, committerTime: 0, parents, mrRefs: [],
  wip: wip ? { worktreePath: wip, worktreeName: null, modified: 1, added: 0, deleted: 0, renamed: 0, conflicted: 0 } : null,
});
const remote = (remote: string, branch: string) => ({ fullName: `refs/remotes/${remote}/${branch}`, remote, hostKind: 'gitlab' as const });
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
