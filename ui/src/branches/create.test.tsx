import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import { useTabViews } from '../app/tabStores';
import { useRowEditors } from '../graph/rowEditor';
import { createRepoViewStore } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import * as prompt from '../ui/PromptDialog';
import { createBranchAt } from './create';

const ctx = { tabId: 't', repoId: 1, worktree: '/r' };
const ok = { outcome: null, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [] }, staging: { undo: null, redo: null, off: null }, wip: null };
const A = 'a'.repeat(40);
const row = (id: string): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary: id, bodyFirstLine: '', authorName: '', authorEmail: '', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null });
const graph: GraphPayload = { rows: [row(A)], labels: [], maxLanes: 1, pinnedRef: null, head: { branch: 'refs/heads/main', target: A, detached: false, unborn: false }, truncated: false, worktrees: [] } as unknown as GraphPayload;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useTabViews.setState({ views: {} });
  useRowEditors.setState({ store: null, editor: null });
});

describe('Create branch: the dialog, where the graph has no row for it (spec #2 §9.1)', () => {
  it('checks out by default, and sends what the box says', async () => {
    const ask = vi.spyOn(prompt, 'promptText');
    const create = vi.spyOn(api, 'createBranch').mockResolvedValue(ok as never);
    ask.mockResolvedValueOnce({ value: 'topic', checked: true });
    await createBranchAt(ctx, { sha: A, ref: null });
    expect(ask.mock.calls[0][0].checkbox).toEqual({ label: 'Check out', initial: true });
    expect(create).toHaveBeenCalledWith(1, '/r', expect.objectContaining({ name: 'topic', checkout: true, start: A, expect: { head: null, refs: { 'refs/heads/topic': null } } }), false);
    ask.mockResolvedValueOnce({ value: 'other', checked: false });
    await createBranchAt(ctx, { sha: 'b'.repeat(40), ref: 'refs/remotes/origin/x' });
    expect(create).toHaveBeenLastCalledWith(1, '/r', expect.objectContaining({ startRef: 'refs/remotes/origin/x', checkout: false }), false);
  });
  it('validates the name live', async () => {
    const ask = vi.spyOn(prompt, 'promptText').mockResolvedValue(null);
    await createBranchAt(ctx, { sha: A, ref: null });
    const validate = ask.mock.calls[0][0].validate!;
    expect(validate('a..b')).toBe("A branch name can't contain ..");
    expect(validate('ok/name')).toBeNull();
  });
});

describe('Create branch: inline in the graph row (UX round 1)', () => {
  let store: ReturnType<typeof createRepoViewStore>;
  beforeEach(() => {
    store = createRepoViewStore(1, '/r', graph, fakeServices());
    useTabViews.setState({ views: { t: { repo: 1, services: fakeServices(), store } as never } });
  });
  /** Starts the create, renders the row editor it opened (as GraphView would), and waits it out. */
  async function open() {
    const ask = vi.spyOn(prompt, 'promptText').mockResolvedValue(null);
    const done = createBranchAt(ctx, { sha: A, ref: null });
    const editor = useRowEditors.getState().editor;
    expect(editor?.rowId).toBe(A);
    render(<>{editor!.render()}</>);
    await act(async () => { await done; });
    expect(ask).not.toHaveBeenCalled();
    return screen.getByRole('textbox', { name: 'Branch name' });
  }

  it('opens on the commit\'s row, selected; Enter creates and checks out', async () => {
    const create = vi.spyOn(api, 'createBranch').mockResolvedValue(ok as never);
    const input = await open();
    expect(store.getState().graph.rows[0].id).toBe(A);
    expect(input).toHaveAttribute('placeholder', 'enter branch name');
    fireEvent.change(input, { target: { value: 'topic' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(create).toHaveBeenCalledWith(1, '/r', expect.objectContaining({ name: 'topic', checkout: true }), false);
    expect(useRowEditors.getState().editor).toBeNull();
  });
  it('Ctrl+Enter creates without checking out', async () => {
    const create = vi.spyOn(api, 'createBranch').mockResolvedValue(ok as never);
    const input = await open();
    fireEvent.change(input, { target: { value: 'topic' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(create).toHaveBeenCalledWith(1, '/r', expect.objectContaining({ name: 'topic', checkout: false }), false);
  });
  it('an invalid name shows its reason and Enter does nothing; Esc cancels', async () => {
    const create = vi.spyOn(api, 'createBranch');
    const input = await open();
    fireEvent.change(input, { target: { value: 'a..b' } });
    expect(screen.getByRole('alert')).toHaveTextContent("A branch name can't contain ..");
    expect(input).toHaveAttribute('aria-invalid', 'true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(create).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(useRowEditors.getState().editor).toBeNull();
  });
  it('blur cancels when empty, and keeps a typed name', async () => {
    const input = await open();
    fireEvent.change(input, { target: { value: 'wip' } });
    fireEvent.blur(input);
    expect(useRowEditors.getState().editor).not.toBeNull();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(useRowEditors.getState().editor).toBeNull();
  });
  it('falls back to the dialog when the row never renders', async () => {
    const ask = vi.spyOn(prompt, 'promptText').mockResolvedValue(null);
    await createBranchAt(ctx, { sha: A, ref: null });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(useRowEditors.getState().editor).toBeNull();
  });
});
