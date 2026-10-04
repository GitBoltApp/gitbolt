import { describe, expect, it } from 'vitest';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { Stack } from '../../stacks/detect';
import { afterMerge, firstAfterMerge, MAX_CHAIN, mrChain, stackLine, type StackEnv } from './chain';

const mr = (number: number, source: string, target: string, state: ForgeMr['state'] = 'open', over: Partial<ForgeMr> = {}): ForgeMr => ({
  number, title: `MR ${number}`, state, author: { id: 1, username: 'ada', name: 'Ada', avatarUrl: null, webUrl: '', email: null },
  sourceProject: 'group/project', sourceBranch: source, targetProject: 'group/project', targetBranch: target, headSha: `head${number}`,
  webUrl: '', pipeline: null, review: { decision: 'none', approvals: 0, approvalsRequired: null, reviews: [] }, conflicts: false, labels: [], updatedAt: number, stacked: true, ...over,
});
/** An MR no GitBolt stack table is in (long-lived branches, MRs made elsewhere). */
const plain = (number: number, source: string, target: string, state: ForgeMr['state'] = 'open') => mr(number, source, target, state, { stacked: false });
const lookup = (...mrs: ForgeMr[]) => (b: string) => mrs.filter((m) => m.sourceBranch === b).sort((x, y) => y.number - x.number)[0] ?? null;
const stack = (...branches: string[]): Stack => ({ branches, base: 'refs/remotes/origin/main', leftBehind: [] });

/** A tab as the predicates see it: `main` the default and the base, unless said otherwise. */
const envOf = (o: { mrs: ForgeMr[]; locals: string[]; stack?: Stack | null; tips?: Record<string, string>; defaultBranch?: string; base?: string | null }): StackEnv => ({
  mrOf: lookup(...o.mrs),
  locals: new Set(o.locals),
  defaultBranch: o.defaultBranch ?? 'main',
  base: o.base === undefined ? 'main' : o.base,
  stackOf: (b) => (o.stack?.branches.includes(b) ? o.stack : null),
  tipOf: (b) => o.tips?.[b] ?? null,
});

describe('mrChain (spec #4 §4 4D: position and neighbours)', () => {
  const a = mr(1, 'feature/a', 'main');
  const b = mr(2, 'feature/b', 'feature/a');
  const c = mr(3, 'feature/c', 'feature/b');
  const locals = ['feature/a', 'feature/b', 'feature/c'];

  it('walks down through each target and up through the local branches that target the top', () => {
    const env = envOf({ mrs: [a, b, c], locals });
    expect(mrChain(b, env)).toEqual({ mrs: [a, b, c], index: 1 });
    expect(mrChain(a, env)).toEqual({ mrs: [a, b, c], index: 0 });
    expect(mrChain(c, env)?.index).toBe(2);
    expect(mrChain(mr(9, 'solo', 'main'), envOf({ mrs: [a, b, c], locals: [...locals, 'solo'] }))).toBeNull();
  });

  it('keeps a merged bottom (it still shows), and skips closed ones and other projects going up', () => {
    const merged = mr(1, 'feature/a', 'main', 'merged');
    const closed = mr(4, 'feature/d', 'feature/c', 'closed');
    const fork = mr(5, 'feature/e', 'feature/c', 'open', { targetProject: 'alice/project' });
    expect(mrChain(b, envOf({ mrs: [merged, b, c, closed, fork], locals: [...locals, 'feature/d', 'feature/e'] }))?.mrs.map((m) => m.number)).toEqual([1, 2, 3]);
  });

  it('takes the newest when two branches target the top; a cycle off the base is no stack; the walk is capped', () => {
    const c2 = mr(6, 'feature/c2', 'feature/b', 'draft', { updatedAt: 99 });
    expect(mrChain(b, envOf({ mrs: [a, b, c, c2], locals: [...locals, 'feature/c2'] }))?.mrs.map((m) => m.number)).toEqual([1, 2, 6]);
    const x = mr(7, 'x', 'y');
    const y = mr(8, 'y', 'x');
    expect(mrChain(x, envOf({ mrs: [x, y], locals: ['x', 'y'] }))).toBeNull();
    const long = Array.from({ length: 30 }, (_, i) => mr(100 + i, `s${i}`, i === 0 ? 'main' : `s${i - 1}`));
    expect(mrChain(long[0], envOf({ mrs: long, locals: long.map((m) => m.sourceBranch) }))?.mrs.length).toBe(MAX_CHAIN);
  });

  it('says the position and the neighbours in one line', () => {
    const env = envOf({ mrs: [a, b, c], locals });
    expect(stackLine(mrChain(b, env)!, 'gitlab')).toBe('Stack 2 of 3 (below: !1, above: !3)');
    expect(stackLine(mrChain(a, env)!, 'github')).toBe('Stack 1 of 3 (above: #2)');
    expect(stackLine(mrChain(c, env)!, 'gitlab')).toBe('Stack 3 of 3 (below: !2)');
  });

  it('a closed MR in the middle still shows', () => {
    const b2 = mr(2, 'feature/b', 'feature/a', 'closed');
    expect(mrChain(c, envOf({ mrs: [a, b2, c], locals }))?.mrs.map((m) => m.number)).toEqual([1, 2, 3]);
  });
});

describe('afterMerge (spec #4 §4 4D: the bottom merged)', () => {
  const merged = mr(1, 'feature/a', 'main', 'merged');
  const b = mr(2, 'feature/b', 'feature/a');
  const c = mr(3, 'feature/c', 'feature/b');
  const locals = ['feature/a', 'feature/b', 'feature/c'];

  it('the next one still targets the merged branch: retarget it, then rebase the rest (merge commit: a is in the base, not a member)', () => {
    const got = afterMerge('feature/c', envOf({ mrs: [merged, b, c], locals, stack: stack('feature/b', 'feature/c'), tips: { 'feature/a': 'a1' } }));
    expect(got).toEqual({ merged, next: b, target: 'main', retarget: true, branches: ['feature/b', 'feature/c'], dropFrom: ['head1', 'a1'] });
  });

  it('a squash merge leaves a in the local stack: it is skipped, not rebased', () => {
    const got = afterMerge('feature/b', envOf({ mrs: [merged, b, c], locals, stack: stack('feature/a', 'feature/b', 'feature/c'), tips: { 'feature/a': 'a1' } }));
    expect(got?.branches).toEqual(['feature/b', 'feature/c']);
    expect(got?.retarget).toBe(true);
  });

  it('a genuine two-member stack with a squash-merged bottom still prompts', () => {
    const env = envOf({ mrs: [merged, b], locals: ['main', 'feature/a', 'feature/b'], stack: stack('feature/a', 'feature/b'), tips: { 'feature/a': 'head1' } });
    expect(afterMerge('feature/b', env)).toMatchObject({ merged: { number: 1 }, next: { number: 2 }, retarget: true, branches: ['feature/b'] });
    expect(firstAfterMerge(env)?.merged.number).toBe(1);
  });

  it('the forge already retargeted it (GitHub, native GitLab): rebase only', () => {
    const moved = mr(2, 'feature/b', 'main');
    const got = afterMerge('feature/c', envOf({ mrs: [merged, moved, c], locals, stack: stack('feature/a', 'feature/b', 'feature/c'), tips: { 'feature/a': 'a1' } }));
    expect(got).toMatchObject({ retarget: false, target: 'main', branches: ['feature/b', 'feature/c'], dropFrom: ['head1', 'a1'] });
  });

  it("the merged branch is gone locally: its MR's head is the drop point", () => {
    const env = envOf({ mrs: [merged, b], locals: ['feature/b'] });
    expect(afterMerge('feature/b', env)?.dropFrom).toEqual(['head1']);
    expect(afterMerge('feature/b', env)?.branches).toEqual(['feature/b']);
  });

  it('nothing merged, or the next one closed: nothing to do', () => {
    expect(afterMerge('feature/b', envOf({ mrs: [mr(1, 'feature/a', 'main'), b], locals }))).toBeNull();
    expect(afterMerge('feature/b', envOf({ mrs: [merged, mr(2, 'feature/b', 'feature/a', 'closed')], locals }))).toBeNull();
  });

  it('fallback: unrelated target or another project gives nothing; already retargeted is rebase only', () => {
    const st = stack('feature/a', 'feature/b');
    expect(afterMerge('feature/b', envOf({ mrs: [merged, mr(2, 'feature/b', 'other')], locals, stack: st }))).toBeNull();
    expect(afterMerge('feature/b', envOf({ mrs: [merged, mr(2, 'feature/b', 'main', 'open', { targetProject: 'alice/project' })], locals, stack: st }))).toBeNull();
    expect(afterMerge('feature/b', envOf({ mrs: [merged, mr(2, 'feature/b', 'main')], locals, stack: st }))?.retarget).toBe(false);
  });
});

/** C1: a long-lived branch's merged MR is no merged stack bottom. */
describe('long-lived branches (real-world layouts)', () => {
  it('environment branches: main → production merged, features on main: no prompt, no chain', () => {
    const release = plain(10, 'main', 'production', 'merged');
    const f1 = plain(11, 'feature/one', 'main');
    const f2 = plain(12, 'feature/two', 'main');
    const env = envOf({ mrs: [release, f1, f2], locals: ['main', 'production', 'feature/one', 'feature/two'] });
    expect(afterMerge('feature/one', env)).toBeNull();
    expect(firstAfterMerge(env)).toBeNull();
    expect(mrChain(f1, env)).toBeNull();
    expect(mrChain(release, env)).toBeNull();
    // Even with a table on the feature MR, the default branch is never a bottom.
    expect(firstAfterMerge(envOf({ mrs: [release, mr(11, 'feature/one', 'main')], locals: ['feature/one'] }))).toBeNull();
  });

  it('GitFlow: develop → main merged, develop at the released head, a feature on develop without a stack table: no action (the chain shows, cosmetic)', () => {
    const release = plain(20, 'develop', 'main', 'merged');
    const f = plain(21, 'feature/login', 'develop');
    const flow = envOf({ mrs: [release, f], locals: ['main', 'develop', 'feature/login'], tips: { develop: 'head20' } });
    expect(afterMerge('feature/login', flow)).toBeNull();
    expect(firstAfterMerge(flow)).toBeNull();
    // The display is shape-only: no action follows it, and any retarget still needs the table.
    expect(mrChain(f, flow)?.mrs.map((m) => m.number)).toEqual([20, 21]);
    // With unreleased work, develop is a member of the detected stack: still no evidence, still none.
    expect(firstAfterMerge(envOf({ mrs: [release, f], locals: ['main', 'develop', 'feature/login'], stack: stack('develop', 'feature/login') }))).toBeNull();
    // develop as the project's default (and so the stack base): never a bottom.
    const dflt = envOf({ mrs: [release, f], locals: ['main', 'develop', 'feature/login'], defaultBranch: 'develop', base: 'develop' });
    expect(firstAfterMerge(dflt)).toBeNull();
    expect(mrChain(f, dflt)).toBeNull();
  });

  it("the same GitFlow layout with GitBolt's stack table on the feature MR: it was stacked on develop, so it prompts", () => {
    const release = plain(20, 'develop', 'main', 'merged');
    const f = mr(21, 'feature/login', 'develop');
    const flow = envOf({ mrs: [release, f], locals: ['main', 'develop', 'feature/login'], tips: { develop: 'head20' } });
    expect(firstAfterMerge(flow)).toMatchObject({ merged: { number: 20 }, next: { number: 21 }, retarget: true, target: 'main' });
    expect(mrChain(f, flow)?.mrs.map((m) => m.number)).toEqual([20, 21]);
  });

  it('a release branch: release/x from main merged into production: none', () => {
    const rel = plain(30, 'release/x', 'production', 'merged');
    const fix = mr(31, 'fix/typo', 'release/x');
    const env = envOf({ mrs: [rel, fix], locals: ['main', 'release/x', 'fix/typo'], tips: { 'release/x': 'head30' } });
    expect(afterMerge('fix/typo', env)).toBeNull();
    expect(firstAfterMerge(env)).toBeNull();
    expect(mrChain(fix, env)).toBeNull();
    expect(mrChain(rel, env)).toBeNull();
  });

  it("the forge already retargeted (native GitLab, GitHub): no table needed, it's a confirmed local rebase", () => {
    const merged = plain(1, 'feature/a', 'main', 'merged');
    const moved = plain(2, 'feature/b', 'main');
    const env = envOf({ mrs: [merged, moved], locals: ['feature/a', 'feature/b'], stack: stack('feature/a', 'feature/b') });
    expect(afterMerge('feature/b', env)).toMatchObject({ retarget: false, branches: ['feature/b'] });
    // Not retargeted yet and no table: no retarget is offered.
    const still = envOf({ mrs: [merged, plain(2, 'feature/b', 'feature/a')], locals: ['feature/a', 'feature/b'], stack: stack('feature/a', 'feature/b') });
    expect(afterMerge('feature/b', still)).toBeNull();
    // A native stack (no table) still shows its chain.
    const a = plain(1, 'feature/a', 'main');
    const b = plain(2, 'feature/b', 'feature/a');
    expect(mrChain(b, envOf({ mrs: [a, b], locals: ['feature/a', 'feature/b'] }))?.mrs.map((m) => m.number)).toEqual([1, 2]);
  });
});
