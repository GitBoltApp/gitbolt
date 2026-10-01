import { describe, expect, it } from 'vitest';
import type { CommitDetailsPayload } from '../api/gen/CommitDetailsPayload';
import type { CommitMessage } from '../api/gen/CommitMessage';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { FileChange } from '../api/gen/FileChange';
import type { RowPayload } from '../api/gen/RowPayload';
import { createRepoViewStore, selectedIndex, targetFor } from './store';
import { recordingServices as fakeServices } from './testServices';
import { WipLists } from './wipLists';
import type { FileListPayload } from '../api/gen/FileListPayload';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const row = (id: string, kind: RowPayload['kind'] = 'commit', wip: RowPayload['wip'] = null): RowPayload => ({
  id, kind, lane: 0, color: 0, segments: [], summary: id.slice(0, 1), bodyFirstLine: '', authorName: 'Ada', authorEmail: 'ada@example.com', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip,
});
const graph: GraphPayload = {
  rows: [row('wip:/r', 'wip', { worktreePath: '/r', worktreeName: null, modified: 1, added: 0, deleted: 0, renamed: 0, conflicted: 0 }), row(A), row(B), row(C)],
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

describe('WIP lists held while watched (K44)', () => {
  const U = 'files {"kind":"wip","worktree":"/r","staged":false}';
  const S = 'files {"kind":"wip","worktree":"/r","staged":true}';
  const lists = (version: string | undefined, path: string) => ({ files: [change(path, 'M')], added: 1, deleted: 0, ...(version ? { version } : {}) });
  const settle = async () => { await flush(); await flush(); };
  const wipCalls = (calls: string[]) => calls.filter((c) => c.includes('"kind":"wip"'));
  const shown = (s: ReturnType<typeof createRepoViewStore>) => s.getState().panel?.sections.map((x) => (x.list.status === 'ready' ? x.list.data.files[0].path : x.list.status));

  async function watchedStore() {
    const rec = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, rec.services);
    s.getState().setWatched(true);
    // The WIP row's lists are loaded ahead as soon as the tab is watched.
    expect(wipCalls(rec.calls)).toEqual([U, S]);
    rec.resolve(U, lists('v1', 'u1.txt'));
    rec.resolve(S, lists('v1', 's1.txt'));
    await settle();
    return { ...rec, s };
  }

  it('selecting the WIP row renders its held lists synchronously, with no request', async () => {
    const { s, calls } = await watchedStore();
    const before = calls.length;
    s.getState().selectRow(0);
    expect(calls.length).toBe(before);
    expect(s.getState().panelPending).toBe(false);
    expect(s.getState().panel?.selection.kind).toBe('wip');
    expect(shown(s)).toEqual(['u1.txt', 's1.txt']);
    // And again after a commit: still nothing read for the WIP row.
    s.getState().selectRow(1);
    s.getState().selectRow(0);
    expect(wipCalls(calls)).toHaveLength(2);
    expect(s.getState().panelPending).toBe(false);
    expect(shown(s)).toEqual(['u1.txt', 's1.txt']);
  });

  it('a watcher change re-reads the lists and updates the selected WIP panel in place', async () => {
    const { s, calls, resolve, services } = await watchedStore();
    s.getState().selectRow(0);
    services.wip.changed(['/r'], { '/r': 'v2' });
    expect(wipCalls(calls)).toEqual([U, S, U, S]);
    // The lists shown stay until the new ones arrive (no loading state).
    expect(shown(s)).toEqual(['u1.txt', 's1.txt']);
    expect(s.getState().panelPending).toBe(false);
    resolve(U, lists('v2', 'u2.txt'));
    resolve(S, lists('v2', 's2.txt'));
    await settle();
    expect(shown(s)).toEqual(['u2.txt', 's2.txt']);
    // Held again: re-selecting reads nothing.
    s.getState().selectRow(1);
    s.getState().selectRow(0);
    expect(wipCalls(calls)).toHaveLength(4);
    expect(shown(s)).toEqual(['u2.txt', 's2.txt']);
  });

  it('a change while another row is selected re-reads ahead, so the next WIP selection is instant', async () => {
    const { s, calls, resolve, services } = await watchedStore();
    s.getState().selectRow(1);
    services.wip.changed(['/r'], { '/r': 'v2' });
    expect(wipCalls(calls)).toHaveLength(4);
    resolve(U, lists('v2', 'u2.txt'));
    resolve(S, lists('v2', 's2.txt'));
    await settle();
    s.getState().selectRow(0);
    expect(s.getState().panelPending).toBe(false);
    expect(shown(s)).toEqual(['u2.txt', 's2.txt']);
  });

  it('unwatched (or once the watch stops), every WIP selection reads its lists, as before', async () => {
    const { s, calls, resolve } = await watchedStore();
    s.getState().setWatched(false);
    s.getState().selectRow(0);
    expect(wipCalls(calls)).toEqual([U, S, U, S]);
    expect(s.getState().panelPending).toBe(true);
    resolve(U, lists('v1', 'u1.txt'));
    resolve(S, lists('v1', 's1.txt'));
    await settle();
    expect(shown(s)).toEqual(['u1.txt', 's1.txt']);
    s.getState().selectRow(1);
    s.getState().selectRow(0);
    expect(wipCalls(calls)).toHaveLength(6);
  });

  it('a degraded watch (lists and events with no version) stops the read-ahead on events and refreshes', async () => {
    const rec = fakeServices();
    const s = createRepoViewStore(1, '/r', graph, rec.services);
    s.getState().setWatched(true);
    rec.resolve(U, lists(undefined, 'u1.txt'));
    rec.resolve(S, lists(undefined, 's1.txt'));
    await settle();
    rec.services.wip.changed(['/r'], {});
    s.getState().setGraph({ ...graph, rows: [...graph.rows] });
    expect(wipCalls(rec.calls)).toHaveLength(2);
    // Selecting the WIP row still reads it.
    s.getState().selectRow(0);
    expect(wipCalls(rec.calls)).toHaveLength(4);
  });

  it('an older refresh landing after a newer one is dropped', async () => {
    const reads: { answer: (l: FileListPayload) => void }[] = [];
    const rec = fakeServices();
    const wip = new WipLists(() => new Promise<FileListPayload>((answer) => reads.push({ answer })));
    const s = createRepoViewStore(1, '/r', graph, { ...rec.services, wip });
    s.getState().setWatched(true);
    reads.splice(0).forEach((r, i) => r.answer(lists('v1', i === 0 ? 'u1.txt' : 's1.txt')));
    await settle();
    s.getState().selectRow(0);
    wip.changed(['/r'], { '/r': 'v2' });
    const older = reads.splice(0);
    wip.changed(['/r'], { '/r': 'v3' });
    const newer = reads.splice(0);
    newer.forEach((r, i) => r.answer(lists('v3', i === 0 ? 'u3.txt' : 's3.txt')));
    await settle();
    older.forEach((r, i) => r.answer(lists('v2', i === 0 ? 'u2.txt' : 's2.txt')));
    await settle();
    expect(shown(s)).toEqual(['u3.txt', 's3.txt']);
    expect(wip.peek(U.slice('files '.length))?.version).toBe('v3');
  });
});

