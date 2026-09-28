import { describe, expect, it } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RowPayload } from '../api/gen/RowPayload';
import { createRepoViewStore, fileViewTarget, targetFor } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { fileTargetOf, upstreamOf } from './menuEnv';

const row = (id: string, parents: string[], wip: string | null = null): RowPayload => ({
  id, kind: wip ? 'wip' : 'commit', lane: 0, color: 0, segments: [], summary: id, bodyFirstLine: '', authorName: '', authorEmail: '', authorTime: 0, committerTime: 0, parents, mrRefs: [],
  wip: wip ? { worktreePath: wip, worktreeName: null, modified: 1, added: 0, deleted: 0, conflicted: 0 } : null,
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
