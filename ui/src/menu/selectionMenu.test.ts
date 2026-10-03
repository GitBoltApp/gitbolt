import { Copy } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import { createRepoViewStore } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { commitMenu, fileMenuEnv, graphRowMenu, type MenuEnv, type SelectionTarget } from './menuEnv';
import { buildMenu, registerMenu } from './registry';
import type { MenuRow } from './types';

// While set, the `selection` kind builds no rows, whatever builders other features register.
const noSelectionRows = vi.hoisted(() => ({ on: false }));
vi.mock('./registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('./registry')>();
  return { ...real, buildMenu: ((kind, target, env) => (noSelectionRows.on && kind === 'selection' ? [] : real.buildMenu(kind, target, env))) as typeof real.buildMenu };
});

const [A, B, C] = ['a', 'b', 'c'].map((ch) => ch.repeat(40));
const row = (id: string, parents: string[] = []): RowPayload => ({
  id, kind: parents.length > 1 ? 'merge' : 'commit', lane: 0, color: 0, segments: [], summary: `Fix ${id[0]}`, bodyFirstLine: '', authorName: '', authorEmail: '', authorTime: 0, committerTime: 0, parents, mrRefs: [], wip: null,
});
const graph = { rows: [row(A, [B, C]), row(B), row(C)], labels: [], maxLanes: 1, pinnedRef: null, head: { branch: 'refs/heads/main', target: A, detached: false, unborn: false }, truncated: false, worktrees: [] } as unknown as GraphPayload;
const ids = (rows: MenuRow[]) => rows.flatMap((r) => (r.kind === 'action' ? [r.id] : r.kind === 'separator' ? ['|'] : []));
const action = (id: string): MenuRow => ({ kind: 'action', id, label: id, icon: Copy, tooltip: id, run: () => {} });

const offs: (() => void)[] = [];
afterEach(() => { while (offs.length) offs.pop()!(); noSelectionRows.on = false; });

function store() {
  const s = createRepoViewStore(1, '/r', graph, fakeServices());
  s.getState().selectRow(1);
  s.getState().selectRow(2, { ctrl: true });
  return s;
}

describe('the selection menu (spec #3 §4.3)', () => {
  it('a right-click inside a selection of two or more commits builds the selection kind, with every selected commit', () => {
    const seen: SelectionTarget[] = [];
    offs.push(registerMenu<SelectionTarget, MenuEnv>({ id: 'test.selection', kind: 'selection', group: 'commit', order: 0, rows: (t) => { seen.push(t); return [action('test.selected')]; } }));
    const s = store();
    expect(ids(graphRowMenu(s, graph.rows[1])())).toEqual(['test.selected']);
    expect(seen[0].commits).toEqual([{ oid: B, summary: 'Fix b', merge: false }, { oid: C, summary: 'Fix c', merge: false }]);
  });

  it("a right-click outside the selection opens that row's own menu", () => {
    offs.push(registerMenu<SelectionTarget, MenuEnv>({ id: 'test.selection', kind: 'selection', group: 'commit', order: 0, rows: () => [action('test.selected')] }));
    const rows = ids(graphRowMenu(store(), graph.rows[0])());
    expect(rows).toContain('commit.copySha');
    expect(rows).not.toContain('test.selected');
  });

  it("with no selection row to offer, the row's own menu", () => {
    // A builder is registered (as 3B's and 3C's will be), but the selection builds no rows.
    offs.push(registerMenu<SelectionTarget, MenuEnv>({ id: 'test.selection', kind: 'selection', group: 'commit', order: 0, rows: () => [action('test.selected')] }));
    noSelectionRows.on = true;
    const s = store();
    const rows = ids(graphRowMenu(s, graph.rows[1])());
    expect(rows).toEqual(ids(commitMenu(s, graph.rows[1])()));
    expect(rows).toContain('commit.copySha');
    expect(rows).not.toContain('test.selected');
  });

  it('groups: squash (3C), commit (3B), rebase (3C), a separator between them', () => {
    offs.push(
      registerMenu<SelectionTarget, MenuEnv>({ id: 't.rebase', kind: 'selection', group: 'rebase', order: 0, rows: () => [action('rebase')] }),
      registerMenu<SelectionTarget, MenuEnv>({ id: 't.commit', kind: 'selection', group: 'commit', order: 0, rows: () => [action('pick')] }),
      registerMenu<SelectionTarget, MenuEnv>({ id: 't.squash', kind: 'selection', group: 'squash', order: 0, rows: () => [action('squash')] }),
    );
    expect(ids(buildMenu<SelectionTarget, MenuEnv>('selection', { commits: [] }, {} as MenuEnv))).toEqual(['squash', '|', 'pick', '|', 'rebase']);
  });

  it('commitInfo reads the loaded row; an unloaded commit is unknown', () => {
    const env = fileMenuEnv(createRepoViewStore(1, '/r', graph, fakeServices()));
    expect(env.commitInfo?.(A)).toEqual({ summary: 'Fix a', merge: true });
    expect(env.commitInfo?.('z'.repeat(40))).toBeNull();
    expect(env.remoteNames).toEqual([]);
  });
});
