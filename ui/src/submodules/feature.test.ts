import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { BlobSource } from '../api/gen/BlobSource';
import { allActions, getAction, runAction } from '../app/actions';
import * as runtime from '../app/runtime';
import { useRuntime } from '../app/runtime';
import { EMPTY_PROFILE, useAppState } from '../app/state';
import type { FileTarget } from '../menu/menuEnv';
import { usePalette } from '../palette/Palette';
import { shortcutSections } from '../shortcuts/catalog';
import { COMMIT_QUEUED, useStaging } from '../stage/store';
import * as confirmDialog from '../ui/ConfirmDialog';
import { useToast } from '../ui/toastStore';
import { submoduleRows } from './feature';
import { submoduleStateText } from './labels';

const res = (outcome: unknown) => ({ outcome, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [] }, staging: { undo: null, redo: null, off: null }, wip: null });
const info = (uses: boolean, unmapped: string[] = []) => ({ remotes: [], mainWorktree: null, commonDir: '/r/.git', submodules: (uses ? { '/r': { unmapped } } : {}) as Record<string, { unmapped: string[] }> });
const A = 'a'.repeat(40);

function repoTab(uses: boolean, unmapped: string[] = []) {
  useAppState.setState({ loaded: true, profile: { ...EMPTY_PROFILE, id: 'default', tabs: [{ id: 't', kind: 'repo', path: '/r', alias: null }], activeTab: 't' } });
  useRuntime.getState().patch('t', { repo: { id: 1, path: '/r', name: 'r', worktree: '/r' }, worktree: '/r', info: info(uses, unmapped) });
}

const target = (over: Partial<FileTarget> & { old?: BlobSource; new?: BlobSource } = {}): FileTarget => {
  const { old = { kind: 'submodule', oid: A }, new: next = { kind: 'submodule', oid: 'b'.repeat(40) }, ...rest } = over;
  return {
    path: 'vendor/parser', root: '/r', sha: null, upstream: null, changed: true, deleted: false, list: 'wip',
    diff: { key: 'k', path: 'vendor/parser', oldPath: null, status: 'M', old, new: next, view: 'diff' },
    openIn: { worktree: '/r', path: 'vendor/parser', line: null, source: null, fallback: null },
    wip: { worktree: '/r', staged: false, oldPath: null, status: 'M', submodule: true },
    ...rest,
  };
};

describe('submodules', () => {
  beforeEach(() => { vi.restoreAllMocks(); useToast.getState().dismiss(); });
  afterEach(() => usePalette.getState().close());

  it('a row says it is a submodule, and its new commits, or the edits inside it when that is all, or that it is not initialised', () => {
    const s = { newCommits: false, modifiedContent: false, untrackedContent: false, uninitialized: false };
    expect(submoduleStateText(undefined)).toBe('submodule');
    expect(submoduleStateText({ ...s, newCommits: true })).toBe('submodule: new commits');
    expect(submoduleStateText({ ...s, newCommits: true, modifiedContent: true, untrackedContent: true })).toBe('submodule: new commits');
    expect(submoduleStateText({ ...s, modifiedContent: true, untrackedContent: true })).toBe('submodule: modified content, untracked content');
    expect(submoduleStateText({ ...s, untrackedContent: true })).toBe('submodule: untracked content');
    expect(submoduleStateText({ ...s, uninitialized: true })).toBe('submodule: not initialised');
  });

  it('the palette actions exist only in a repository that uses submodules', () => {
    const ids = ['submodule.update', 'submodule.sync', 'submodule.open'];
    repoTab(false);
    for (const id of ids) expect(getAction(id)?.when?.(), id).toBe(false);
    repoTab(true);
    for (const id of ids) expect(getAction(id)?.when?.(), id).toBe(true);
    expect(allActions().filter((a) => ids.includes(a.id)).map((a) => a.label)).toEqual(['Submodules: Update', 'Submodules: Sync URLs', 'Submodules: Open in a tab…']);
    // The Keyboard Shortcuts panel lists the two with keys, under Submodules.
    const section = shortcutSections().find((s) => s.title === 'Submodules');
    expect(section?.rows.map((r) => r.label)).toEqual(['Submodules: Update', 'Submodules: Open in a tab…']);
  });

  it('per worktree: another worktree of the tab without submodules has no actions', () => {
    repoTab(true);
    useRuntime.getState().patch('t', { worktree: '/r-other' });
    expect(getAction('submodule.update')?.when?.()).toBe(false);
  });

  it('a gitlink .gitmodules doesn\'t map: the actions say why git can\'t run, the row\'s Update is disabled', async () => {
    repoTab(true, ['inner']);
    const update = vi.spyOn(api, 'submoduleUpdate');
    const list = vi.spyOn(api, 'submodules');
    for (const id of ['submodule.update', 'submodule.sync', 'submodule.open']) {
      useToast.getState().dismiss();
      expect(runAction(id)).toBe(true);
      await vi.waitFor(() => expect(useToast.getState().message).toBe("inner has no entry in .gitmodules: git's submodule commands can't run in this worktree"));
    }
    expect(update).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    const [, up] = submoduleRows(target(), { write: { tabId: 't', repoId: 1, worktree: '/r' }, inProgress: null });
    expect(up.kind === 'action' && up.disabledReason).toBe("inner has no entry in .gitmodules: git's submodule commands can't run in this worktree");
  });

  it('Update and Sync URLs send their writes and say what ran, as the command', async () => {
    repoTab(true);
    const update = vi.spyOn(api, 'submoduleUpdate').mockResolvedValue(res({ command: 'git submodule update --init --recursive' }) as never);
    const sync = vi.spyOn(api, 'submoduleSync').mockResolvedValue(res({ command: 'git submodule sync --recursive' }) as never);
    expect(runAction('submodule.update')).toBe(true);
    await vi.waitFor(() => expect(useToast.getState().message).toBe('Submodules updated'));
    expect(update).toHaveBeenCalledWith(1, '/r', undefined, false);
    expect(useToast.getState().detail).toBe('git submodule update --init --recursive');
    expect(runAction('submodule.sync')).toBe(true);
    await vi.waitFor(() => expect(useToast.getState().message).toBe('Submodule URLs synced'));
    expect(sync).toHaveBeenCalledWith(1, '/r');
    expect(useToast.getState().detail).toBe('git submodule sync --recursive');
  });

  it('Open in a tab… lists the submodules in the palette; a pick opens it, one not initialised says so', async () => {
    repoTab(true);
    vi.spyOn(api, 'submodules').mockResolvedValue([
      { path: 'vendor/parser', commit: A, status: 'newCommits' },
      { path: 'vendor/theme', commit: A, status: 'uninitialized' },
    ]);
    const peek = vi.spyOn(api, 'peekRepo').mockResolvedValue({ remotes: [], branch: 'main' });
    const open = vi.spyOn(runtime, 'openPathInTab').mockResolvedValue();
    expect(runAction('submodule.open')).toBe(true);
    await vi.waitFor(() => expect(usePalette.getState().choices).not.toBeNull());
    const { choices, open: shown } = usePalette.getState();
    expect(shown).toBe(true);
    expect(choices?.title).toBe('Submodules');
    expect(choices?.entries.map((e) => [e.label, e.detail])).toEqual([['vendor/parser', 'new commits'], ['vendor/theme', 'not initialised']]);
    choices?.entries[0].run();
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('/r/vendor/parser'));
    expect(peek).toHaveBeenCalledWith('/r/vendor/parser');
    choices?.entries[1].run();
    expect(useToast.getState().message).toBe("vendor/theme isn't initialised: Submodules: Update checks it out");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("the row's Update is disabled while a commit is queued and mid-merge, as Stage and Discard", () => {
    repoTab(true);
    const write = { tabId: 't', repoId: 1, worktree: '/r' };
    const reason = (inProgress: string | null) => { const r = submoduleRows(target(), { write, inProgress })[1]; return r.kind === 'action' ? r.disabledReason : null; };
    expect(reason(null)).toBeUndefined();
    expect(reason('merge')).toBe('Finish or abort the merge first');
    useStaging.getState().setCommitting(1, '/r', true);
    expect(reason(null)).toBe(COMMIT_QUEUED);
    useStaging.getState().setCommitting(1, '/r', false);
  });

  it('Update over commits on no branch arms in place, in red, then sends again confirmed', async () => {
    repoTab(true);
    const ask = vi.spyOn(confirmDialog, 'confirmAction').mockResolvedValue(true);
    const message = 'Update vendor/parser? Its 2 commits not on any branch will be left behind (still in its reflog)';
    const update = vi.spyOn(api, 'submoduleUpdate')
      .mockRejectedValueOnce({ kind: 'DirtyWorktree', message, detail: { kind: 'submoduleOrphans', paths: ['vendor/parser'], commits: 2 } })
      .mockResolvedValueOnce(res({ command: 'git submodule update --init --recursive' }) as never);
    runAction('submodule.update');
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(ask.mock.calls[0][0]).toMatchObject({ body: message, arm: 'Click again to update vendor/parser, leaving 2 commits behind', danger: true });
    expect(update.mock.calls.map((c) => c[3])).toEqual([false, true]);
  });

  it('the picker stays shut when the user moved on while the list loaded', async () => {
    repoTab(true);
    let answer!: (v: never[]) => void;
    vi.spyOn(api, 'submodules').mockImplementation(() => new Promise((r) => { answer = r; }));
    runAction('submodule.open');
    await vi.waitFor(() => expect(answer).toBeDefined());
    // Another tab became active meanwhile.
    useAppState.setState({ profile: { ...useAppState.getState().profile, activeTab: 'other' } });
    answer([{ path: 'vendor/parser', commit: A, status: 'current' }] as never[]);
    await new Promise((r) => setTimeout(r, 0));
    expect(usePalette.getState().open).toBe(false);
    // The palette opened meanwhile: left as it is.
    repoTab(true);
    runAction('submodule.open');
    await vi.waitFor(() => expect(api.submodules).toHaveBeenCalledTimes(2));
    usePalette.getState().show('>');
    answer([{ path: 'vendor/parser', commit: A, status: 'current' }] as never[]);
    await new Promise((r) => setTimeout(r, 0));
    expect(usePalette.getState().choices).toBeNull();
  });

  it('no submodules to list says so instead of an empty picker', async () => {
    repoTab(true);
    vi.spyOn(api, 'submodules').mockResolvedValue([]);
    runAction('submodule.open');
    await vi.waitFor(() => expect(useToast.getState().message).toBe('This worktree has no submodules'));
    expect(usePalette.getState().open).toBe(false);
  });

  it("a submodule row's menu: Open in a tab, and in a working-tree list Update this submodule", async () => {
    repoTab(true);
    const write = { tabId: 't', repoId: 1, worktree: '/r' };
    expect(submoduleRows(target(), { write, inProgress: null }).map((r) => r.kind === 'action' && r.label)).toEqual(['Open in a tab', 'Update this submodule']);
    // A commit's list: no worktree to update in.
    expect(submoduleRows(target({ list: 'commit', wip: null }), { write, inProgress: null }).map((r) => r.kind === 'action' && r.label)).toEqual(['Open in a tab']);
    // Not a submodule, or removed: nothing.
    expect(submoduleRows(target({ old: { kind: 'object', oid: A }, new: { kind: 'worktree', worktree: '/r' } }), { write, inProgress: null })).toEqual([]);
    expect(submoduleRows(target({ deleted: true, new: { kind: 'absent' } }), { write, inProgress: null })).toEqual([]);
    const update = vi.spyOn(api, 'submoduleUpdate').mockResolvedValue(res({ command: 'git submodule update --init --recursive -- vendor/parser' }) as never);
    const rows = submoduleRows(target(), { write, inProgress: null });
    if (rows[1].kind === 'action') rows[1].run();
    await vi.waitFor(() => expect(useToast.getState().message).toBe('Updated vendor/parser'));
    expect(update).toHaveBeenCalledWith(1, '/r', 'vendor/parser', false);
    // An uninitialised one, opened from its row, says so.
    vi.spyOn(api, 'peekRepo').mockRejectedValue(new Error('not a repository'));
    const open = vi.spyOn(runtime, 'openPathInTab').mockResolvedValue();
    if (rows[0].kind === 'action') rows[0].run();
    await vi.waitFor(() => expect(useToast.getState().message).toBe("vendor/parser isn't initialised: Submodules: Update checks it out"));
    expect(open).not.toHaveBeenCalled();
  });
});
