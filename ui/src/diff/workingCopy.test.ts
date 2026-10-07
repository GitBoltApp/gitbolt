import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';

const writeWorktreeFile = vi.hoisted(() => vi.fn());
const diffContents = vi.hoisted(() => vi.fn());
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: { writeWorktreeFile, diffContents } }));
const choose = vi.hoisted(() => vi.fn());
vi.mock('../ui/ConfirmDialog', async (orig) => ({ ...(await orig<typeof import('../ui/ConfirmDialog')>()), chooseAction: choose }));
const host = vi.hoisted(() => ({ modifiedText: vi.fn((_p?: string): string | null => 'edited\n'), fileText: vi.fn(() => null), keepViewOnNextShow: vi.fn() }));
vi.mock('./monaco/load', () => ({ loadMonacoHost: async () => host }));
vi.mock('../write/client', () => ({ applyResult: vi.fn() }));
vi.mock('../debug/errorToast', () => ({ toastActionError: vi.fn() }));

import { guardTabClose, isEditableTarget, saveWorkingCopy, suspendCopy, trackCopy, useWorkingCopy, worktreeFileTarget } from './workingCopy';
import { toastActionError } from '../debug/errorToast';

const wipTarget = { key: '{"kind":"wip","worktree":"/r","staged":false}|a.txt', path: 'a.txt', oldPath: null, status: 'M', old: { kind: 'object', oid: 'i' }, new: { kind: 'worktree', worktree: '/r' }, view: 'diff' } as const;
const contents = (hash: string | null, binary = false): DiffContentsPayload => ({ old: null, new: { size: 6, binary, encoding: 'UTF-8', eol: 'lf', text: 'a\n', base64: null, hash }, tooLarge: false, eolOnly: false, image: false });
const ok = (hash: string) => ({ outcome: { hash }, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [] }, staging: { undo: null, redo: null, off: null }, wip: null });

beforeEach(() => {
  writeWorktreeFile.mockReset();
  diffContents.mockReset();
  choose.mockReset();
  useWorkingCopy.setState({ copies: { t: { key: wipTarget.key, path: 'a.txt', worktree: '/r', repo: 1, base: 'h0', dirty: true, view: 'diff' } }, epoch: {} });
  host.modifiedText.mockReset();
  host.modifiedText.mockImplementation(() => 'edited\n');
  vi.mocked(toastActionError).mockClear();
});

describe('the editable working copy (spec #2 §7.5)', () => {
  it('only the working-tree side of a WIP text diff is editable', () => {
    expect(isEditableTarget(wipTarget, contents('h0'))).toBe(true);
    expect(isEditableTarget({ ...wipTarget, new: { kind: 'object', oid: 'x' } }, contents('h0'))).toBe(false);
    expect(isEditableTarget({ ...wipTarget, key: '{"kind":"worktree","from":"c","worktree":"/r"}|a.txt' }, contents('h0'))).toBe(false);
    expect(isEditableTarget(wipTarget, contents('h0', true))).toBe(false);
    expect(isEditableTarget(wipTarget, { ...contents('h0'), tooLarge: true })).toBe(false);
    expect(isEditableTarget({ ...wipTarget, status: 'U' }, contents('h0')), 'the merge tool edits a conflict').toBe(false);
    expect(isEditableTarget(wipTarget, { ...contents('h0'), new: null }), 'deleted').toBe(false);
    expect(isEditableTarget(wipTarget, { ...contents('h0'), new: { ...contents('h0').new!, filtered: true } }), "a clean filter's text isn't the file's").toBe(false);
  });

  it("G.2: File View of a staged WIP file loads (and edits) its working-tree file; nothing else changes", () => {
    const staged = { ...wipTarget, key: '{"kind":"wip","worktree":"/r","staged":true}|a.txt', old: { kind: 'object', oid: 'h' }, new: { kind: 'object', oid: 'i' }, view: 'file' } as const;
    const t = worktreeFileTarget(staged);
    expect(t).toEqual({ ...staged, old: { kind: 'object', oid: 'i' }, new: { kind: 'worktree', worktree: '/r' } });
    expect(isEditableTarget(t, contents('h0'))).toBe(true);
    // The Diff View, a deletion, a conflict, a commit's file and an unstaged file are left alone.
    for (const keep of [{ ...staged, view: 'diff' as const }, { ...staged, new: { kind: 'absent' as const } }, { ...staged, status: 'U' }, { ...staged, key: '{"kind":"commit","id":"c","parent":0}|a.txt' }, { ...wipTarget, view: 'file' as const }]) {
      expect(worktreeFileTarget(keep)).toBe(keep);
    }
  });

  it('saves the editor text behind its base, then takes the new hash and reloads', async () => {
    writeWorktreeFile.mockResolvedValue(ok('h1'));
    expect(await saveWorkingCopy('t')).toBe('saved');
    expect(writeWorktreeFile).toHaveBeenCalledWith(1, '/r', 'a.txt', 'edited\n', 'h0');
    expect(useWorkingCopy.getState().copies.t).toMatchObject({ base: 'h1', dirty: false });
    expect(useWorkingCopy.getState().epoch.t).toBe(1);
    expect(host.keepViewOnNextShow).toHaveBeenCalled();
  });

  it('2B final I3: saving a clean copy (Ctrl+S with no edits) writes nothing', async () => {
    useWorkingCopy.setState((s) => ({ copies: { t: { ...s.copies.t!, dirty: false } } }));
    expect(await saveWorkingCopy('t')).toBe('saved');
    expect(writeWorktreeFile).not.toHaveBeenCalled();
    expect(useWorkingCopy.getState().epoch.t).toBeUndefined();
  });

  it('a stale save offers Reload and Overwrite; Overwrite saves again over the new base', async () => {
    writeWorktreeFile.mockRejectedValueOnce({ kind: 'Stale', message: 'a.txt changed on disk', commandId: null, stderr: null, detail: null }).mockResolvedValueOnce(ok('h3'));
    diffContents.mockResolvedValue(contents('h2'));
    choose.mockResolvedValue('overwrite');
    expect(await saveWorkingCopy('t')).toBe('saved');
    expect(choose).toHaveBeenCalledWith(expect.objectContaining({ title: 'a.txt changed on disk', choices: [expect.objectContaining({ id: 'reload', label: 'Reload' }), expect.objectContaining({ id: 'overwrite', label: 'Overwrite' })] }));
    expect(writeWorktreeFile).toHaveBeenLastCalledWith(1, '/r', 'a.txt', 'edited\n', 'h2');
  });

  it('a stale save then Reload drops the edits and reloads; Cancel keeps them', async () => {
    writeWorktreeFile.mockRejectedValue({ kind: 'Stale', message: 'a.txt changed on disk', commandId: null, stderr: null, detail: null });
    choose.mockResolvedValueOnce(null);
    expect(await saveWorkingCopy('t')).toBe('kept');
    expect(useWorkingCopy.getState().copies.t?.dirty).toBe(true);
    choose.mockResolvedValueOnce('reload');
    expect(await saveWorkingCopy('t')).toBe('kept');
    expect(useWorkingCopy.getState().copies.t?.dirty).toBe(false);
    expect(useWorkingCopy.getState().epoch.t).toBe(1);
  });

  it('C3: refuses to save while the editor shows another path', async () => {
    host.modifiedText.mockImplementation(() => null);
    expect(await saveWorkingCopy('t')).toBe('failed');
    expect(writeWorktreeFile).not.toHaveBeenCalled();
    expect(toastActionError).toHaveBeenCalled();
  });

  it('asks the editor for the tracked path only', async () => {
    writeWorktreeFile.mockResolvedValue(ok('h1'));
    await saveWorkingCopy('t');
    expect(host.modifiedText).toHaveBeenCalledWith(wipTarget.key);
  });

  it('edits typed while the save was in flight stay, still dirty', async () => {
    host.modifiedText.mockImplementationOnce(() => 'edited\n').mockImplementation(() => 'edited\nmore');
    writeWorktreeFile.mockResolvedValue(ok('h1'));
    expect(await saveWorkingCopy('t')).toBe('kept');
    expect(useWorkingCopy.getState().copies.t).toMatchObject({ base: 'h1', dirty: true });
    expect(useWorkingCopy.getState().epoch.t).toBeUndefined();
  });

  it('Overwrite after the file vanished does not save over an empty base', async () => {
    writeWorktreeFile.mockRejectedValueOnce({ kind: 'Stale', message: 'a.txt changed on disk', commandId: null, stderr: null, detail: null });
    diffContents.mockResolvedValue({ ...contents('x'), new: null });
    choose.mockResolvedValue('overwrite');
    expect(await saveWorkingCopy('t')).toBe('kept');
    expect(writeWorktreeFile).toHaveBeenCalledTimes(1);
    expect(toastActionError).toHaveBeenCalled();
  });

  it('C1: a hidden tab keeps its dirty copy as a draft, and tracking again keeps it', () => {
    suspendCopy('t', host as never);
    expect(useWorkingCopy.getState().copies.t).toMatchObject({ dirty: true, draft: 'edited\n' });
    trackCopy('t', 1, { ...wipTarget }, contents('h9'));
    expect(useWorkingCopy.getState().copies.t).toMatchObject({ dirty: true, base: 'h0', draft: 'edited\n' });
  });

  it('a clean copy is dropped when the tab hides', () => {
    useWorkingCopy.setState({ copies: { t: { ...useWorkingCopy.getState().copies.t!, dirty: false } } });
    suspendCopy('t', host as never);
    expect(useWorkingCopy.getState().copies.t).toBeUndefined();
  });

  it('closing a tab with unsaved edits asks; Cancel keeps it open, Discard closes it', async () => {
    const go = vi.fn();
    choose.mockResolvedValueOnce(null);
    guardTabClose(['t'], go);
    await new Promise((r) => setTimeout(r, 0));
    expect(go).not.toHaveBeenCalled();
    choose.mockResolvedValueOnce('discard');
    guardTabClose(['t'], go);
    await new Promise((r) => setTimeout(r, 0));
    expect(go).toHaveBeenCalledTimes(1);
    guardTabClose(['t'], go);
    expect(go).toHaveBeenCalledTimes(2);
  });

  it('two tabs on the same relative path in different worktrees never swap text', async () => {
    const keyB = '{"kind":"wip","worktree":"/other","staged":false}|a.txt';
    // The shared editor shows tab B's a.txt.
    host.modifiedText.mockImplementation((id?: string) => (id === keyB ? 'B text\n' : null));
    expect(await saveWorkingCopy('t')).toBe('failed');
    expect(writeWorktreeFile).not.toHaveBeenCalled();
    suspendCopy('t', host as never);
    expect(useWorkingCopy.getState().copies.t?.draft).toBeUndefined();
  });
});
