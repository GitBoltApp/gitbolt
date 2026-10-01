import { describe, expect, it } from 'vitest';
import type { CommitDetailsPayload } from '../api/gen/CommitDetailsPayload';
import type { CommitMessage } from '../api/gen/CommitMessage';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { FileChange } from '../api/gen/FileChange';
import type { RowPayload } from '../api/gen/RowPayload';
import { createRepoViewStore, otherSelectedIndex, selectedIndex, targetFor } from './store';
import { recordingServices as fakeServices } from './testServices';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const row = (id: string, kind: RowPayload['kind'] = 'commit', wip: RowPayload['wip'] = null): RowPayload => ({
  id, kind, lane: 0, color: 0, segments: [], summary: id.slice(0, 1), bodyFirstLine: '', authorName: 'Ada', authorEmail: 'ada@example.com', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip,
});
const graph: GraphPayload = {
  rows: [row('wip:/r', 'wip', { worktreePath: '/r', worktreeName: null, modified: 1, added: 0, deleted: 0, conflicted: 0 }), row(A), row(B), row(C)],
  labels: [], maxLanes: 1, pinnedRef: null, head: { branch: 'refs/heads/main', target: A, detached: false, unborn: false }, truncated: false,
};
const details = (id: string): CommitDetailsPayload => ({ id, parents: [], author: { name: 'Ada', email: 'ada@example.com', time: 0 }, committer: { name: 'Ada', email: 'ada@example.com', time: 0 }, coAuthors: [], signed: false });
const message = (id: string): CommitMessage => ({ id, summary: id.slice(0, 1), body: `body of ${id.slice(0, 1)}` });
const flush = () => new Promise((r) => setTimeout(r, 0));
const change = (path: string, status: string): FileChange => ({ path, oldPath: null, status, additions: 1, deletions: 0, old: { kind: 'object', oid: B }, new: { kind: 'object', oid: A }, submodule: false });

describe('repo view store', () => {
  it('latest selection wins even when an older response arrives last', async () => {
    const { services, resolve } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    s.getState().selectRow(1);
    s.getState().selectRow(2);
    resolve(`details ${B}`, details(B));
    resolve(`details ${A}`, details(A));
    await flush();
    expect(s.getState().details).toEqual({ status: 'ready', data: details(B) });
  });

  it('selecting a commit loads its details and file list and prefetches its neighbours', () => {
    const { services, calls } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    s.getState().selectRow(2);
    expect(s.getState().selection).toEqual({ kind: 'commit', index: 2, id: B });
    expect(selectedIndex(s.getState())).toBe(2);
    expect(calls).toContain(`details ${B}`);
    expect(calls).toContain(`files {"kind":"commit","id":"${B}","parent":0}`);
    expect(calls).toContain(`details ${A}`);
    expect(calls).toContain(`details ${C}`);
    expect(calls.some((c) => c.includes('wip'))).toBe(false);
  });

  // Controller ruling F1: the message isn't in `CommitDetailsPayload`; it comes from the
  // per-repo `commitMessage` cache the graph tooltip shares (`services.messages`).
  it('selecting a commit loads its full message from the shared message cache, latest wins', async () => {
    const { services, calls, resolve } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    s.getState().selectRow(1);
    expect(calls).toContain(`message ${A}`);
    expect(s.getState().message).toEqual({ status: 'loading' });
    s.getState().selectRow(2);
    resolve(`message ${B}`, message(B));
    resolve(`message ${A}`, message(A));
    await flush();
    expect(s.getState().message).toEqual({ status: 'ready', data: message(B) });
    // A cache hit is ready at once, with no loading flash.
    s.getState().selectRow(1);
    expect(s.getState().message).toEqual({ status: 'ready', data: message(A) });
  });

  it('a failed message load shows as an error for that selection only', async () => {
    const { services, reject } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    s.getState().selectRow(3);
    reject(`message ${C}`, { kind: 'NotFound', message: 'no such commit', commandId: null, stderr: null });
    await flush();
    expect(s.getState().message).toEqual({ status: 'error', message: 'no such commit' });
    s.getState().selectRow(0);
    expect(s.getState().message).toEqual({ status: 'idle' });
  });

  it('a WIP row gets unstaged and staged sections', () => {
    const { services, calls } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    s.getState().selectRow(0);
    expect(s.getState().selection).toEqual({ kind: 'wip', index: 0, worktree: '/r', name: null });
    expect(s.getState().sections.map((x) => [x.title, x.spec])).toEqual([
      ['Unstaged', { kind: 'wip', worktree: '/r', staged: false }],
      ['Staged', { kind: 'wip', worktree: '/r', staged: true }],
    ]);
    expect([s.getState().details, s.getState().message]).toEqual([{ status: 'idle' }, { status: 'idle' }]);
    expect(calls.some((c) => c.startsWith('details ') || c.startsWith('message '))).toBe(false);
  });

  // K15/K16: one Ctrl+click adds a second commit to the selection; the pair is the compare,
  // older → newer by commit date, with no A/B marks.
  it('with one commit selected, a Ctrl+click on a second selects both and compares them', () => {
    const { services } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    s.getState().selectRow(1);
    s.getState().selectRow(3, { ctrl: true });
    // Same commit date: the lower row (graph order) is the older one, the base.
    expect(s.getState().selection).toEqual({ kind: 'compare', from: C, to: A });
    expect(s.getState().sections[0].spec).toEqual({ kind: 'compare', from: C, to: A });
    expect(s.getState().compareRows).toEqual({ cursor: 3, other: 1 });
    expect([selectedIndex(s.getState()), otherSelectedIndex(s.getState())]).toEqual([3, 1]);
  });

  it('orders the pair by commit date (older = base), whatever the click or row order', () => {
    const { services } = fakeServices();
    const timed = { ...graph, rows: [graph.rows[0], { ...row(A), committerTime: 100 }, { ...row(B), committerTime: 300 }, { ...row(C), committerTime: 200 }] };
    const s = createRepoViewStore(1, '/r', timed, services);
    s.getState().selectRow(1);
    s.getState().selectRow(3, { ctrl: true });
    expect(s.getState().selection).toEqual({ kind: 'compare', from: A, to: C });
    s.getState().selectRow(3);
    s.getState().selectRow(1, { ctrl: true });
    expect(s.getState().selection).toEqual({ kind: 'compare', from: A, to: C });
    s.getState().selectRow(2);
    s.getState().selectRow(3, { ctrl: true });
    expect(s.getState().selection).toEqual({ kind: 'compare', from: C, to: B });
  });

  it('a Ctrl+click on one of the pair drops it, back to the other alone', () => {
    const { services } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    s.getState().selectRow(1);
    s.getState().selectRow(3, { ctrl: true });
    s.getState().selectRow(3, { ctrl: true });
    expect(s.getState().selection).toEqual({ kind: 'commit', index: 1, id: A });
    expect(s.getState().compareRows).toEqual({ cursor: null, other: null });
    s.getState().selectRow(3, { ctrl: true });
    s.getState().selectRow(1, { ctrl: true });
    expect(s.getState().selection).toEqual({ kind: 'commit', index: 3, id: C });
  });

  it('a plain click leaves the pair for that one commit', () => {
    const { services } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    s.getState().selectRow(1);
    s.getState().selectRow(3, { ctrl: true });
    s.getState().selectRow(3);
    expect(s.getState().selection).toEqual({ kind: 'commit', index: 3, id: C });
    expect([selectedIndex(s.getState()), otherSelectedIndex(s.getState())]).toEqual([3, -1]);
  });

  it('a Ctrl+click on a third commit pairs it with the one Ctrl+clicked last', () => {
    const { services } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    s.getState().selectRow(1);
    s.getState().selectRow(3, { ctrl: true });
    s.getState().selectRow(2, { ctrl: true });
    expect(s.getState().selection).toEqual({ kind: 'compare', from: C, to: B });
    expect(s.getState().compareRows).toEqual({ cursor: 2, other: 3 });
  });

  it('a Ctrl+click with nothing selected selects that commit; on the selected commit it changes nothing', () => {
    const { services } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    s.getState().selectRow(2, { ctrl: true });
    expect(s.getState().selection).toEqual({ kind: 'commit', index: 2, id: B });
    const open = targetFor(change('a.txt', 'M'), { kind: 'commit', id: B, parent: 0 });
    s.getState().openFile(open);
    const before = s.getState().selection;
    s.getState().selectRow(2, { ctrl: true });
    expect(s.getState().selection).toBe(before);
    expect(s.getState().diff).toBe(open);
  });

  it('the WIP row and a commit, Ctrl+clicked together, compare that commit with the working tree', () => {
    const { services } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    s.getState().selectRow(0);
    s.getState().selectRow(2, { ctrl: true });
    expect(s.getState().selection).toEqual({ kind: 'compareWorktree', from: B, worktree: '/r' });
    expect(s.getState().sections[0].spec).toEqual({ kind: 'worktree', from: B, worktree: '/r' });
    expect(s.getState().compareRows).toEqual({ cursor: 2, other: 0 });
    s.getState().selectRow(2);
    s.getState().selectRow(0, { ctrl: true });
    expect(s.getState().selection).toEqual({ kind: 'compareWorktree', from: B, worktree: '/r' });
    expect(s.getState().compareRows).toEqual({ cursor: 0, other: 2 });
    // Dropping the WIP row leaves the commit.
    s.getState().selectRow(0, { ctrl: true });
    expect(s.getState().selection).toEqual({ kind: 'commit', index: 2, id: B });
  });

  it('exitCompare returns to the commit Ctrl+clicked last', () => {
    const { services } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    s.getState().selectRow(3);
    s.getState().selectRow(1, { ctrl: true });
    s.getState().exitCompare();
    expect(s.getState().selection).toEqual({ kind: 'commit', index: 1, id: A });
    expect(s.getState().compareRows).toEqual({ cursor: null, other: null });
  });

  it('a new graph keeps both compared rows by commit id', () => {
    const { services } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    s.getState().selectRow(1);
    s.getState().selectRow(3, { ctrl: true });
    s.getState().setGraph({ ...graph, rows: [row(C), row(B), row(A)] });
    expect(s.getState().compareRows).toEqual({ cursor: 0, other: 2 });
    expect(s.getState().selection).toEqual({ kind: 'compare', from: C, to: A });
  });

  it('the merge parent picker reloads the file list against that parent', () => {
    const { services, calls } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    s.getState().selectRow(1);
    s.getState().setParent(1);
    expect(s.getState().parent).toBe(1);
    expect(calls).toContain(`files {"kind":"commit","id":"${A}","parent":1}`);
  });

  it('opening a file prefetches its neighbours; closing returns focus to the graph', () => {
    const { services, calls } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    const spec = { kind: 'commit' as const, id: A, parent: 0 };
    const f = (path: string) => targetFor({ path, oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'object', oid: C }, new: { kind: 'object', oid: B }, submodule: false }, spec);
    s.getState().setFocus('files');
    s.getState().openFile(f('b.txt'), [f('a.txt'), f('c.txt')]);
    expect(s.getState().diff?.path).toBe('b.txt');
    expect(calls.filter((c) => c.startsWith('contents ')).length).toBe(2);
    s.getState().setView('file');
    expect(s.getState().diff?.view).toBe('file');
    s.getState().closeDiff();
    expect([s.getState().diff, s.getState().focus]).toEqual([null, 'graph']);
  });

  it('a new graph keeps the selection by commit id', () => {
    const { services } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    s.getState().selectRow(2);
    s.getState().setGraph({ ...graph, rows: [row(C), row(B), row(A)] });
    expect(s.getState().selection).toEqual({ kind: 'commit', index: 1, id: B });
    expect(s.getState().selectCommitById('f'.repeat(40))).toBe(false);
  });

  it('compare with working tree uses the worktree spec', () => {
    const { services } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    s.getState().compareWithWorktree(B, '/r');
    expect(s.getState().selection).toEqual({ kind: 'compareWorktree', from: B, worktree: '/r' });
    expect(s.getState().sections[0].spec).toEqual({ kind: 'worktree', from: B, worktree: '/r' });
    // The commit and the worktree's WIP row are both selected; the keyboard is on the commit.
    expect(s.getState().compareRows).toEqual({ cursor: 2, other: 0 });
  });

  // Review fix 1: the parent picker renders from the row's parents, so it can be used before
  // the details arrive; the pending details and message must still land.
  it('setParent while details and the message are pending still resolves both', async () => {
    const { services, calls, resolve } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    s.getState().selectRow(1);
    s.getState().setParent(1);
    expect(calls.filter((c) => c === `details ${A}` || c === `message ${A}`)).toEqual([`details ${A}`, `message ${A}`]);
    resolve(`details ${A}`, details(A));
    resolve(`message ${A}`, message(A));
    await flush();
    expect(s.getState().details).toEqual({ status: 'ready', data: details(A) });
    expect(s.getState().message).toEqual({ status: 'ready', data: message(A) });
    expect(s.getState().sections[0].spec).toEqual({ kind: 'commit', id: A, parent: 1 });
  });

  it('setFocus always issues a new focus request, even for the zone the store already has', () => {
    const { services } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    const n = s.getState().focusRequest;
    s.getState().setFocus('graph');
    expect([s.getState().focus, s.getState().focusRequest]).toEqual(['graph', n + 1]);
    s.getState().setFocus('files');
    s.getState().closeDiff();
    expect([s.getState().focus, s.getState().focusRequest]).toEqual(['graph', n + 3]);
  });

  it('a new graph without the selected commit clears the selection and drops its late results', async () => {
    const { services, resolve } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    s.getState().selectRow(2);
    s.getState().openFile(targetFor({ path: 'x', oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'absent' }, new: { kind: 'object', oid: C }, submodule: false }, { kind: 'commit', id: B, parent: 0 }));
    s.getState().setGraph({ ...graph, rows: [row(C), row(A)] });
    const cleared = { selection: { kind: 'none' }, details: { status: 'idle' }, message: { status: 'idle' }, sections: [], diff: null };
    const pick = () => { const st = s.getState(); return { selection: st.selection, details: st.details, message: st.message, sections: st.sections, diff: st.diff }; };
    expect(pick()).toEqual(cleared);
    resolve(`details ${B}`, details(B));
    resolve(`message ${B}`, message(B));
    resolve(`files {"kind":"commit","id":"${B}","parent":0}`, { files: [], added: 0, deleted: 0 });
    await flush();
    expect(pick()).toEqual(cleared);
  });

  it('exitCompare from a compare-with-working-tree whose commit has no row goes to the WIP row, or clears', () => {
    const { services } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    s.getState().compareWithWorktree('f'.repeat(40), '/r');
    expect(s.getState().compareRows).toEqual({ cursor: null, other: 0 });
    s.getState().exitCompare();
    expect(s.getState().selection).toEqual({ kind: 'wip', index: 0, worktree: '/r', name: null });
    s.getState().compareWithWorktree('f'.repeat(40), '/elsewhere');
    expect(s.getState().compareRows).toEqual({ cursor: null, other: null });
    s.getState().exitCompare();
    expect([s.getState().selection, s.getState().sections]).toEqual([{ kind: 'none' }, []]);
  });

  it('openFirstFile opens the first non-empty section (a WIP row with only staged changes)', async () => {
    const { services, resolve } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    s.getState().selectRow(0);
    s.getState().openFirstFile();
    const staged = { path: 's.txt', oldPath: null, status: 'A', additions: 1, deletions: 0, old: { kind: 'absent' as const }, new: { kind: 'object' as const, oid: C }, submodule: false };
    resolve('files {"kind":"wip","worktree":"/r","staged":false}', { files: [], added: 0, deleted: 0 });
    resolve('files {"kind":"wip","worktree":"/r","staged":true}', { files: [staged], added: 1, deleted: 0 });
    await flush();
    expect(s.getState().diff).toEqual(targetFor(staged, { kind: 'wip', worktree: '/r', staged: true }));
    expect(s.getState().focus).toBe('files');
  });

  it('openFirstFile follows the order it is given (the list as displayed) and prefetches the displayed neighbour', async () => {
    const { services, resolve, calls } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    const spec = { kind: 'commit' as const, id: A, parent: 0 };
    const file = (path: string, status: string) => ({ path, oldPath: null, status, additions: 1, deletions: 0, old: { kind: 'object' as const, oid: B }, new: { kind: 'object' as const, oid: C }, submodule: false });
    s.getState().selectRow(1);
    resolve(`files ${JSON.stringify(spec)}`, { files: [file('a.txt', 'M'), file('b.txt', 'M'), file('z.txt', 'A')], added: 3, deleted: 0 });
    await flush();
    s.getState().openFirstFile((files, sp) => [...files].reverse().map((f) => targetFor(f, sp)));
    expect(s.getState().diff?.path).toBe('z.txt');
    const contents = calls.filter((c) => c.startsWith('contents '));
    expect(contents).toHaveLength(1);
    expect(contents[0]).toContain('"path":"b.txt"');
  });

  it('never prefetches worktree-side contents: they are never cached, so the read would be wasted', () => {
    const { services, calls } = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, services);
    const spec = { kind: 'wip' as const, worktree: '/r', staged: false };
    const f = (path: string, next: 'worktree' | 'object') => targetFor({ path, oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'object', oid: C }, new: next === 'worktree' ? { kind: 'worktree', worktree: '/r' } : { kind: 'object', oid: B }, submodule: false }, spec);
    s.getState().openFile(f('b.txt', 'worktree'), [f('a.txt', 'worktree'), f('c.txt', 'object')]);
    expect(calls.filter((c) => c.startsWith('contents '))).toEqual([expect.stringContaining('"path":"c.txt"')]);
  });

  // Feedback F12: the right panel swaps in one render, once everything for the new selection
  // has arrived; until then it keeps the previous selection's content (stale-while-loading).
  describe('panel (stale-while-loading)', () => {
    const filesOf = (id: string, parent = 0) => `files {"kind":"commit","id":"${id}","parent":${parent}}`;
    const list = (path: string) => ({ files: [change(path, 'M')], added: 1, deleted: 0 });
    async function shown(rec: ReturnType<typeof fakeServices>, s: ReturnType<typeof createRepoViewStore>, index: number, id: string) {
      s.getState().selectRow(index);
      rec.resolve(`details ${id}`, details(id));
      rec.resolve(`message ${id}`, message(id));
      rec.resolve(filesOf(id), list(`${id.slice(0, 1)}.txt`));
      await flush();
    }

    it('shows nothing until the first selection\'s details, message and file list have all arrived', async () => {
      const rec = fakeServices();
      const s = createRepoViewStore(1, '/r', graph, rec.services);
      expect([s.getState().panel, s.getState().panelPending]).toEqual([null, false]);
      s.getState().selectRow(1);
      expect([s.getState().panel, s.getState().panelPending]).toEqual([null, true]);
      rec.resolve(`details ${A}`, details(A));
      rec.resolve(`message ${A}`, message(A));
      await flush();
      expect(s.getState().panel).toBeNull();
      rec.resolve(filesOf(A), list('a.txt'));
      await flush();
      const p = s.getState().panel!;
      expect(s.getState().panelPending).toBe(false);
      expect(p.selection).toEqual({ kind: 'commit', index: 1, id: A });
      expect([p.details, p.message]).toEqual([{ status: 'ready', data: details(A) }, { status: 'ready', data: message(A) }]);
      expect(p.sections.map((x) => x.list.status)).toEqual(['ready']);
    });

    it('keeps the previous commit, unchanged, until all three loads for the next one settle', async () => {
      const rec = fakeServices();
      const s = createRepoViewStore(1, '/r', graph, rec.services);
      await shown(rec, s, 1, A);
      const before = s.getState().panel;
      s.getState().selectRow(3);
      expect(s.getState().panel).toBe(before);
      expect(s.getState().panelPending).toBe(true);
      rec.resolve(filesOf(C), list('c.txt'));
      await flush();
      expect(s.getState().panel).toBe(before);
      rec.resolve(`details ${C}`, details(C));
      await flush();
      expect(s.getState().panel).toBe(before);
      // A failed load counts as arrived: the panel shows the error with the rest.
      rec.reject(`message ${C}`, { kind: 'Git', message: 'boom', commandId: null, stderr: null });
      await flush();
      const p = s.getState().panel!;
      expect(p.selection).toEqual({ kind: 'commit', index: 3, id: C });
      expect(p.message).toEqual({ status: 'error', message: 'boom' });
      expect(s.getState().panelPending).toBe(false);
    });

    it('a cached commit swaps in at once, and unrelated updates keep the same panel object', async () => {
      const rec = fakeServices();
      const s = createRepoViewStore(1, '/r', graph, rec.services);
      await shown(rec, s, 1, A);
      await shown(rec, s, 2, B);
      s.getState().selectRow(1);
      expect(s.getState().panel?.selection).toEqual({ kind: 'commit', index: 1, id: A });
      expect(s.getState().panelPending).toBe(false);
      const p = s.getState().panel;
      s.getState().setFocus('files');
      s.getState().openFile(targetFor(change('a.txt', 'M'), { kind: 'commit', id: A, parent: 0 }));
      expect(s.getState().panel).toBe(p);
    });

    it('the WIP row and a new parent wait for their own lists (never another selection\'s)', async () => {
      const rec = fakeServices();
      const s = createRepoViewStore(1, '/r', graph, rec.services);
      await shown(rec, s, 1, A);
      s.getState().selectRow(0);
      expect(s.getState().panel?.selection.kind).toBe('commit');
      rec.resolve('files {"kind":"wip","worktree":"/r","staged":false}', list('u.txt'));
      await flush();
      expect(s.getState().panel?.selection.kind).toBe('commit');
      rec.resolve('files {"kind":"wip","worktree":"/r","staged":true}', list('s.txt'));
      await flush();
      expect(s.getState().panel?.selection.kind).toBe('wip');
      expect(s.getState().panel?.sections.map((x) => x.title)).toEqual(['Unstaged', 'Staged']);

      s.getState().selectRow(1); // cached: at once
      expect(s.getState().panel?.selection.kind).toBe('commit');
      s.getState().setParent(1);
      expect([s.getState().panel?.parent, s.getState().panelPending]).toEqual([0, true]);
      rec.resolve(filesOf(A, 1), list('p.txt'));
      await flush();
      expect(s.getState().panel?.parent).toBe(1);
      expect(s.getState().panel?.sections[0].spec).toEqual({ kind: 'commit', id: A, parent: 1 });
    });

    it('clearing the selection hides the panel at once', async () => {
      const rec = fakeServices();
      const s = createRepoViewStore(1, '/r', graph, rec.services);
      await shown(rec, s, 2, B);
      s.getState().setGraph({ ...graph, rows: [row(C), row(A)] });
      expect([s.getState().panel, s.getState().panelPending]).toEqual([null, false]);
    });

    it('prefetches the neighbours\' messages too, so Up/Down swaps are instant', () => {
      const rec = fakeServices();
      const s = createRepoViewStore(1, '/r', graph, rec.services);
      s.getState().selectRow(2);
      expect(rec.calls).toContain(`message ${A}`);
      expect(rec.calls).toContain(`message ${C}`);
    });
  });
});

