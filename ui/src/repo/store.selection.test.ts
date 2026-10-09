import { describe, expect, it } from 'vitest';
import type { FileChange } from '../api/gen/FileChange';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import { filesKey } from './services';
import { createRepoViewStore, fileViewTarget, inCommitSelection, selectedCommits, selectedIndex, targetFor, type RepoViewStore } from './store';
import { recordingServices as fakeServices } from './testServices';

// K27 (spec §9.4): the graph's selection. Click order sets a compare's direction; Ctrl+click
// toggles rows in and out with no limit; Shift+click selects a contiguous range from the anchor.

const [A, B, C, D, E] = ['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(40));
const row = (id: string, kind: RowPayload['kind'] = 'commit', wip: RowPayload['wip'] = null): RowPayload => ({
  id, kind, lane: 0, color: 0, segments: [], summary: id.slice(0, 1), bodyFirstLine: '', authorName: 'Ada', authorEmail: 'ada@example.com', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip,
});
const wipRow = (path: string) => row(`wip:${path}`, 'wip', { worktreePath: path, worktreeName: null, modified: 1, added: 0, deleted: 0, renamed: 0, conflicted: 0 });
// Rows: 0 WIP, 1 A, 2 B, 3 C, 4 D, 5 E.
const graph: GraphPayload = {
  rows: [wipRow('/r'), row(A), row(B), row(C), row(D), row(E)],
  labels: [], maxLanes: 1, pinnedRefs: [], head: { branch: 'refs/heads/main', target: A, detached: false, unborn: false }, truncated: false, worktrees: [],
};
const flush = () => new Promise((r) => setTimeout(r, 0));
const change = (path: string, status: string): FileChange => ({ path, oldPath: null, status, additions: 1, deletions: 0, old: { kind: 'object', oid: B }, new: { kind: 'object', oid: A }, submodule: false });

function setup(g: GraphPayload = graph) {
  const services = fakeServices();
  const s = createRepoViewStore(1, '/r', g, services.services);
  const st = () => s.getState();
  const click = (i: number, mods: { ctrl?: boolean; shift?: boolean } = {}) => st().selectRow(i, mods);
  return { ...services, s, st, click };
}
const picks = (s: RepoViewStore) => s.getState().picks;

describe('selection: click order (K27)', () => {
  it('a click then a Ctrl+click compares the first (FROM) with the second (TO), in click order', () => {
    const { st, click, s } = setup();
    click(1);
    click(3, { ctrl: true });
    expect(st().selection).toEqual({ kind: 'compare', from: A, to: C });
    expect(st().sections[0].spec).toEqual({ kind: 'compare', from: A, to: C });
    expect(picks(s)).toEqual({ rows: [1, 3], anchor: 3, cursor: 3 });
    expect(selectedIndex(st())).toBe(3);
    // The other way round: the row order and the dates don't matter.
    click(3);
    click(1, { ctrl: true });
    expect(st().selection).toEqual({ kind: 'compare', from: C, to: A });
  });

  it('a Ctrl+click with nothing selected selects that row alone; on the only selected row it changes nothing', () => {
    const { st, click } = setup();
    click(2, { ctrl: true });
    expect(st().selection).toEqual({ kind: 'commit', index: 2, id: B });
    const open = targetFor(change('a.txt', 'M'), { kind: 'commit', id: B, parent: 0 });
    st().openFile(open);
    const before = st().selection;
    click(2, { ctrl: true });
    expect(st().selection).toBe(before);
    expect(st().diff).toBe(open);
  });

  it('swapCompare reverses FROM and TO and reloads the reversed list', () => {
    const { st, click, s, calls } = setup();
    click(1);
    click(3, { ctrl: true });
    st().swapCompare();
    expect(st().selection).toEqual({ kind: 'compare', from: C, to: A });
    expect(st().sections[0].spec).toEqual({ kind: 'compare', from: C, to: A });
    expect(calls).toContain(`files ${filesKey({ kind: 'compare', from: C, to: A })}`);
    // Both rows stay selected; Esc still goes back to the anchor.
    expect(picks(s)).toEqual({ rows: [3, 1], anchor: 3, cursor: 3 });
    st().swapCompare();
    expect(st().selection).toEqual({ kind: 'compare', from: A, to: C });
  });

  it('a swap while the first direction is still loading never shows the stale list', async () => {
    const { st, click, resolve } = setup();
    click(3);
    click(1, { ctrl: true });
    st().swapCompare();
    const forward = { files: [change('forward.txt', 'M')], added: 1, deleted: 0 };
    const reversed = { files: [change('reversed.txt', 'M')], added: 1, deleted: 0 };
    resolve(`files ${filesKey({ kind: 'compare', from: C, to: A })}`, forward);
    await flush();
    expect(st().sections).toEqual([{ title: null, spec: { kind: 'compare', from: A, to: C }, list: { status: 'loading' } }]);
    resolve(`files ${filesKey({ kind: 'compare', from: A, to: C })}`, reversed);
    await flush();
    expect(st().sections[0].list).toEqual({ status: 'ready', data: reversed });
  });

  it('a swap with a diff open re-opens the same file in the reversed list, or closes the diff when it is not there', async () => {
    const { st, click, resolve } = setup();
    click(3);
    click(1, { ctrl: true });
    const forwardSpec = { kind: 'compare' as const, from: C, to: A }, reversedSpec = { kind: 'compare' as const, from: A, to: C };
    const renamed = { ...change('docs/manual.txt', 'R'), oldPath: 'docs/guide.txt' };
    resolve(`files ${filesKey(forwardSpec)}`, { files: [change('a.txt', 'M'), renamed, change('z.txt', 'A')], added: 3, deleted: 0 });
    await flush();

    // A modified file keeps its path; the diff stays open while the reversed list loads.
    const open = targetFor(change('a.txt', 'M'), forwardSpec);
    st().openFile(open);
    st().swapCompare();
    expect(st().diff).toBe(open);
    const reversedRename = { ...change('docs/guide.txt', 'R'), oldPath: 'docs/manual.txt' };
    const reversed = { files: [change('a.txt', 'M'), reversedRename, change('z.txt', 'D')], added: 3, deleted: 0 };
    resolve(`files ${filesKey(reversedSpec)}`, reversed);
    await flush();
    expect(st().diff).toEqual(targetFor(reversed.files[0], reversedSpec));

    // A rename is found under its old path.
    st().openFile(targetFor(reversedRename, reversedSpec));
    st().swapCompare();
    await flush();
    expect(st().diff).toEqual(targetFor(renamed, forwardSpec));

    // A path missing from the reversed list closes the diff.
    st().openFile(fileViewTarget('unchanged.txt', A, forwardSpec));
    st().swapCompare();
    await flush();
    expect(st().diff).toBeNull();
  });

  it('swapCompare does nothing outside a two-commit compare (the working tree is always TO)', () => {
    const { st, click } = setup();
    click(2);
    st().swapCompare();
    expect(st().selection).toEqual({ kind: 'commit', index: 2, id: B });
    click(0, { ctrl: true });
    const before = st().selection;
    st().swapCompare();
    expect(st().selection).toBe(before);
  });

  it('the WIP row in a compare means against the working tree, whichever was clicked first', () => {
    const { st, click, s } = setup();
    click(0);
    click(2, { ctrl: true });
    expect(st().selection).toEqual({ kind: 'compareWorktree', from: B, worktree: '/r' });
    expect(st().sections[0].spec).toEqual({ kind: 'worktree', from: B, worktree: '/r' });
    expect(picks(s)).toEqual({ rows: [0, 2], anchor: 2, cursor: 2 });
    click(2);
    click(0, { ctrl: true });
    expect(st().selection).toEqual({ kind: 'compareWorktree', from: B, worktree: '/r' });
    // Dropping the WIP row leaves the commit.
    click(0, { ctrl: true });
    expect(st().selection).toEqual({ kind: 'commit', index: 2, id: B });
  });

  it('two WIP rows cannot be compared: the one clicked is selected alone', () => {
    const { st, click } = setup({ ...graph, rows: [wipRow('/r'), wipRow('/w2'), row(A)] });
    click(0);
    click(1, { ctrl: true });
    expect(st().selection).toEqual({ kind: 'wip', index: 1, worktree: '/w2', name: null });
  });
});

describe('selection: multi-select (K27)', () => {
  it('a third Ctrl+click makes a multi-selection: ids newest first, no file lists, no details', () => {
    const { st, click, s } = setup();
    click(3);
    click(1, { ctrl: true });
    click(2, { ctrl: true });
    expect(st().selection).toMatchObject({ kind: 'multi', ids: [A, B, C] });
    expect(st().sections).toEqual([]);
    expect([st().details, st().message, st().diff]).toEqual([{ status: 'idle' }, { status: 'idle' }, null]);
    expect(picks(s)).toEqual({ rows: [3, 1, 2], anchor: 2, cursor: 2 });
    // The panel shows it at once: there's nothing to load.
    expect(st().panel?.selection).toMatchObject({ kind: 'multi', ids: [A, B, C] });
    expect(st().panelPending).toBe(false);
  });

  it('Ctrl+click adds rows with no limit, the WIP row included', () => {
    const { st, click } = setup();
    for (const i of [5, 4, 3, 2, 1]) click(i, { ctrl: i !== 5 });
    click(0, { ctrl: true });
    expect(st().selection).toMatchObject({ kind: 'multi', ids: ['wip:/r', A, B, C, D, E] });
  });

  it('Ctrl+click on a selected row removes it: 3 → a compare of the other two, in click order', () => {
    const { st, click, s } = setup();
    click(1);
    click(3, { ctrl: true });
    click(2, { ctrl: true });
    click(3, { ctrl: true });
    expect(st().selection).toEqual({ kind: 'compare', from: A, to: B });
    expect(picks(s)).toEqual({ rows: [1, 2], anchor: 2, cursor: 2 });
    click(1, { ctrl: true });
    expect(st().selection).toEqual({ kind: 'commit', index: 2, id: B });
  });

  it('removing the anchor moves it to the row picked last of those left', () => {
    const { st, click, s } = setup();
    click(1);
    click(3, { ctrl: true });
    click(2, { ctrl: true });
    click(2, { ctrl: true });
    expect(st().selection).toEqual({ kind: 'compare', from: A, to: C });
    expect(picks(s)).toEqual({ rows: [1, 3], anchor: 3, cursor: 3 });
  });

  it('a plain click goes back to a single selection', () => {
    const { st, click, s } = setup();
    click(1);
    click(3, { ctrl: true });
    click(2, { ctrl: true });
    click(4);
    expect(st().selection).toEqual({ kind: 'commit', index: 4, id: D });
    expect(picks(s).rows).toEqual([]);
    expect(selectedIndex(st())).toBe(4);
  });

  it('a late file list for a compare left for a multi-selection is dropped', async () => {
    const { st, click, resolve } = setup();
    click(1);
    click(3, { ctrl: true });
    click(2, { ctrl: true });
    resolve(`files ${filesKey({ kind: 'compare', from: A, to: C })}`, { files: [change('x', 'M')], added: 1, deleted: 0 });
    await flush();
    expect(st().sections).toEqual([]);
    expect(st().panel?.selection.kind).toBe('multi');
  });
});

describe('selection: Shift ranges (K27)', () => {
  it('Shift+click selects the rows from the anchor to the clicked row, inclusive', () => {
    const { st, click, s } = setup();
    click(1);
    click(4, { shift: true });
    expect(st().selection).toMatchObject({ kind: 'multi', ids: [A, B, C, D] });
    expect(picks(s)).toEqual({ rows: [1, 2, 3, 4], anchor: 1, cursor: 4 });
    // Upwards too, from the same anchor.
    click(5);
    click(3, { shift: true });
    expect(st().selection).toMatchObject({ kind: 'multi', ids: [C, D, E] });
    expect(picks(s)).toEqual({ rows: [5, 4, 3], anchor: 5, cursor: 3 });
  });

  it('a two-row range is a compare with the anchor as FROM', () => {
    const { st, click } = setup();
    click(3);
    click(2, { shift: true });
    expect(st().selection).toEqual({ kind: 'compare', from: C, to: B });
    click(2);
    click(3, { shift: true });
    expect(st().selection).toEqual({ kind: 'compare', from: B, to: C });
  });

  it('a range keeps its anchor: a second Shift+click re-ranges from it', () => {
    const { st, click, s } = setup();
    click(2);
    click(5, { shift: true });
    click(3, { shift: true });
    expect(st().selection).toEqual({ kind: 'compare', from: B, to: C });
    click(2, { shift: true });
    expect(st().selection).toEqual({ kind: 'commit', index: 2, id: B });
    click(1, { shift: true });
    expect(picks(s)).toEqual({ rows: [2, 1], anchor: 2, cursor: 1 });
  });

  it('the anchor is the row Ctrl+clicked last', () => {
    const { st, click } = setup();
    click(1);
    click(3, { ctrl: true });
    click(5, { shift: true });
    expect(st().selection).toMatchObject({ kind: 'multi', ids: [C, D, E] });
  });

  it('Shift+Ctrl+click adds the range to the selection', () => {
    const { st, click, s } = setup();
    click(1);
    click(3, { ctrl: true });
    click(5, { ctrl: true, shift: true });
    expect(st().selection).toMatchObject({ kind: 'multi', ids: [A, C, D, E] });
    expect(picks(s)).toEqual({ rows: [1, 3, 4, 5], anchor: 3, cursor: 5 });
  });

  it('Shift+click with nothing selected selects the row alone', () => {
    const { st, click } = setup();
    click(3, { shift: true });
    expect(st().selection).toEqual({ kind: 'commit', index: 3, id: C });
  });

  it('Shift+↓ steps (each a Shift+click one row past the cursor) extend the range from the anchor', () => {
    const { st, click } = setup();
    click(2);
    click(selectedIndex(st()) + 1, { shift: true });
    click(selectedIndex(st()) + 1, { shift: true });
    expect(st().selection).toMatchObject({ kind: 'multi', ids: [B, C, D] });
    click(selectedIndex(st()) - 1, { shift: true });
    expect(st().selection).toEqual({ kind: 'compare', from: B, to: C });
  });
});

describe('selection: leaving and refreshing (K27)', () => {
  it('exitCompare from a compare returns to the anchor (the row Ctrl+clicked last)', () => {
    const { st, click, s } = setup();
    click(3);
    click(1, { ctrl: true });
    st().exitCompare();
    expect(st().selection).toEqual({ kind: 'commit', index: 1, id: A });
    expect(picks(s).rows).toEqual([]);
  });

  it('exitCompare from a multi-selection returns to the anchor', () => {
    const { st, click } = setup();
    click(2);
    click(5, { shift: true });
    st().exitCompare();
    expect(st().selection).toEqual({ kind: 'commit', index: 2, id: B });
  });

  it('a new graph keeps the selected rows by commit id and drops the gone ones', () => {
    const { st, click, s } = setup();
    click(1);
    click(3, { ctrl: true });
    st().setGraph({ ...graph, rows: [row(C), row(B), row(A)] });
    expect(picks(s)).toEqual({ rows: [2, 0], anchor: 0, cursor: 0 });
    expect(st().selection).toEqual({ kind: 'compare', from: A, to: C });
    click(1, { ctrl: true });
    expect(st().selection).toMatchObject({ kind: 'multi', ids: [C, B, A] });
    // A refresh that drops one of three: the two left are a compare, in pick order; the anchor
    // and cursor (the dropped row) move to the row picked last of those left.
    st().setGraph({ ...graph, rows: [row(E), row(A), row(C)] });
    expect(picks(s)).toEqual({ rows: [1, 2], anchor: 2, cursor: 2 });
    expect(st().selection).toEqual({ kind: 'compare', from: A, to: C });
    expect(st().sections[0].spec).toEqual({ kind: 'compare', from: A, to: C });
  });

  it('a refresh that leaves one of a compare\'s rows: that row alone; three of four left stay a multi-selection', () => {
    const { st, click, s } = setup();
    click(1);
    click(3, { ctrl: true });
    st().setGraph({ ...graph, rows: [row(E), row(C)] });
    expect(st().selection).toEqual({ kind: 'commit', index: 1, id: C });
    expect(picks(s).rows).toEqual([]);
    st().setGraph({ ...graph, rows: [row(A), row(B), row(C), row(D), row(E)] });
    click(0);
    click(4, { shift: true });
    expect(st().selection).toMatchObject({ kind: 'multi', ids: [A, B, C, D, E] });
    st().setGraph({ ...graph, rows: [row(A), row(C), row(D), row(E)] });
    expect(st().selection).toMatchObject({ kind: 'multi', ids: [A, C, D, E] });
  });

  it('compareCommits: from → to, with the anchor and the keyboard on `from`', () => {
    const { st, s } = setup();
    expect(st().compareCommits(C, A)).toBe(true);
    expect(st().selection).toEqual({ kind: 'compare', from: C, to: A });
    expect(picks(s)).toEqual({ rows: [3, 1], anchor: 3, cursor: 3 });
    expect(selectedIndex(st())).toBe(3);
    st().exitCompare();
    expect(st().selection).toEqual({ kind: 'commit', index: 3, id: C });
    expect(st().compareCommits('f'.repeat(40), A)).toBe(false);
  });

  it('Shift+Ctrl over a long range adds each row once', () => {
    const many: GraphPayload = { ...graph, rows: Array.from({ length: 5000 }, (_, i) => row(String(i).padStart(40, '0'))) };
    const { st, click, s } = setup(many);
    click(10);
    click(20, { ctrl: true });
    click(4999, { ctrl: true, shift: true });
    expect(picks(s).rows.length).toBe(1 + 4980);
    expect(new Set(picks(s).rows).size).toBe(picks(s).rows.length);
    expect(st().selection.kind).toBe('multi');
  });

  it('compare with working tree selects the commit and the WIP row; the commit is the anchor', () => {
    const { st, s } = setup();
    st().compareWithWorktree(B, '/r');
    expect(st().selection).toEqual({ kind: 'compareWorktree', from: B, worktree: '/r' });
    expect(picks(s)).toEqual({ rows: [2, 0], anchor: 2, cursor: 2 });
    st().exitCompare();
    expect(st().selection).toEqual({ kind: 'commit', index: 2, id: B });
  });

  it('exitCompare from a compare-with-working-tree whose commit has no row goes to the WIP row, or clears', () => {
    const { st, s } = setup();
    st().compareWithWorktree('f'.repeat(40), '/r');
    expect(picks(s)).toEqual({ rows: [0], anchor: null, cursor: null });
    st().exitCompare();
    expect(st().selection).toEqual({ kind: 'wip', index: 0, worktree: '/r', name: null });
    st().compareWithWorktree('f'.repeat(40), '/elsewhere');
    expect(picks(s)).toEqual({ rows: [], anchor: null, cursor: null });
    st().exitCompare();
    expect([st().selection, st().sections]).toEqual([{ kind: 'none' }, []]);
  });
});

describe('the multi-selection names its anchor (spec #3 §4.3, the 3B/3C contract)', () => {
  it('a Shift range: the row it started from; Ctrl+clicks: the row clicked last', () => {
    const { st, click } = setup();
    click(1);
    click(4, { shift: true });
    expect(st().selection).toEqual({ kind: 'multi', ids: [A, B, C, D], anchor: A });
    click(3);
    click(1, { ctrl: true });
    click(2, { ctrl: true });
    expect(st().selection).toEqual({ kind: 'multi', ids: [A, B, C], anchor: B });
  });

  it("a refresh keeps the anchor, or moves it to the row picked last when the anchor's row went", () => {
    const { st, click } = setup();
    for (const i of [1, 2, 3, 4]) click(i, { ctrl: i !== 1 });
    st().setGraph({ ...graph, rows: graph.rows.filter((r) => r.id !== A) });
    expect(st().selection).toEqual({ kind: 'multi', ids: [B, C, D], anchor: D });
    // Two left: a compare, in pick order (K27).
    st().setGraph({ ...graph, rows: graph.rows.filter((r) => r.id !== A && r.id !== D) });
    expect(st().selection).toMatchObject({ kind: 'compare', from: B, to: C });
  });

  it("the anchor's own row going moves it to the row picked last", () => {
    const { st, click } = setup();
    for (const i of [1, 2, 3, 4]) click(i, { ctrl: i !== 1 });
    expect(st().selection).toMatchObject({ anchor: D });
    st().setGraph({ ...graph, rows: graph.rows.filter((r) => r.id !== D) });
    expect(st().selection).toEqual({ kind: 'multi', ids: [A, B, C], anchor: C });
  });
});

describe('selectedCommits and inCommitSelection (spec #3 §4.3)', () => {
  const M = 'f'.repeat(40);
  const S = '5'.repeat(40);
  const g2: GraphPayload = { ...graph, rows: [wipRow('/r'), row(A), { ...row(M), kind: 'merge', parents: [A, B] }, row(B), { ...row(S), kind: 'stash' }, row(C)] };

  it('one commit, a compare\'s two, a range: newest first; WIP rows and stash nodes left out; merges flagged', () => {
    const { st, click } = setup(g2);
    expect(selectedCommits(st())).toEqual([]);
    click(1);
    expect(selectedCommits(st())).toEqual([{ oid: A, summary: 'a', merge: false }]);
    click(3);
    click(1, { ctrl: true });
    expect(selectedCommits(st()).map((c) => c.oid)).toEqual([A, B]);
    click(0);
    click(5, { shift: true });
    expect(selectedCommits(st())).toEqual([
      { oid: A, summary: 'a', merge: false },
      { oid: M, summary: 'f', merge: true },
      { oid: B, summary: 'b', merge: false },
      { oid: C, summary: 'c', merge: false },
    ]);
  });

  it('only the rows of a selection of two or more commits are in it', () => {
    const { st, click } = setup();
    click(1);
    expect(inCommitSelection(st(), A)).toBe(false);
    click(2, { ctrl: true });
    expect(inCommitSelection(st(), A)).toBe(true);
    expect(inCommitSelection(st(), C)).toBe(false);
    click(0);
    click(1, { ctrl: true });
    expect(inCommitSelection(st(), A)).toBe(false);
  });
});
