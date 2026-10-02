import { describe, expect, it } from 'vitest';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RowPayload } from '../api/gen/RowPayload';
import { labelsByRowOf, membershipOf } from './graphIndex';

const row = (id: string, parents: string[]): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary: id, bodyFirstLine: '', authorName: '', authorEmail: '', authorTime: 0, committerTime: 0, parents, mrRefs: [], wip: null });
const labels: RefLabel[] = [{ row: 0, name: 'main', local: 'refs/heads/main', remotes: [], tag: false, isHead: true, worktree: null, checkedOut: null }];
const rows = [row('a', ['b']), row('b', [])];

describe('graphIndex: once per payload, shared by the graph view and the menus', () => {
  it('returns the same indexes for the same arrays, new ones for new arrays', () => {
    const byRow = labelsByRowOf(labels);
    expect(labelsByRowOf(labels)).toBe(byRow);
    expect(labelsByRowOf([...labels])).not.toBe(byRow);
    const m = membershipOf(rows, byRow, null);
    expect(m[1]?.name).toBe('main');
    expect(membershipOf(rows, byRow, null)).toBe(m);
    expect(membershipOf(rows, byRow, 'refs/heads/main')).not.toBe(m);
    expect(membershipOf([...rows], byRow, null)).not.toBe(m);
  });
});
