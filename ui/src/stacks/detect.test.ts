// ui/src/stacks/detect.test.ts
import { describe, expect, it } from 'vitest';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RowPayload } from '../api/gen/RowPayload';
import { detectStacks, stackBase, stackFor, stacksOf, type Stack } from './detect';
import { joinNames, shortRef } from './text';

const row = (id: string, parents: string[]): RowPayload => ({
  id, kind: parents.length > 1 ? 'merge' : 'commit', lane: 0, color: 0, segments: [], summary: id, bodyFirstLine: '', authorName: '', authorEmail: '', authorTime: 0, committerTime: 0, parents, mrRefs: [], wip: null,
});
const graph = (specs: Array<[string, string[]]>, labels: RefLabel[]) => ({ rows: specs.map(([id, p]) => row(id, p)), labels });
const local = (r: number, name: string): RefLabel => ({ row: r, name, local: `refs/heads/${name}`, remotes: [], tag: false, isHead: false, worktree: null, checkedOut: null });
const remote = (r: number, remote: string, name: string): RefLabel => ({ row: r, name: `${remote}/${name}`, local: null, remotes: [{ fullName: `refs/remotes/${remote}/${name}`, remote, host: null, hostKind: 'generic' }], tag: false, isHead: false, worktree: null, checkedOut: null });
const BASE = 'refs/remotes/origin/main';
const paths = (s: Stack[]) => s.map((x) => x.branches);

// c ← b ← a ← x ; origin/main moved to m (m ← x); local main still at x.
const chain = () => graph(
  [['c', ['b']], ['b', ['a']], ['a', ['x']], ['m', ['x']], ['x', []]],
  [local(0, 'feature/c'), local(1, 'feature/b'), local(2, 'feature/a'), remote(3, 'origin', 'main'), local(4, 'main')],
);

describe('detectStacks (spec #3 §3.11)', () => {
  it('a chain of local branches above the base, bottom → top', () => {
    expect(detectStacks(chain(), BASE)).toEqual([{ branches: ['feature/a', 'feature/b', 'feature/c'], base: BASE, leftBehind: [] }]);
  });

  it('a branch with no stacked neighbours is not a stack; an unloaded base finds none', () => {
    const g = graph([['a', ['x']], ['m', ['x']], ['x', []]], [local(0, 'solo'), remote(1, 'origin', 'main')]);
    expect(detectStacks(g, BASE)).toEqual([]);
    expect(detectStacks(chain(), 'refs/remotes/origin/nope')).toEqual([]);
  });

  it('forks: one straight path per line, newest top first, each naming the other line as left behind', () => {
    // b2 ← b1 ← a1 ; c1 ← a1 ; a1 ← x ; origin/main at m ← x.
    const g = graph(
      [['b2', ['b1']], ['c1', ['a1']], ['b1', ['a1']], ['a1', ['x']], ['m', ['x']], ['x', []]],
      [local(0, 'feature/b'), local(1, 'feature/c'), local(3, 'feature/a'), remote(4, 'origin', 'main')],
    );
    const stacks = detectStacks(g, BASE);
    expect(paths(stacks)).toEqual([['feature/a', 'feature/b'], ['feature/a', 'feature/c']]);
    expect(stacks.map((s) => s.leftBehind)).toEqual([['feature/c'], ['feature/b']]);
    // The straight path through the branch acted on; at the fork, the newest top's.
    expect(stackFor(stacks, 'feature/c')?.branches).toEqual(['feature/a', 'feature/c']);
    expect(stackFor(stacks, 'feature/a')?.branches).toEqual(['feature/a', 'feature/b']);
    expect(stackFor(stacks, 'main')).toBeNull();
  });

  it('below a fork, stackFor prefers the stack topped by the checked-out branch', () => {
    const g = graph(
      [['b2', ['b1']], ['c1', ['a1']], ['b1', ['a1']], ['a1', ['x']], ['m', ['x']], ['x', []]],
      [local(0, 'feature/b'), local(1, 'feature/c'), local(3, 'feature/a'), remote(4, 'origin', 'main')],
    );
    const stacks = detectStacks(g, BASE);
    expect(stackFor(stacks, 'feature/a', 'feature/c')?.branches).toEqual(['feature/a', 'feature/c']);
    expect(stackFor(stacks, 'feature/a', 'other')?.branches).toEqual(['feature/a', 'feature/b']);
  });

  it('a graph cut through the stack marks it partial (a member below the loaded rows)', () => {
    const cut = graph([['b', ['a']], ['a', ['gone']], ['m', ['x']], ['x', []]], [local(0, 'feature/b'), local(1, 'feature/a'), remote(2, 'origin', 'main')]);
    expect(detectStacks(cut, BASE)[0].partial).toBe(true);
    const oldBranch = graph([['b', ['a']], ['a', ['x']], ['m', ['x']], ['x', []]], [local(0, 'feature/b'), local(1, 'feature/a'), remote(2, 'origin', 'main'), local(99, 'feature/z')]);
    expect(detectStacks(oldBranch, BASE)[0].partial).toBeUndefined(); // an unrelated old branch beyond the loaded rows
    expect(detectStacks(chain(), BASE)[0].partial).toBeUndefined();
  });

  it('a member already merged into the base drops out; the rest still stack', () => {
    // origin/main (m2) merged feature/a (a1): c1 ← b1 ← a1.
    const g = graph(
      [['c1', ['b1']], ['b1', ['a1']], ['m2', ['m1', 'a1']], ['a1', ['x']], ['m1', ['x']], ['x', []]],
      [local(0, 'feature/c'), local(1, 'feature/b'), remote(2, 'origin', 'main'), local(3, 'feature/a')],
    );
    expect(paths(detectStacks(g, BASE))).toEqual([['feature/b', 'feature/c']]);
  });

  it("never makes the base's own local branch a member, even ahead of it (Review Focus 3)", () => {
    const g = graph([['f1', ['m2']], ['m2', ['m1']], ['m1', []]], [local(0, 'feature/x'), local(1, 'main'), remote(2, 'origin', 'main')]);
    expect(detectStacks(g, BASE)).toEqual([]);
    const local3 = graph([['f2', ['f1']], ['f1', ['m2']], ['m2', ['m1']], ['m1', []]], [local(0, 'feature/y'), local(1, 'feature/x'), local(2, 'main'), remote(3, 'origin', 'main')]);
    expect(paths(detectStacks(local3, BASE))).toEqual([['feature/x', 'feature/y']]);
  });

  it('follows first parents: a branch merged in from the side is not stacked', () => {
    // c2 = merge(c1, s1) ; c1 ← a1 ; s1 ← x (side) ; a1 ← x.
    const g = graph(
      [['c2', ['c1', 's1']], ['c1', ['a1']], ['s1', ['x']], ['a1', ['x']], ['m', ['x']], ['x', []]],
      [local(0, 'feature/c'), local(2, 'side'), local(3, 'feature/a'), remote(4, 'origin', 'main')],
    );
    expect(detectStacks(g, BASE)).toEqual([{ branches: ['feature/a', 'feature/c'], base: BASE, leftBehind: [] }]);
  });

  it('branches on the same commit chain by name', () => {
    const g = graph([['a', ['x']], ['m', ['x']], ['x', []]], [local(0, 'feature/two'), local(0, 'feature/one'), remote(1, 'origin', 'main')]);
    expect(paths(detectStacks(g, BASE))).toEqual([['feature/one', 'feature/two']]);
  });

  it('stacksOf caches per payload and base', () => {
    const g = chain();
    expect(stacksOf(g, BASE)).toBe(stacksOf(g, BASE));
    expect(stacksOf(g, null)).toEqual([]);
  });
});

describe('stackBase', () => {
  const labels = (...refs: string[]) => ({ labels: refs.map((r, i) => (r.startsWith('refs/heads/') ? local(i, r.slice(11)) : remote(i, r.split('/')[2], r.split('/').slice(3).join('/')))) });
  it("the remote's default branch, origin first; else main/master/trunk on a remote; else a local one", () => {
    expect(stackBase(labels('refs/remotes/origin/develop', 'refs/remotes/origin/main'), [{ name: 'origin', defaultBranch: 'refs/remotes/origin/develop' }])).toBe('refs/remotes/origin/develop');
    expect(stackBase(labels('refs/remotes/origin/main'), [{ name: 'origin', defaultBranch: 'refs/remotes/origin/gone' }])).toBe('refs/remotes/origin/main');
    expect(stackBase(labels('refs/remotes/upstream/main', 'refs/remotes/origin/main'), [{ name: 'upstream' }, { name: 'origin' }])).toBe('refs/remotes/origin/main');
    // No sidebar yet: the remote names come from the graph's labels.
    expect(stackBase(labels('refs/remotes/upstream/master'), [])).toBe('refs/remotes/upstream/master');
    expect(stackBase(labels('refs/heads/trunk'), [])).toBe('refs/heads/trunk');
    expect(stackBase(labels('refs/heads/dev'), [])).toBeNull();
  });
});

describe('text', () => {
  it('short refs and name lists', () => {
    expect(shortRef('refs/remotes/origin/main')).toBe('origin/main');
    expect(shortRef('refs/heads/feature/a')).toBe('feature/a');
    expect([joinNames([]), joinNames(['a']), joinNames(['a', 'b']), joinNames(['a', 'b', 'c'])]).toEqual(['', 'a', 'a and b', 'a, b and c']);
  });
});
