import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveFile = vi.hoisted(() => vi.fn(async () => true));
const markResolved = vi.hoisted(() => vi.fn(async () => true));
const markAllResolved = vi.hoisted(() => vi.fn(async () => true));
vi.mock('./resolve', () => ({ resolveFile, markResolved, markAllResolved }));
vi.mock('../app/actions', async (orig) => ({ ...(await orig<typeof import('../app/actions')>()), activeTab: () => ({ id: 't' }) }));
vi.mock('../write/ctx', () => ({ writeCtx: (tabId: string, worktree?: string) => ({ tabId, repoId: 1, worktree: worktree ?? '/r' }) }));
vi.mock('../ui/ConfirmDialog', () => ({ confirmAction: vi.fn(async () => true), chooseAction: vi.fn(async () => null) }));

import { buildMenu } from '../menu/registry';
import { useToast } from '../ui/toastStore';
import { draftKey, MERGE_SAVE_FIRST, useMergeDrafts, type MergeDraft } from './mergeDrafts';
import './menus';

const target = { path: 'a.txt', root: '/r', sha: null, upstream: null, diff: { key: 'k', path: 'a.txt', oldPath: null, status: 'U', old: { kind: 'absent' }, new: { kind: 'worktree', worktree: '/r' }, view: 'diff' }, changed: true, deleted: false, list: 'wip', openIn: {} };
const draft = (picked: boolean): MergeDraft => ({
  tabId: 't', repo: 1, worktree: '/r', path: 'a.txt', base: 'h1', segments: [], eol: 'lf',
  picks: { 0: { current: [picked], incoming: [false] } }, text: null, spans: null, edited: [], typed: false,
});
type Row = { kind: string; id: string; disabledReason?: string; run: () => void };
const rows = () => buildMenu('file', target as never, {} as never).filter((r) => r.kind === 'action') as unknown as Row[];
const conflictRows = () => rows().filter((r) => ['file.takeCurrent', 'file.takeIncoming', 'file.markResolved'].includes(r.id));

describe("a Conflicted row's resolutions while the merge tool holds work (2D final I1)", () => {
  beforeEach(() => {
    resolveFile.mockClear();
    markResolved.mockClear();
    useMergeDrafts.setState({ drafts: {} });
  });

  it('are greyed out with "Save the merge first" while the file has unsaved merge-tool work', () => {
    useMergeDrafts.setState({ drafts: { [draftKey('t', '/r', 'a.txt')]: draft(true) } });
    expect(conflictRows().map((r) => r.disabledReason)).toEqual([MERGE_SAVE_FIRST, MERGE_SAVE_FIRST, MERGE_SAVE_FIRST]);
  });

  it('a row run anyway (work typed since the menu opened) never drops the work', () => {
    const [take] = conflictRows();
    useMergeDrafts.setState({ drafts: { [draftKey('t', '/r', 'a.txt')]: draft(true) } });
    const show = vi.spyOn(useToast.getState(), 'show');
    take.run();
    expect(resolveFile).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith(expect.stringContaining(MERGE_SAVE_FIRST), expect.anything());
  });

  it('work with nothing ticked or typed, or none at all, leaves them usable', () => {
    useMergeDrafts.setState({ drafts: { [draftKey('t', '/r', 'a.txt')]: draft(false) } });
    expect(conflictRows().map((r) => r.disabledReason)).toEqual([undefined, undefined, undefined]);
    conflictRows()[0].run();
    expect(resolveFile).toHaveBeenCalledWith({ tabId: 't', repoId: 1, worktree: '/r' }, 'a.txt', { kind: 'current' });
  });
});

describe("a Conflicted folder's Mark resolved (tree mode)", () => {
  const folder = (conflicted: string[] | null) => ({ path: 'gen', root: '/r', openIn: {}, wip: conflicted ? { worktree: '/r', conflicted } : null });
  const folderRows = (conflicted: string[] | null) => (buildMenu('folder', folder(conflicted) as never, {} as never).filter((r) => r.kind === 'action') as unknown as Array<Row & { label: string; tooltip: string }>).filter((r) => r.id === 'folder.markResolved');
  beforeEach(() => {
    markAllResolved.mockClear();
    useMergeDrafts.setState({ drafts: {} });
  });

  it('offers "Mark N files resolved" for the conflicted files under it, first in the menu, and resolves them all in one write', () => {
    const rows = buildMenu('folder', folder(['gen/a.ts', 'gen/b.ts']) as never, {} as never);
    expect(rows[0]).toMatchObject({ kind: 'action', id: 'folder.markResolved', label: 'Mark 2 files resolved', tooltip: 'Mark the 2 files conflicted in gen/ resolved as they are now' });
    expect(folderRows(['gen/a.ts'])[0].label).toBe('Mark 1 file resolved');
    folderRows(['gen/a.ts', 'gen/b.ts'])[0].run();
    expect(markAllResolved).toHaveBeenCalledWith({ tabId: 't', repoId: 1, worktree: '/r' }, ['gen/a.ts', 'gen/b.ts']);
  });

  it('has no row outside a WIP list or with nothing conflicted under it', () => {
    expect(folderRows(null)).toEqual([]);
    expect(folderRows([])).toEqual([]);
  });

  it('is greyed out while one of its files has unsaved merge-tool work, and a run anyway leaves the work', () => {
    const [row] = folderRows(['gen/a.ts', 'a.txt']);
    useMergeDrafts.setState({ drafts: { [draftKey('t', '/r', 'a.txt')]: draft(true) } });
    expect(folderRows(['gen/a.ts', 'a.txt'])[0].disabledReason).toBe(MERGE_SAVE_FIRST);
    const show = vi.spyOn(useToast.getState(), 'show');
    row.run();
    expect(markAllResolved).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith(`${MERGE_SAVE_FIRST}: a.txt has unsaved merge-tool edits`, expect.anything());
  });
});
