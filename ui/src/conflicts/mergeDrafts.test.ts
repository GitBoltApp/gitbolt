import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { GraphPayload } from '../api/gen/GraphPayload';

const confirm = vi.fn(async (..._a: unknown[]) => true);
const choose = vi.fn(async (..._a: unknown[]): Promise<string | null> => null);
vi.mock('../ui/ConfirmDialog', () => ({ confirmAction: (...a: unknown[]) => confirm(...a), chooseAction: (...a: unknown[]) => choose(...a) }));
const resolve = vi.fn(async (..._a: unknown[]) => true);
vi.mock('./resolve', () => ({ resolveFile: (...a: unknown[]) => resolve(...a) }));

import { guardTabClose, installLeaveGuard } from '../diff/workingCopy';
import { createRepoViewStore, targetFor } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { draftKey, getDraft, pruneClosedTabs, pruneResolved, registerLive, reloadDraft, saveMerge, STORED_DRAFTS, storedDrafts, useMergeDrafts, type MergeDraft } from './mergeDrafts';
import { useToast } from '../ui/toast';
import { wipKey } from '../repo/wipLists';

const key = draftKey('t', '/r', 'a.txt');
const segments = [{ kind: 'common' as const, text: 'one\n' }, { kind: 'conflict' as const, id: 0, base: ['b\n'], current: ['c\n'], incoming: ['i\n'] }];
const draft = (over: Partial<MergeDraft> = {}): MergeDraft => ({
  tabId: 't', repo: 1, worktree: '/r', path: 'a.txt', base: 'h1', segments, eol: 'lf',
  picks: { 0: { current: [true], incoming: [false] } }, text: 'one\nc\n', spans: [{ id: 0, from: 4, to: 6 }], edited: [], typed: false, ...over,
});
const stale = { kind: 'Stale', message: 'a.txt changed on disk', commandId: null, stderr: null };
const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the merge tool's kept work (spec #2 §13.3)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    confirm.mockReset();
    confirm.mockImplementation(async () => true);
    choose.mockReset();
    resolve.mockReset();
    resolve.mockImplementation(async () => true);
    useMergeDrafts.setState({ drafts: {} });
  });

  it('a save sends the kept output behind its base, then forgets it', async () => {
    useMergeDrafts.setState({ drafts: { [key]: draft() } });
    expect(await saveMerge(key)).toBe(true);
    expect(resolve).toHaveBeenCalledWith({ tabId: 't', repoId: 1, worktree: '/r' }, 'a.txt', { kind: 'text', text: 'one\nc\n' }, 'h1', expect.any(Function));
    expect(getDraft(key)).toBeUndefined();
  });

  it('a Stale save offers Reload from disk and Overwrite; Overwrite resends with the fresh base (I1)', async () => {
    useMergeDrafts.setState({ drafts: { [key]: draft() } });
    resolve.mockImplementationOnce(async (...a: unknown[]) => !(a[4] as (e: unknown) => boolean)(stale));
    choose.mockResolvedValueOnce('overwrite');
    const read = vi.spyOn(api, 'conflictFile').mockResolvedValueOnce({ base: 'h2' } as never);
    expect(await saveMerge(key)).toBe(true);
    expect(choose).toHaveBeenCalledWith(expect.objectContaining({ title: 'a.txt changed on disk', choices: [{ id: 'reload', label: 'Reload from disk' }, { id: 'overwrite', label: 'Overwrite', danger: true }] }));
    expect(read).toHaveBeenCalledWith(1, '/r', 'a.txt');
    expect(resolve).toHaveBeenLastCalledWith(expect.anything(), 'a.txt', { kind: 'text', text: 'one\nc\n' }, 'h2', expect.any(Function));
  });

  it('Reload from disk keeps the ticks, drops the typed output, and rebuilds the shown tool (I1)', async () => {
    useMergeDrafts.setState({ drafts: { [key]: draft({ typed: true, edited: [0], text: 'typed\n' }) } });
    const reset = vi.fn();
    const off = registerLive(key, { tabId: 't', flush: () => {}, reset, done: () => {} });
    resolve.mockImplementationOnce(async (...a: unknown[]) => !(a[4] as (e: unknown) => boolean)(stale));
    choose.mockResolvedValueOnce('reload');
    expect(await saveMerge(key)).toBe(false);
    expect(getDraft(key)).toMatchObject({ picks: { 0: { current: [true] } }, text: null, spans: null, edited: [], typed: false, base: undefined });
    expect(reset).toHaveBeenCalledTimes(1);
    reloadDraft(key);
    expect(reset).toHaveBeenCalledTimes(2);
    off();
  });

  it('leaving the shown file with unsaved merge work asks; Discard drops it and goes (C1)', async () => {
    useMergeDrafts.setState({ drafts: { [key]: draft() } });
    const reset = vi.fn();
    const off = registerLive(key, { tabId: 't', flush: () => {}, reset, done: () => {} });
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    const offGuard = installLeaveGuard('t', store);
    const other = targetFor({ path: 'b.txt', oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'absent' }, new: { kind: 'worktree', worktree: '/r' }, submodule: false }, { kind: 'wip', worktree: '/r', staged: false });
    choose.mockResolvedValueOnce(null);
    act(() => store.getState().openFile(other));
    await tick();
    expect(choose).toHaveBeenCalledWith(expect.objectContaining({ title: 'Save your changes to a.txt?', choices: [{ id: 'save', label: 'Save' }, { id: 'discard', label: 'Discard edits', danger: true }] }));
    expect(store.getState().diff).toBeNull();
    choose.mockResolvedValueOnce('discard');
    act(() => store.getState().openFile(other));
    await tick();
    expect(store.getState().diff?.path).toBe('b.txt');
    expect(getDraft(key)).toBeUndefined();
    expect(reset).toHaveBeenCalled();
    offGuard();
    off();
  });

  it('closing a tab with kept merge work asks; Save resolves it, then the tab closes (C1)', async () => {
    useMergeDrafts.setState({ drafts: { [key]: draft() } });
    const go = vi.fn();
    choose.mockResolvedValueOnce('save');
    guardTabClose(['t'], go);
    await vi.waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(getDraft(key)).toBeUndefined();
  });

  it('work with nothing ticked or typed never asks', async () => {
    useMergeDrafts.setState({ drafts: { [key]: draft({ picks: { 0: { current: [false], incoming: [false] } } }) } });
    const go = vi.fn();
    guardTabClose(['t'], go);
    expect(go).toHaveBeenCalledTimes(1);
    expect(choose).not.toHaveBeenCalled();
  });

  it('Overwrite on a file deleted on disk says so and stops, rather than looping on Stale (N6)', async () => {
    useMergeDrafts.setState({ drafts: { [key]: draft() } });
    const show = vi.spyOn(useToast.getState(), 'show');
    const reset = vi.fn();
    const off = registerLive(key, { tabId: 't', flush: () => {}, reset, done: () => {} });
    resolve.mockImplementationOnce(async (...a: unknown[]) => !(a[4] as (e: unknown) => boolean)(stale));
    choose.mockResolvedValueOnce('overwrite');
    vi.spyOn(api, 'conflictFile').mockResolvedValueOnce({ base: null } as never);
    expect(await saveMerge(key)).toBe(false);
    expect(show).toHaveBeenCalledWith('a.txt was deleted on disk', expect.anything());
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalled();
    off();
  });

  it('work on a file resolved elsewhere goes once the WIP list no longer has it conflicted (N2)', () => {
    useMergeDrafts.setState({ drafts: { [key]: draft(), [draftKey('t', '/r', 'b.txt')]: draft({ path: 'b.txt' }) } });
    const lists: Record<string, unknown> = { [wipKey('/r', false)]: { files: [{ path: 'b.txt', status: 'U' }, { path: 'a.txt', status: 'M' }] } };
    const services = { wip: { peek: (k: string) => lists[k] } } as never;
    pruneResolved('other', services, new Set(['/r']));
    expect(getDraft(key)).toBeDefined();
    pruneResolved('t', services, new Set(['/r']));
    expect(getDraft(key)).toBeUndefined();
    expect(getDraft(draftKey('t', '/r', 'b.txt'))).toBeDefined();
    // A list that isn't held can't tell: the work stays.
    pruneResolved('t', { wip: { peek: () => undefined } } as never, new Set(['/r']));
    expect(getDraft(draftKey('t', '/r', 'b.txt'))).toBeDefined();
  });

  it("a closed tab's work goes (N2)", () => {
    useMergeDrafts.setState({ drafts: { [key]: draft(), [draftKey('u', '/r', 'a.txt')]: draft({ tabId: 'u' }) } });
    pruneClosedTabs(new Set(['u']));
    expect(getDraft(key)).toBeUndefined();
    expect(getDraft(draftKey('u', '/r', 'a.txt'))).toBeDefined();
  });

  it('stores only the newest drafts, none too big; a failed store clears the old snapshot (N3)', () => {
    const many = Object.fromEntries(Array.from({ length: STORED_DRAFTS + 5 }, (_, i) => [`k${i}`, draft({ at: i })]));
    const kept = storedDrafts({ ...many, huge: draft({ at: 999, text: 'x'.repeat(1_000_001) }) });
    expect(Object.keys(kept)).toHaveLength(STORED_DRAFTS);
    expect(kept.huge).toBeUndefined();
    expect(kept.k0).toBeUndefined();
    expect(kept[`k${STORED_DRAFTS + 4}`]).toBeDefined();
    sessionStorage.setItem('gitbolt.mergeDrafts', '{"old":{}}');
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('QuotaExceededError'); });
    useMergeDrafts.setState({ drafts: { [key]: draft() } });
    expect(set).toHaveBeenCalled();
    expect(sessionStorage.getItem('gitbolt.mergeDrafts')).toBeNull();
  });
});
