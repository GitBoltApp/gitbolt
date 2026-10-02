import { beforeEach, describe, expect, it } from 'vitest';
import { useOps } from '../app/ops';
import { rebaseStatus, rebasingChip } from './rebasing';

const op = (kind: string, label: string, step: { n: number; m: number; branch?: string } | null) => ({ op: 1, kind, repo: 1, label, phase: null, percent: null, interactive: true, shown: false, startedAt: 0, step }) as never;

describe('rebase progress (spec #2 §13.4)', () => {
  beforeEach(() => useOps.setState({ ops: {} }));

  it('reads Rebasing main (23/60)… from the op', () => {
    expect(rebaseStatus(op('rebase', 'rebase main onto origin/main', { n: 23, m: 60, branch: 'main' }))).toBe('Rebasing main (23/60)…');
    expect(rebaseStatus(op('pull', 'pull main', { n: 2, m: 5, branch: 'main' }))).toBe('Rebasing main (2/5)…');
    expect(rebaseStatus(op('rebase', 'rebase main onto origin/main', null))).toBeNull();
    expect(rebaseStatus(op('fetch', 'repo', null))).toBeNull();
  });

  it('draws the rebased branch at HEAD while the worktree rebases', () => {
    const graph = { inProgress: { '/r': { kind: 'rebase', onto: 'b', headName: 'refs/heads/main', step: 3, total: 9, stoppedAt: null, conflicted: 0 } } } as never;
    expect(rebasingChip(graph, '/r')).toBe('main');
    expect(rebasingChip({ inProgress: {} } as never, '/r')).toBeNull();
    expect(rebasingChip({ inProgress: { '/r': { kind: 'merge', mergeHead: 'x', message: '', conflicted: 0 } } } as never, '/r')).toBeNull();
  });

  it('follows each commit: every opProgress step updates the op, and a step-less event keeps the last', () => {
    const { apply } = useOps.getState();
    apply({ type: 'opStarted', op: 7, kind: 'rebase', repo: 1, label: 'rebase main onto origin/main', interactive: true } as never);
    expect(rebaseStatus(useOps.getState().ops[7])).toBeNull();
    apply({ type: 'opProgress', op: 7, phase: 'rebase', percent: null, step: { n: 1, m: 60, branch: 'main' } } as never);
    expect(rebaseStatus(useOps.getState().ops[7])).toBe('Rebasing main (1/60)…');
    apply({ type: 'opProgress', op: 7, phase: 'rebase', percent: null, step: { n: 2, m: 60, branch: 'main' } } as never);
    expect(rebaseStatus(useOps.getState().ops[7])).toBe('Rebasing main (2/60)…');
    apply({ type: 'opProgress', op: 7, phase: 'rebase', percent: null } as never);
    expect(useOps.getState().ops[7].step).toEqual({ n: 2, m: 60, branch: 'main' });
  });
});
