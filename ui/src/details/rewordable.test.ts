import { describe, expect, it } from 'vitest';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RowPayload } from '../api/gen/RowPayload';
import { rewordableOlder, type RewordInput } from './rewordable';

// feature: f2 ← f1 ← m2 (main's tip) ← m1 ← m0 (the first commit); x, a merge on feature/y.
const row = (id: string, parents: string[]) => ({ id, parents }) as unknown as RowPayload;
const rows = [row('f2', ['f1']), row('f1', ['m2']), row('m2', ['m1']), row('m1', ['m0']), row('m0', [])];
const label = (r: number, local: string | null, remote: string | null = null): RefLabel => ({ row: r, name: local ?? remote ?? '', local, remotes: remote ? [{ fullName: remote, remote: 'origin', host: null, hostKind: 'unknown' as never }] : [], tag: false, isHead: false, worktree: null, checkedOut: null });

function input(head: { branch: string; target: string }, o: { labels?: RefLabel[]; rows?: RowPayload[]; upstream?: string } = {}): RewordInput {
  const rs = o.rows ?? rows;
  return {
    graph: { rows: rs, labels: o.labels ?? [label(0, 'refs/heads/feature'), label(2, 'refs/heads/main', 'refs/remotes/origin/main')], head: { ...head, detached: false, unborn: false } },
    indexById: new Map(rs.map((r, i) => [r.id, i])),
    remotes: [{ name: 'origin', defaultBranch: 'refs/remotes/origin/main' }],
    locals: [{ fullName: head.branch, upstream: o.upstream ?? null }],
  };
}
const feature = { branch: 'refs/heads/feature', target: 'f2' };

describe('rewordableOlder (spec #3 §3.6; 3C T13 fix 1 I1)', () => {
  it('a commit of the branch, above the fork: yes, with HEAD for the CAS', () => {
    expect(rewordableOlder(input(feature), 'f1')).toEqual({ head: 'f2', pushed: null });
  });

  it('a trunk commit below the fork: no (it would copy trunk history into the branch)', () => {
    expect(rewordableOlder(input(feature), 'm1')).toBeNull();
    expect(rewordableOlder(input(feature), 'm2')).toBeNull();
  });

  it('on the trunk itself: any older ancestor of HEAD but the first commit', () => {
    const main = { branch: 'refs/heads/main', target: 'm2' };
    expect(rewordableOlder(input(main), 'm1')).toEqual({ head: 'm2', pushed: null });
    expect(rewordableOlder(input(main), 'm0')).toBeNull();
  });

  it('HEAD itself, a commit not under HEAD, a merge, a detached HEAD: no', () => {
    expect(rewordableOlder(input(feature), 'f2')).toBeNull();
    const side = [row('y', ['m1']), ...rows];
    expect(rewordableOlder(input(feature, { rows: side }), 'y')).toBeNull();
    const merged = [row('f2', ['x']), row('x', ['f1', 'm1']), row('f1', ['m2']), row('m2', ['m1']), row('m1', ['m0']), row('m0', [])];
    expect(rewordableOlder(input(feature, { rows: merged }), 'x')).toBeNull();
    const detached = input(feature);
    detached.graph.head = { branch: null, target: 'f2', detached: true, unborn: false };
    expect(rewordableOlder(detached, 'f1')).toBeNull();
  });

  it('with no trunk among the loaded refs: any older ancestor of HEAD', () => {
    expect(rewordableOlder(input(feature, { labels: [label(0, 'refs/heads/feature')] }), 'm1')).toEqual({ head: 'f2', pushed: null });
  });

  it('pushed: HEAD\'s upstream already has the commit (fix 1 M6)', () => {
    const labels = [label(0, 'refs/heads/feature'), label(1, null, 'refs/remotes/origin/feature'), label(2, 'refs/heads/main', 'refs/remotes/origin/main')];
    expect(rewordableOlder(input(feature, { labels, upstream: 'refs/remotes/origin/feature' }), 'f1')).toEqual({ head: 'f2', pushed: 'origin/feature' });
  });
});
