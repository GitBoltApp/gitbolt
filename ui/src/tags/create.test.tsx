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
import { useToast } from '../ui/toast';
import { createTagAt } from './create';

const ctx = { tabId: 't', repoId: 1, worktree: '/r' };
const ok = { outcome: null, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [], paused: null }, staging: { undo: null, redo: null, off: null }, wip: null };
const A = 'a'.repeat(40);
const row = (id: string): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary: id, bodyFirstLine: '', authorName: '', authorEmail: '', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null });
const graph = { rows: [row(A)], labels: [], maxLanes: 1, pinnedRef: null, head: { branch: 'refs/heads/main', target: A, detached: false, unborn: false }, truncated: false, worktrees: [] } as unknown as GraphPayload;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useTabViews.setState({ views: {} });
  useRowEditors.setState({ store: null, editor: null });
});

describe('Create tag here: inline in the graph row (spec #3 §3.9)', () => {
  beforeEach(() => {
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    useTabViews.setState({ views: { t: { repo: 1, services: fakeServices(), store } as never } });
  });
  async function open(annotated: boolean) {
    const ask = vi.spyOn(prompt, 'promptText').mockResolvedValue(null);
    const done = createTagAt(ctx, A, annotated);
    const editor = useRowEditors.getState().editor;
    expect(editor?.rowId).toBe(A);
    render(<>{editor!.render()}</>);
    await act(async () => { await done; });
    expect(ask).not.toHaveBeenCalled();
    return screen.getByRole('textbox', { name: 'Tag name' });
  }
  it('lightweight: Enter creates it and says so', async () => {
    const create = vi.spyOn(api, 'createTag').mockResolvedValue(ok as never);
    const input = await open(false);
    fireEvent.change(input, { target: { value: 'v1' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(create).toHaveBeenCalledWith(1, '/r', { name: 'v1', target: A, message: null });
    await vi.waitFor(() => expect(useToast.getState().message).toBe('Created tag v1'));
    expect(useRowEditors.getState().editor).toBeNull();
  });
  it('annotated: the name, then the message', async () => {
    const create = vi.spyOn(api, 'createTag').mockResolvedValue(ok as never);
    const input = await open(true);
    fireEvent.change(input, { target: { value: 'v2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const message = screen.getByRole('textbox', { name: 'Tag message' });
    fireEvent.change(message, { target: { value: 'Release two' } });
    fireEvent.keyDown(message, { key: 'Enter' });
    expect(create).toHaveBeenCalledWith(1, '/r', { name: 'v2', target: A, message: 'Release two' });
    await vi.waitFor(() => expect(useToast.getState().message).toBe('Created annotated tag v2'));
  });
});

describe('Create tag here: the dialog, where the graph has no row for it', () => {
  it('asks the name, then (annotated) the message', async () => {
    const ask = vi.spyOn(prompt, 'promptText').mockResolvedValueOnce({ value: 'v3', checked: false }).mockResolvedValueOnce({ value: 'Three', checked: false });
    const create = vi.spyOn(api, 'createTag').mockResolvedValue(ok as never);
    await createTagAt(ctx, 'b'.repeat(40), true);
    expect(ask.mock.calls.map((c) => c[0].label)).toEqual(['Tag name', 'Tag message']);
    expect(create).toHaveBeenCalledWith(1, '/r', { name: 'v3', target: 'b'.repeat(40), message: 'Three' });
  });
});
