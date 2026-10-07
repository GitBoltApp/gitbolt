import { beforeEach, describe, expect, it } from 'vitest';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import type { FileChange } from '../api/gen/FileChange';
import type { FileListPayload } from '../api/gen/FileListPayload';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import { useTabViews } from '../app/tabStores';
import { EMPTY_GRAPH } from '../app/testShell';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { DEFAULT_DIFF_PREFS, useDiffPrefs } from '../diff/diffPrefs';
import { MR_FLYOUT } from '../forge/mrStore';
import { createRepoViewStore, fileViewTarget, targetFor, type RepoViewStore } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { closeFlyout, flyoutOf, openFlyout, registerFlyout } from '../ui/flyout/flyout';
import { useToast } from '../ui/toastStore';
import { historyOf, navBack, placeKey, recordPlace, useNavHistory } from './history';
import { fileCommitOf } from './repoPlaces';
import { noteScroll, registerScrollSource, takePendingScroll } from './scroll';

registerFlyout(MR_FLYOUT, () => null);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const row = (id: string): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary: id.slice(0, 1), bodyFirstLine: '', authorName: 'Ada', authorEmail: 'ada@example.com', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null }) as RowPayload;
const wipRow = (path: string): RowPayload => ({ ...row(`wip:${path}`), kind: 'wip', wip: { worktreePath: path, worktreeName: null, modified: 1, added: 0, deleted: 0, renamed: 0, conflicted: 0 } }) as RowPayload;
// Rows: 0 the WIP row of /r, 1 A, 2 B.
const graph: GraphPayload = { ...EMPTY_GRAPH, rows: [wipRow('/r'), row(A), row(B)] };
const change = (path: string): FileChange => ({ path, oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'object', oid: '1'.repeat(40) }, new: { kind: 'object', oid: '2'.repeat(40) }, submodule: false });
/** What each commit (and the working tree /r) holds. */
const trees: Record<string, string[]> = { [A]: ['README.md', 'docs/guide.md'], [B]: ['README.md'], '/r': ['notes.md'] };
const text = (t: string): DiffContentsPayload => ({ old: null, new: { size: t.length, binary: false, encoding: 'UTF-8', eol: 'lf', text: t, base64: null, hash: null }, tooLarge: false, eolOnly: false, image: false });
const specA = { kind: 'commit', id: A, parent: 0 } as const;
const specB = { kind: 'commit', id: B, parent: 0 } as const;
const flush = () => new Promise((r) => setTimeout(r, 0));
const keys = () => historyOf('t').places.map(placeKey);

let store: RepoViewStore;
function setup() {
  const contents = new Loader(async (key: string) => {
    const r = JSON.parse(key) as { path: string; new: { kind: string; commit?: string; worktree?: string } };
    // A list row's sides are blob ids: those exist.
    if (r.new.kind === 'object' || trees[r.new.commit ?? r.new.worktree ?? '']?.includes(r.path)) return text(`# ${r.path}\n`);
    throw new Error(`${r.path}: not found`);
  }, new Lru<string, DiffContentsPayload>(50));
  const files = new Loader(async (key: string) => {
    const spec = JSON.parse(key) as { kind: string; id?: string };
    return { files: spec.kind === 'commit' ? (trees[spec.id!] ?? []).map(change) : [], added: 0, deleted: 0 } as unknown as FileListPayload;
  }, new Lru<string, FileListPayload>(50));
  store = createRepoViewStore(1, '/r', graph, fakeServices({ contents, files }));
  useTabViews.setState({ views: { t: { repo: 1, services: store.getState().services, store } } });
}

beforeEach(() => {
  useNavHistory.setState({ byTab: {} });
  useDiffPrefs.setState({ prefs: DEFAULT_DIFF_PREFS });
  useToast.setState({ message: null });
  closeFlyout('t');
  setup();
});

describe('File View places (spec #5 §3.4)', () => {
  it('opening a file in File View adds a place at its commit; Diff View and graph selection add none', async () => {
    store.getState().selectRow(1);
    await flush();
    store.getState().selectRow(2);
    await flush();
    expect(keys()).toEqual([]);
    store.getState().openFile(targetFor(change('README.md'), specB));
    expect(keys()).toEqual([]);
    store.getState().setView('file');
    expect(historyOf('t').places).toEqual([{ kind: 'file', path: 'README.md', commit: B, view: 'rendered', scrollTop: 0 }]);
  });

  it('stepping through one list in File View replaces the place; a file opened after another kind of place adds one', async () => {
    store.getState().selectRow(1);
    await flush();
    store.getState().openFile(fileViewTarget('README.md', A, specA));
    store.getState().openFile(fileViewTarget('docs/guide.md', A, specA));
    expect(keys()).toEqual([`file:${A}:docs/guide.md`]);
    recordPlace('t', { kind: 'commit', sha: B });
    store.getState().openFile(fileViewTarget('README.md', A, specA));
    expect(keys()).toEqual([`file:${A}:docs/guide.md`, `commit:${B}`, `file:${A}:README.md`]);
  });

  it("fileCommitOf: the commit, a compare's TO, a WIP file's working tree; nothing for a deleted file or a multi-selection", () => {
    const t = targetFor(change('a.md'), specA);
    expect(fileCommitOf({ selection: { kind: 'commit', index: 1, id: A } }, t)).toBe(A);
    expect(fileCommitOf({ selection: { kind: 'compare', from: B, to: A } }, t)).toBe(A);
    expect(fileCommitOf({ selection: { kind: 'wip', index: 0, worktree: '/r', name: null } }, t)).toBe('worktree');
    expect(fileCommitOf({ selection: { kind: 'none' } }, fileViewTarget('a.md', B, specB))).toBe(B);
    expect(fileCommitOf({ selection: { kind: 'commit', index: 1, id: A } }, { ...t, new: { kind: 'absent' } })).toBeNull();
    expect(fileCommitOf({ selection: { kind: 'multi', ids: [A, B], anchor: A } }, t)).toBeNull();
  });

  it('Back reopens a file at another commit, selecting that commit first, with its scroll and view', async () => {
    store.getState().selectRow(1);
    await flush();
    store.getState().openFile({ ...targetFor(change('docs/guide.md'), specA), view: 'file' });
    noteScroll('t', 'file', `file:${A}:docs/guide.md`, 640); // as FileView / the rendered pane note it
    useDiffPrefs.getState().set({ markdownView: 'source' });
    store.getState().selectRow(2);
    await flush();
    store.getState().openFile({ ...targetFor(change('README.md'), specB), view: 'file' });
    expect(historyOf('t').places[0]).toEqual({ kind: 'file', path: 'docs/guide.md', commit: A, view: 'source', scrollTop: 640 });
    useDiffPrefs.getState().set({ markdownView: 'rendered' });
    await navBack('t');
    const s = store.getState();
    expect(s.selection).toMatchObject({ kind: 'commit', id: A });
    expect(s.diff).toMatchObject({ path: 'docs/guide.md', view: 'file' });
    expect(useDiffPrefs.getState().prefs.markdownView).toBe('source');
    expect(takePendingScroll('t', 'file', `file:${A}:docs/guide.md`, 'source')).toMatchObject({ top: 640 });
  });

  it('a long rendered document is captured with its first visible block, and Back asks its view for that block', async () => {
    store.getState().selectRow(1);
    await flush();
    store.getState().openFile({ ...targetFor(change('docs/guide.md'), specA), view: 'file' });
    const key = `file:${A}:docs/guide.md`;
    const off = registerScrollSource('t', 'file', key, () => 9_000, () => ({ block: 42, offset: 7 }));
    store.getState().selectRow(2);
    await flush();
    store.getState().openFile({ ...targetFor(change('README.md'), specB), view: 'file' });
    off();
    expect(historyOf('t').places[0]).toEqual({ kind: 'file', path: 'docs/guide.md', commit: A, view: 'rendered', scrollTop: 9_000, block: { block: 42, offset: 7 } });
    await navBack('t');
    expect(takePendingScroll('t', 'file', key, 'rendered')).toMatchObject({ top: 9_000, block: { block: 42, offset: 7 } });
  });

  it('a file missing at its commit toasts and Back goes on to the place before it', async () => {
    recordPlace('t', { kind: 'file', path: 'README.md', commit: B, view: 'rendered', scrollTop: 0 });
    recordPlace('t', { kind: 'file', path: 'docs/guide.md', commit: B, view: 'rendered', scrollTop: 0 });
    recordPlace('t', { kind: 'commit', sha: A });
    await navBack('t');
    expect(useToast.getState().message).toBe(`docs/guide.md isn't in ${B.slice(0, 6)}`);
    expect(keys()).toEqual([`file:${B}:README.md`, `commit:${A}`]);
    expect(store.getState().selection).toMatchObject({ kind: 'commit', id: B });
    expect(store.getState().diff).toMatchObject({ path: 'README.md', view: 'file' });
  });

  it('a working-tree file place reopens the working-tree file; one deleted since toasts', async () => {
    recordPlace('t', { kind: 'file', path: 'notes.md', commit: 'worktree', view: 'rendered', scrollTop: 0 });
    recordPlace('t', { kind: 'file', path: 'ghost.md', commit: 'worktree', view: 'rendered', scrollTop: 0 });
    recordPlace('t', { kind: 'commit', sha: A });
    await navBack('t');
    expect(useToast.getState().message).toBe("ghost.md isn't in the working tree");
    const s = store.getState();
    expect(s.selection).toMatchObject({ kind: 'wip', worktree: '/r' });
    expect(s.diff).toMatchObject({ path: 'notes.md', view: 'file', new: { kind: 'worktree', worktree: '/r' } });
  });

  it('leaving a file with unsaved edits asks the leave guard once, then goes', async () => {
    recordPlace('t', { kind: 'file', path: 'README.md', commit: A, view: 'rendered', scrollTop: 0 });
    recordPlace('t', { kind: 'commit', sha: B });
    let asked = 0;
    const held: { go: (() => void) | null } = { go: null };
    store.getState().setLeaveGuard((go) => {
      asked++;
      if (held.go) return false; // saved or discarded: nothing left to ask
      held.go = go;
      return true;
    });
    await navBack('t');
    expect(asked).toBe(1);
    expect(store.getState().diff).toBeNull();
    // The prompt is still open: the history hasn't moved yet.
    expect(historyOf('t').cursor).toBe(1);
    held.go!();
    expect(store.getState().diff).toMatchObject({ path: 'README.md', view: 'file' });
    expect(historyOf('t').cursor).toBe(0);
    expect(keys()).toEqual([`file:${A}:README.md`, `commit:${B}`]);
  });

  it('a cancelled leave prompt leaves the history where it was', async () => {
    recordPlace('t', { kind: 'file', path: 'README.md', commit: A, view: 'rendered', scrollTop: 0 });
    recordPlace('t', { kind: 'commit', sha: B });
    store.getState().setLeaveGuard(() => true); // asks, and the user cancels: `go` never runs
    await navBack('t');
    expect(historyOf('t').cursor).toBe(1);
    expect(keys()).toEqual([`file:${A}:README.md`, `commit:${B}`]);
    expect(store.getState().diff).toBeNull();
  });

  it('a tab that moves to another repository (a new view store) loses its history', () => {
    recordPlace('t', { kind: 'commit', sha: A });
    setup();
    expect(keys()).toEqual([]);
  });
});

describe('commit places (spec #5 §3.4)', () => {
  it('a commit that left the loaded history toasts and is skipped', async () => {
    const C = 'c'.repeat(40);
    recordPlace('t', { kind: 'commit', sha: A });
    recordPlace('t', { kind: 'commit', sha: C });
    recordPlace('t', { kind: 'commit', sha: B });
    await navBack('t');
    expect(useToast.getState().message).toBe(`${C.slice(0, 6)} isn't in the loaded history`);
    expect(store.getState().selection).toMatchObject({ kind: 'commit', id: A });
  });

  it('restoring a file or a commit closes the MR/PR view', async () => {
    recordPlace('t', { kind: 'commit', sha: A });
    recordPlace('t', { kind: 'mr', number: 12, scrollTop: 0 });
    openFlyout('t', MR_FLYOUT, { number: 12 });
    await navBack('t');
    expect(flyoutOf('t')).toBeNull();
    expect(store.getState().selection).toMatchObject({ kind: 'commit', id: A });
  });
});
