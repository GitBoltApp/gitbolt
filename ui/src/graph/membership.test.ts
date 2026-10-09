import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RowPayload } from '../api/gen/RowPayload';
import { branchMembership, branchRows, chipRefs, labelsByRow } from './membership';

type Spec = [id: string, lane: number, parents: string[], kind?: RowPayload['kind']];
const rowsOf = (specs: Spec[]): RowPayload[] => specs.map(([id, lane, parents, kind = parents.length > 1 ? 'merge' : 'commit']) => ({
  id, kind, lane, color: lane, segments: [], summary: id, bodyFirstLine: '', authorName: '', authorEmail: '', authorTime: 0, committerTime: 0, parents, mrRefs: [], wip: null,
}));
const rows = (...specs: Spec[]) => rowsOf(specs);
const local = (row: number, name: string): RefLabel => ({ row, name, local: `refs/heads/${name}`, remotes: [], tag: false, isHead: false, worktree: null, checkedOut: null });
const remoteOnly = (row: number, remote: string, name: string): RefLabel => ({ row, name, local: null, remotes: [{ fullName: `refs/remotes/${remote}/${name}`, remote, host: null, hostKind: 'generic' }], tag: false, isHead: false, worktree: null, checkedOut: null });
const tag = (row: number, name: string): RefLabel => ({ row, name, local: null, remotes: [], tag: true, isHead: false, worktree: null, checkedOut: null });
const detachedHead = (row: number): RefLabel => ({ row, name: 'HEAD', local: null, remotes: [], tag: false, isHead: true, worktree: null, checkedOut: null });

const names = (r: RowPayload[], labels: RefLabel[]) => branchMembership(r, labelsByRow(labels)).map((m) => m?.name ?? null);

describe('branchMembership', () => {
  it('names the branch at the top of a first-parent lane for every non-tip commit, and nothing for the tip', () => {
    const r = rows(['d', 0, ['c']], ['c', 0, ['b']], ['b', 0, ['a']], ['a', 0, []]);
    expect(names(r, [local(0, 'main')])).toEqual([null, 'main', 'main', 'main']);
  });

  it('a stale, fast-forwarded branch on the trunk doesn\'t rename older history; its own row gets the trunk\'s chip too', () => {
    const r = rows(['e', 0, ['d']], ['d', 0, ['c']], ['c', 0, ['b']], ['b', 0, ['a']], ['a', 0, []]);
    expect(names(r, [local(0, 'main'), local(3, 'old')])).toEqual([null, 'main', 'main', 'main', 'main']);
  });

  it('a lane whose tip has no branch (merged and deleted) falls back to the nearest branch up the chain', () => {
    // feature lane (1): F3 (unlabeled tip) <- F2 (feat) <- F1.
    const r = rows(['M', 0, ['A', 'F3']], ['F3', 1, ['F2']], ['F2', 1, ['F1']], ['A', 0, ['B']], ['F1', 1, ['B']], ['B', 0, []]);
    expect(names(r, [local(0, 'main'), local(2, 'feat')])).toEqual([null, null, null, 'main', 'feat', 'main']);
  });

  it('a row that is the tip of the membership branch gets none, whatever else it carries', () => {
    const r = rows(['b', 0, ['a']], ['a', 0, []]);
    expect(names(r, [tag(0, 'v1'), local(0, 'main')])).toEqual([null, 'main']);
  });

  it('prefers a local branch at the tip, else the remote one by its short name (no refs/ prefix)', () => {
    const r = rows(['b', 0, ['a']], ['a', 0, []]);
    expect(names(r, [remoteOnly(0, 'origin', 'x'), local(0, 'y')])).toEqual([null, 'y']);
    expect(names(r, [tag(0, 'v1'), remoteOnly(0, 'origin', 'feature/x')])).toEqual([null, 'origin/feature/x']);
  });

  it('follows each lane: a merged branch\'s commits name it, the trunk\'s name the trunk', () => {
    // M merges F2 into main; F1/F2 are feature's lane (1), A/B main's (0).
    const r = rows(['M', 0, ['A', 'F2']], ['F2', 1, ['F1']], ['A', 0, ['B']], ['F1', 1, ['B']], ['B', 0, []]);
    expect(names(r, [local(0, 'main'), local(1, 'feature')])).toEqual([null, null, 'main', 'feature', 'main']);
  });

  it('shows nothing where no branch can be determined (a deleted branch, detached HEAD, tags only)', () => {
    // feature was merged and deleted: its lane (1) tops out in F2, which nothing labels.
    const r = rows(['M', 0, ['A', 'F2']], ['F2', 1, ['F1']], ['A', 0, []], ['F1', 1, []]);
    expect(names(r, [local(0, 'main')])).toEqual([null, null, 'main', null]);
    const detached = rows(['h', 0, ['g']], ['g', 0, []]);
    expect(names(detached, [detachedHead(0), tag(0, 'v2')])).toEqual([null, null]);
  });

  it('a tag is not a branch: a tag-only row gets the dimmed chip (after its tag) and history walks on through it', () => {
    const r = rows(['c', 0, ['b']], ['b', 0, ['a']], ['a', 0, []]);
    expect(names(r, [local(0, 'main'), tag(1, 'v1')])).toEqual([null, 'main', 'main']);
  });

  it('a stash or WIP row stacked on a commit never continues its lane; another first-parent child does', () => {
    // The stash took X's lane (0); main's tip T curves in from lane 1.
    const r = rows(['S', 0, ['X'], 'stash'], ['W', 1, ['T'], 'wip'], ['T', 1, ['X']], ['X', 0, []]);
    expect(names(r, [local(2, 'main')])).toEqual([null, null, null, 'main']);
  });

  it('claimant order: the trunk\'s local branch first, then HEAD\'s (no trunk), else the newest local tip', () => {
    // hotfix H forks from main's tip M. Lanes don't matter: only first parents and the order.
    const r = rows(['H', 0, ['M']], ['M', 0, ['A']], ['A', 0, []]);
    const labels = [local(0, 'hotfix'), local(1, 'main')];
    expect(branchMembership(r, labelsByRow(labels), ['refs/remotes/origin/main']).map((m) => m?.name ?? null)).toEqual([null, null, 'main']);
    expect(branchMembership(r, labelsByRow(labels), ['refs/heads/main']).map((m) => m?.name ?? null)).toEqual([null, null, 'main']);
    expect(names(r, [local(0, 'hotfix'), { ...local(1, 'main'), isHead: true }])).toEqual([null, null, 'main']);
    // No trunk and no HEAD branch: the newest local tip claims first.
    expect(names(r, labels)).toEqual([null, 'hotfix', 'hotfix']);
  });

  it('a remote whose branch has a local counterpart (upstream/main) claims only after every other branch', () => {
    const r = rows(['U', 1, ['M']], ['M', 0, ['A']], ['A', 0, []]);
    const labels = [remoteOnly(0, 'upstream', 'main'), local(1, 'main')];
    expect(names(r, labels)).toEqual([null, null, 'main']);
  });

  it('the pinned ref claims right after the trunk\'s local branch, before the other local branches', () => {
    // main (HEAD) is behind origin/main (O2); feature forks off O2.
    const r = rows(['F', 1, ['O2']], ['O2', 0, ['O1']], ['O1', 0, ['M']], ['M', 0, []]);
    const labels = [local(0, 'feature'), remoteOnly(1, 'origin', 'main'), { ...local(3, 'main'), isHead: true }];
    expect(branchMembership(r, labelsByRow(labels), ['refs/remotes/origin/main']).map((m) => m?.name ?? null)).toEqual([null, null, 'origin/main', null]);
  });

  it('the pinned pair\'s remote branch (the payload\'s pinnedRefs) claims right after its local one', () => {
    // main (pinned, HEAD) is behind upstream/main (U2); feature forks off U2. origin/main, a
    // same-named branch on another remote, is not the pair's: the payload names upstream's.
    const r = rows(['F', 1, ['U2']], ['O', 2, ['M']], ['U2', 0, ['U1']], ['U1', 0, ['M']], ['M', 0, []]);
    const labels = [local(0, 'feature'), remoteOnly(1, 'origin', 'main'), remoteOnly(2, 'upstream', 'main'), { ...local(4, 'main'), isHead: true }];
    const names = (pinnedRefs: string[]) => branchMembership(r, labelsByRow(labels), pinnedRefs).map((m) => m?.name ?? null);
    expect(names(['refs/heads/main', 'refs/remotes/upstream/main'])).toEqual([null, null, null, 'upstream/main', null]);
    // A local `trunk` tracking origin/main: the pair whatever the names.
    const trunk = [local(0, 'feature'), remoteOnly(2, 'origin', 'main'), { ...local(4, 'trunk'), isHead: true }];
    expect(branchMembership(r, labelsByRow(trunk), ['refs/heads/trunk', 'refs/remotes/origin/main']).map((m) => m?.name ?? null)).toEqual([null, null, null, 'origin/main', null]);
  });

  it('a local branch pinned alone (no upstream): the remote branches named like it stand in', () => {
    const r = rows(['F', 1, ['O2']], ['O2', 1, ['O1']], ['O1', 1, ['M']], ['M', 0, []]);
    const labels = [local(0, 'feature'), remoteOnly(1, 'origin', 'main'), { ...local(3, 'main'), isHead: true }];
    expect(branchMembership(r, labelsByRow(labels), ['refs/heads/main']).map((m) => m?.name ?? null)).toEqual([null, null, 'origin/main', null]);
  });

  it('a pinned override that isn\'t a branch ref (a tag) falls back to HEAD\'s branch first', () => {
    const r = rows(['H', 0, ['M']], ['M', 0, ['A']], ['A', 0, []]);
    const labels = [local(0, 'hotfix'), { ...local(1, 'main'), isHead: true }, tag(1, 'v1')];
    expect(branchMembership(r, labelsByRow(labels), ['refs/tags/v1']).map((m) => m?.name ?? null)).toEqual([null, null, 'main']);
  });

  it('tags never claim', () => {
    const r = rows(['b', 0, ['a']], ['a', 0, []]);
    expect(names(r, [tag(0, 'v1')])).toEqual([null, null]);
  });

  it('a branch tip that landed on a merge\'s second-parent lane still follows its first-parent child', () => {
    // M's second parent Ft took lane 1 first; feature's newer commit F2 (lane 2) curves into it.
    const r = rows(['M', 0, ['A', 'Ft']], ['F2', 2, ['Ft']], ['A', 0, []], ['Ft', 1, []]);
    expect(names(r, [local(0, 'main'), local(1, 'feature')])).toEqual([null, null, 'main', 'feature']);
  });

  it('carries the tip\'s lane colour, and shares one object per tip (stable props for memoized rows)', () => {
    const r = rows(['c', 3, ['b']], ['b', 3, ['a']], ['a', 3, []]);
    const m = branchMembership(r, labelsByRow([local(0, 'main')]));
    expect(m[1]).toEqual({ name: 'main', color: 3, ref: 'refs/heads/main' });
    expect(m[2]).toBe(m[1]);
  });

  it('is linear: a constant number of row and label reads per row on a 100k-row deep history (no per-row walk, no recursion)', () => {
    const n = 100_000;
    const specs: Spec[] = Array.from({ length: n }, (_, i) => [`c${i}`, i % 2, i + 2 < n ? [`c${i + 2}`] : []]);
    let reads = 0;
    const counted = rowsOf(specs).map((row) => new Proxy(row, { get: (t, k) => { reads++; return t[k as keyof RowPayload]; } }));
    let labelGets = 0;
    class CountingMap<K, V> extends Map<K, V> { override get(k: K) { labelGets++; return super.get(k); } }
    const labels = new CountingMap(labelsByRow([local(0, 'even'), local(1, 'odd')]));
    const m = branchMembership(counted, labels);
    expect(m[n - 2]?.name).toBe('even');
    expect(m[n - 1]?.name).toBe('odd');
    // A walk up the chain per row would read ~n/2 rows each (billions here).
    expect(reads / n).toBeLessThanOrEqual(12);
    expect(labelGets / n).toBeLessThanOrEqual(2);
  });
});

describe('labelsByRow', () => {
  it('groups labels by row, keeping their order', () => {
    const m = labelsByRow([local(0, 'a'), tag(2, 't'), local(0, 'b')]);
    expect(m.get(0)!.map((l) => l.name)).toEqual(['a', 'b']);
    expect(m.get(2)!.map((l) => l.name)).toEqual(['t']);
    expect(m.has(1)).toBe(false);
  });
});

/**
 * Real layouts: `testdata/graph-membership.json` is generated by gitbolt-core's
 * `snapshot::tests::membership_vectors` through the actual `build_graph` (default_trunk pinning
 * of the local main, layout.rs lanes), so these cases have the lanes the app really draws.
 */
type Vector = { name: string; rows: { id: string; kind: RowPayload['kind']; lane: number; color: number; parents: string[] }[]; labels: RefLabel[]; pinnedRefs: string[] };
const vectors = (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../testdata/graph-membership.json'), 'utf8')) as { cases: Vector[] }).cases;

describe('branchMembership on real layouts', () => {
  /** Expected membership per row, by commit summary (null: none). */
  const expected: Record<string, Record<string, string | null>> = {
    // The pinned local main's unpushed M1 is on the trunk's lane 0, above origin/main's O.
    'main ahead of pinned origin/main': { M1: null, O: 'main', base: 'main' },
    // feat@F3 on lane 2; origin/feat@F2 on lane 1 (where M's second-parent line put it).
    'feature tip on its own lane after main merged its pushed part': { M: null, F3: null, F2: 'feat', F1: 'feat', base: 'main' },
    'feature tip merged back, then continued': { F3: null, M: null, A: 'main', F2: 'feat', F1: 'feat', base: 'main' },
    // The pinned hotfix case: hotfix (lane 1) forks off main's tip (lane 0) and must not take
    // over main's history.
    "hotfix off pinned main's tip": { H: null, M: null, base: 'main' },
    // A remote-only branch forked off main's tip stops there too.
    "remote-only branch off pinned main's tip": { T: null, M: null, base: 'main' },
    // H (lane 1) is newer than the pinned main's unpushed M1 (lane 0).
    "hotfix from origin/main committed after main's unpushed M1": { H: null, M1: null, O: 'main', base: 'main' },
    // upstream is the root remote (convention): local main, though it tracks origin (the fork),
    // is upstream/main's counterpart and the trunk (lane 0), pinned with the origin/main it
    // tracks (same commit); upstream/main (lane 1, unpinned) claims only U.
    'upstream/main one commit ahead (fork workflow)': { U: null, M: null, base: 'main' },
    // No remote: the local main is the trunk (lane 0); hotfix forks off its tip (lane 1).
    "local-only repo (no remote) pins main: hotfix off main's tip, main checked out": { H: null, M: null, base: 'main' },
    // No trunk: HEAD's branch (work) claims first, though hotfix took work's own lane 0.
    "unpinned repo (no remote, no main): hotfix off work's tip, work checked out": { H: null, W: null, base: 'work' },
    "feature/main off pinned main's tip": { FM: null, M: null, base: 'main' },
    // `old` stays on the trunk behind main: its row gets the dimmed "main" after its own chip.
    'stale fast-forwarded branch left on the trunk': { O: null, base: 'main' },
    // The pinned local main is 2 behind origin/main, pinned with it: origin/main's O2, O1 run
    // down lane 0 into M, and feature (lane 1) forks off O2. origin/main claims its own commits
    // before feature can.
    'main behind origin/main, feature off origin/main': { F: null, O2: null, O1: 'origin/main', M: null, base: 'main' },
    // Diverged: main's M in lane 0, origin/main's O2, O1 in lane 1, feature off O2 in lane 2.
    'main diverged from origin/main, feature off origin/main': { F: null, M: null, O2: null, O1: 'origin/main', base: 'main' },
    // The checked-out feature's WIP is row 0 above the newer main (K37): a WIP row has none.
    'dirty feature checked out, older than pinned main': { '// WIP': null, M: null, F: null, base: 'main' },
  };

  it('covers every generated case', () => {
    expect(vectors.map((v) => v.name).sort()).toEqual(Object.keys(expected).sort());
  });

  for (const v of vectors) {
    it(v.name, () => {
      const r = rowsOf(v.rows.map((row): Spec => [row.id, row.lane, row.parents, row.kind]));
      r.forEach((row, i) => { row.color = v.rows[i].color; });
      const got = Object.fromEntries(branchMembership(r, labelsByRow(v.labels), v.pinnedRefs).map((m, i) => [r[i].id, m?.name ?? null]));
      expect(got).toEqual(expected[v.name]);
    });
  }
});

describe('branchRows (J22): the rows a hovered branch chip focuses', () => {
  const sorted = (set: ReadonlySet<number>) => [...set].sort((a, b) => a - b);
  // M merges feat (F2 <- F1) into main (M <- A <- B); feat's tip is F2.
  const r = rows(['M', 0, ['A', 'F2']], ['F2', 1, ['F1']], ['A', 0, ['B']], ['F1', 1, ['B']], ['B', 0, []]);
  const byRow = labelsByRow([local(0, 'main'), local(1, 'feat')]);
  const m = branchMembership(r, byRow);

  it("is the membership algorithm's first-parent claims plus the tip, not all reachable history", () => {
    expect(sorted(branchRows(m, byRow, ['refs/heads/main']))).toEqual([0, 2, 4]);
    // feat: its tip and F1 (B, reachable from feat too, is main's claim).
    expect(sorted(branchRows(m, byRow, ['refs/heads/feat']))).toEqual([1, 3]);
  });

  it("takes a chip's refs (local and remotes) together; a tag, a detached HEAD or an unknown ref focus nothing", () => {
    const withRemote: RefLabel = { ...local(0, 'main'), remotes: [{ fullName: 'refs/remotes/origin/main', remote: 'origin', host: null, hostKind: 'generic' }] };
    expect(chipRefs(withRemote)).toEqual(['refs/heads/main', 'refs/remotes/origin/main']);
    expect(chipRefs(tag(0, 'v1'))).toEqual([]);
    expect(chipRefs(detachedHead(0))).toEqual([]);
    const b2 = labelsByRow([withRemote, local(1, 'feat')]);
    expect(sorted(branchRows(branchMembership(r, b2), b2, chipRefs(withRemote)))).toEqual([0, 2, 4]);
    expect(sorted(branchRows(m, byRow, ['refs/heads/gone']))).toEqual([]);
  });

  it('a branch whose tip another branch claimed (a fast-forwarded one) is just its tip', () => {
    const line = rows(['c', 0, ['b']], ['b', 0, ['a']], ['a', 0, []]);
    const l = labelsByRow([local(0, 'main'), local(1, 'old')]);
    expect(sorted(branchRows(branchMembership(line, l), l, ['refs/heads/old']))).toEqual([1]);
  });
});
