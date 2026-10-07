import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveFile = vi.hoisted(() => vi.fn(async () => true));
const markResolved = vi.hoisted(() => vi.fn(async () => true));
vi.mock('./resolve', () => ({ resolveFile, markResolved }));
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
