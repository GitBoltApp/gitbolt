import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { Activity } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';

type Toggle = (id: number, side: 'current' | 'incoming', line: number | 'hunk') => void;
const out = { text: 'one\ni\ntwo\n', edited: new Set<number>(), typed: false };
const calls = { create: vi.fn(), setRegions: vi.fn(), reveal: vi.fn(), dispose: vi.fn(), toggleAtCursor: vi.fn((_t: unknown) => false) };
const cbs = { toggle: [] as Toggle[], restored: [] as Array<(p: unknown) => void>, edit: [] as Array<() => void> };
vi.mock('./editors', () => ({
  createMergeEditors: (...a: unknown[]) => {
    calls.create(...a);
    return {
      output: { getValue: () => out.text },
      setRegions: (...x: unknown[]) => calls.setRegions(...x),
      regionsNow: () => [{ id: 0, start: 2, lines: 1 }],
      edited: () => out.edited,
      snapshot: () => ({ text: out.text, spans: [{ id: 0, from: 4, to: 6 }], edited: [...out.edited], typed: out.typed }),
      cursorLine: () => 1,
      onToggle: (cb: Toggle) => cbs.toggle.push(cb),
      onEdit: (cb: () => void) => cbs.edit.push(cb),
      onPicksRestored: (cb: (p: unknown) => void) => cbs.restored.push(cb),
      onCursor: () => {},
      toggleAtCursor: (t: unknown) => calls.toggleAtCursor(t),
      setChecks: vi.fn(),
      reveal: (...x: unknown[]) => calls.reveal(...x),
      dispose: () => calls.dispose(),
    };
  },
}));
const confirm = vi.fn(async (..._a: unknown[]) => true);
const choose = vi.fn(async (..._a: unknown[]): Promise<string | null> => null);
vi.mock('../ui/ConfirmDialog', () => ({ confirmAction: (...a: unknown[]) => confirm(...a), chooseAction: (...a: unknown[]) => choose(...a) }));
const resolve = vi.fn(async (..._a: unknown[]) => true);
vi.mock('./resolve', () => ({ resolveFile: (...a: unknown[]) => resolve(...a) }));

import { MergeTool, SWITCH_WAIT_MS, useShownConflict } from './MergeTool';
import { draftKey, useMergeDrafts } from './mergeDrafts';
import { useToast } from '../ui/toastStore';

// Every conflict line carries its own terminator (the 2D EOL ruling).
const payload = {
  path: 'a.txt', kind: 'bothModified', text: true,
  segments: [{ kind: 'common', text: 'one\n' }, { kind: 'conflict', id: 0, base: ['b\n'], current: ['c\n'], incoming: ['i\n'] }, { kind: 'common', text: 'two\n' }],
  current: { text: 'one\nc\ntwo\n', regions: [{ id: 0, start: 2, lines: 1 }] }, incoming: { text: 'one\ni\ntwo\n', regions: [{ id: 0, start: 2, lines: 1 }] },
  labels: { current: 'main', incoming: 'feature/x' }, encoding: 'UTF-8', eol: 'lf', base: 'h1',
};
const ctx = { tabId: 't', repoId: 1, worktree: '/r' };
const key = draftKey('t', '/r', 'a.txt');
const takeAll = (i: 0 | 1) => screen.getAllByRole('checkbox', { name: 'Take all from this side' })[i];
/** N4: the tool is up once its labels show and its editors exist (their effect may land later). */
const ready = async (n = 1) => {
  await screen.findByText('Current: main');
  await waitFor(() => expect(calls.create).toHaveBeenCalledTimes(n));
};
const loadPayload = (p: unknown = payload) => vi.spyOn(api, 'conflictFile').mockResolvedValue(p as never);

describe('the merge tool (spec #2 §13.3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    for (const f of Object.values(calls)) f.mockClear();
    calls.toggleAtCursor.mockImplementation(() => false);
    confirm.mockReset();
    confirm.mockImplementation(async () => true);
    choose.mockReset();
    resolve.mockReset();
    resolve.mockImplementation(async () => true);
    cbs.toggle.length = 0;
    cbs.restored.length = 0;
    cbs.edit.length = 0;
    out.text = 'one\ni\ntwo\n';
    out.edited = new Set();
    out.typed = false;
    useMergeDrafts.setState({ drafts: {} });
  });

  it('labels the panes for the user, takes a side, and saves the output', async () => {
    loadPayload();
    const onResolved = vi.fn();
    render(<MergeTool ctx={ctx} path="a.txt" onResolved={onResolved} />);
    await ready();
    expect(await screen.findByText('Incoming: feature/x')).toBeInTheDocument();
    fireEvent.click(takeAll(1));
    expect(calls.setRegions).toHaveBeenCalledWith([{ id: 0, lines: ['i\n'] }], expect.anything(), expect.anything());
    await waitFor(() => expect(takeAll(1)).toBeChecked());
    expect(useMergeDrafts.getState().drafts[key]).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Save and mark resolved' }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(expect.anything(), 'a.txt', { kind: 'text', text: 'one\ni\ntwo\n' }, 'h1', expect.any(Function)));
    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    expect(useMergeDrafts.getState().drafts[key]).toBeUndefined();
  });

  it('asks before saving a region with nothing picked; a no keeps nothing', async () => {
    loadPayload();
    render(<MergeTool ctx={ctx} path="a.txt" />);
    await ready();
    confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Save and mark resolved' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Mark resolved with unresolved conflicts?', body: '1 conflict is still unresolved (nothing picked or typed): it will be saved empty.', confirmLabel: 'Mark resolved anyway' })));
    expect(resolve).not.toHaveBeenCalled();
    await waitFor(() => expect(useMergeDrafts.getState().drafts[key]).toBeUndefined());
    act(() => cbs.toggle[cbs.toggle.length - 1](0, 'current', 0));
    expect(calls.setRegions).toHaveBeenLastCalledWith([{ id: 0, lines: ['c\n'] }], expect.anything(), expect.anything());
  });

  it('says "them" for several empty conflicts (M6)', async () => {
    const two = { ...payload, segments: [...payload.segments, { kind: 'conflict', id: 1, base: [], current: ['x\n'], incoming: [] }] };
    loadPayload(two);
    confirm.mockResolvedValueOnce(false);
    render(<MergeTool ctx={ctx} path="a.txt" />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Save and mark resolved' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ body: '2 conflicts are still unresolved (nothing picked or typed): they will be saved empty.' })));
  });

  it('Ctrl+S while the question is open does nothing more (M7)', async () => {
    loadPayload();
    let answer: (ok: boolean) => void = () => {};
    confirm.mockImplementationOnce(() => new Promise<boolean>((r) => { answer = r; }));
    render(<MergeTool ctx={ctx} path="a.txt" />);
    await ready();
    fireEvent.keyDown(window, { key: 's', code: 'KeyS', ctrlKey: true });
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(window, { key: 's', code: 'KeyS', ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Save and mark resolved' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    await act(async () => answer(false));
    expect(resolve).not.toHaveBeenCalled();
  });

  it("a hand-edited region isn't empty: Ctrl+S saves the typed text without asking", async () => {
    loadPayload();
    render(<MergeTool ctx={ctx} path="a.txt" />);
    await ready();
    out.edited = new Set([0]);
    out.typed = true;
    out.text = 'one\nmine\ntwo\n';
    fireEvent.keyDown(window, { key: 's', code: 'KeyS', ctrlKey: true });
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(expect.anything(), 'a.txt', { kind: 'text', text: 'one\nmine\ntwo\n' }, 'h1', expect.any(Function)));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('F7, Shift+F7 and the arrows move between the regions; the count says where (M13)', async () => {
    loadPayload();
    render(<MergeTool ctx={ctx} path="a.txt" />);
    await ready();
    expect(await screen.findByText('1 conflict')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'F7' });
    expect(calls.reveal).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(window, { key: 'F7', shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Next conflict' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous conflict' }));
    expect(calls.reveal).toHaveBeenCalledTimes(4);
  });

  it('a hunk tick rebuilds that region; a second unticks it; Space ticks the pane cursor line (M2)', async () => {
    loadPayload();
    render(<MergeTool ctx={ctx} path="a.txt" />);
    await ready();
    act(() => cbs.toggle[cbs.toggle.length - 1](0, 'incoming', 'hunk'));
    expect(calls.setRegions).toHaveBeenLastCalledWith([{ id: 0, lines: ['i\n'] }], expect.anything(), expect.anything());
    act(() => cbs.toggle[cbs.toggle.length - 1](0, 'incoming', 'hunk'));
    expect(calls.setRegions).toHaveBeenLastCalledWith([{ id: 0, lines: [] }], expect.anything(), expect.anything());
    calls.toggleAtCursor.mockImplementationOnce(() => true);
    const ev = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    expect(calls.toggleAtCursor).toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });

  it('Ctrl+Z back to a tick brings its ticks back (M8)', async () => {
    loadPayload();
    render(<MergeTool ctx={ctx} path="a.txt" />);
    await ready();
    fireEvent.click(takeAll(1));
    expect(takeAll(1)).toBeChecked();
    act(() => cbs.restored[cbs.restored.length - 1]({ 0: { current: [false], incoming: [false] } }));
    expect(takeAll(1)).not.toBeChecked();
  });

  it('keeps the ticks and the output across a hidden tab, with no refetch (C1)', async () => {
    const fetch = loadPayload();
    const view = render(<Activity mode="visible"><MergeTool ctx={ctx} path="a.txt" /></Activity>);
    await ready();
    fireEvent.click(takeAll(1));
    view.rerender(<Activity mode="hidden"><MergeTool ctx={ctx} path="a.txt" /></Activity>);
    await waitFor(() => expect(calls.dispose).toHaveBeenCalledTimes(1));
    expect(useMergeDrafts.getState().drafts[key]).toMatchObject({ picks: { 0: { current: [false], incoming: [true] } }, text: 'one\ni\ntwo\n' });
    view.rerender(<Activity mode="visible"><MergeTool ctx={ctx} path="a.txt" /></Activity>);
    await waitFor(() => expect(calls.create).toHaveBeenCalledTimes(2));
    expect(calls.create.mock.calls[1][3]).toMatchObject({ picks: { 0: { incoming: [true] } }, output: { text: 'one\ni\ntwo\n', spans: [{ id: 0, from: 4, to: 6 }] } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps them across another file too: back on it, the tool comes back as it was (C1)', async () => {
    loadPayload();
    const view = render(<MergeTool key="a" ctx={ctx} path="a.txt" />);
    await ready();
    fireEvent.click(takeAll(1));
    view.unmount();
    render(<MergeTool key="a2" ctx={ctx} path="a.txt" />);
    await ready(2);
    await waitFor(() => expect(takeAll(1)).toBeChecked());
    expect(calls.create.mock.calls.at(-1)?.[3]).toMatchObject({ output: { text: 'one\ni\ntwo\n' } });
  });

  it('drops kept work whose conflict changed, and says so', async () => {
    const show = vi.spyOn(useToast.getState(), 'show');
    useMergeDrafts.setState({ drafts: { [key]: { tabId: 't', repo: 1, worktree: '/r', path: 'a.txt', base: 'h1', segments: [], eol: 'lf', picks: { 0: { current: [true], incoming: [false] } }, text: 'x', spans: [], edited: [], typed: false } } });
    loadPayload();
    render(<MergeTool ctx={ctx} path="a.txt" />);
    await ready();
    await waitFor(() => expect(show).toHaveBeenCalledWith('The conflict in a.txt changed: your merge of it was dropped', expect.anything()));
    expect(takeAll(0)).not.toBeChecked();
  });

  it('a failed load offers Retry (M10)', async () => {
    const fetch = vi.spyOn(api, 'conflictFile').mockRejectedValueOnce({ message: 'boom' }).mockResolvedValueOnce(payload as never);
    render(<MergeTool ctx={ctx} path="a.txt" />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't read the conflict in a.txt: boom");
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await ready();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a side with no lines anywhere has nothing to take (M5)', async () => {
    loadPayload({ ...payload, segments: [{ kind: 'conflict', id: 0, base: [], current: [], incoming: ['i\n'] }] });
    render(<MergeTool ctx={ctx} path="a.txt" />);
    await ready();
    expect(takeAll(0)).toBeDisabled();
    expect(takeAll(0)).not.toBeChecked();
    expect(takeAll(1)).toBeEnabled();
  });

  it('a mixed-EOL file says so', async () => {
    loadPayload({ ...payload, eol: 'mixed' });
    render(<MergeTool ctx={ctx} path="a.txt" />);
    expect(await screen.findByRole('note')).toHaveTextContent('Mixed line endings');
  });

  it('a non-text conflict gets the buttons, never an editor', async () => {
    loadPayload({ ...payload, kind: 'deletedByThem', text: false, segments: [], current: null, incoming: null });
    render(<MergeTool ctx={ctx} path="a.txt" />);
    expect(await screen.findByText('Modified in main (current), deleted in feature/x (incoming)')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Output' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Take current' }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(ctx, 'a.txt', { kind: 'current' }, 'h1', expect.any(Function)));
  });

  it('a first hand edit typed just before the tab hides is kept, debounce or not (N1)', async () => {
    loadPayload();
    const view = render(<Activity mode="visible"><MergeTool ctx={ctx} path="a.txt" /></Activity>);
    await ready();
    out.typed = true;
    out.text = 'one\ntyped\ntwo\n';
    act(() => cbs.edit[cbs.edit.length - 1]());
    view.rerender(<Activity mode="hidden"><MergeTool ctx={ctx} path="a.txt" /></Activity>);
    await waitFor(() => expect(calls.dispose).toHaveBeenCalledTimes(1));
    expect(useMergeDrafts.getState().drafts[key]).toMatchObject({ text: 'one\ntyped\ntwo\n', typed: true });
  });

  it('a file deleted on disk says so, offers a copy of the output, and never saves (N6)', async () => {
    loadPayload({ ...payload, base: null });
    render(<MergeTool ctx={ctx} path="a.txt" />);
    await ready();
    expect(await screen.findByRole('alert')).toHaveTextContent('a.txt was deleted on disk');
    expect(screen.getByRole('button', { name: 'Copy output' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and mark resolved' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(window, { key: 's', code: 'KeyS', ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Save and mark resolved' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(resolve).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("a file no longer conflicted says so; the editors go when the tool closes", async () => {
    loadPayload();
    const view = render(<MergeTool ctx={ctx} path="a.txt" />);
    await ready();
    view.unmount();
    expect(calls.dispose).toHaveBeenCalledTimes(1);
    vi.spyOn(api, 'conflictFile').mockResolvedValue(null);
    render(<MergeTool ctx={ctx} path="b.txt" />);
    expect(await screen.findByText("b.txt isn't conflicted any more.")).toBeInTheDocument();
  });
});

describe('switching files without an empty frame (UX round 1)', () => {
  const nonText = { ...payload, path: 'gone.txt', kind: 'deletedByUs', text: false, segments: [], current: null, incoming: null };

  beforeEach(() => {
    vi.restoreAllMocks();
    useMergeDrafts.setState({ drafts: {} });
  });

  it('a payload read ahead is up on the first paint, with no read of its own', () => {
    const fetch = vi.spyOn(api, 'conflictFile');
    render(<MergeTool ctx={ctx} path="gone.txt" initial={nonText as never} />);
    expect(screen.getByText('Deleted in main (current), modified in feature/x (incoming)')).toBeInTheDocument();
    expect(screen.queryByText('Loading the conflict…')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the previous file up until the next one is read, then swaps in its payload', async () => {
    let answer: (f: unknown) => void = () => {};
    vi.spyOn(api, 'conflictFile').mockImplementation(() => new Promise((r) => { answer = r; }) as never);
    const { result, rerender } = renderHook(({ path }) => useShownConflict(ctx, path), { initialProps: { path: 'a.txt' } });
    expect(result.current).toEqual({ id: '/r|a.txt', path: 'a.txt' });
    rerender({ path: 'gone.txt' });
    expect(result.current.path).toBe('a.txt');
    await act(async () => answer(nonText));
    expect(result.current).toEqual({ id: '/r|gone.txt', path: 'gone.txt', file: nonText });
  });

  it('a slow read switches anyway after a moment (the tool then shows its loading line)', () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(api, 'conflictFile').mockImplementation(() => new Promise(() => {}) as never);
      const { result, rerender } = renderHook(({ path }) => useShownConflict(ctx, path), { initialProps: { path: 'a.txt' } });
      rerender({ path: 'gone.txt' });
      act(() => { vi.advanceTimersByTime(SWITCH_WAIT_MS); });
      expect(result.current).toEqual({ id: '/r|gone.txt', path: 'gone.txt', file: undefined });
    } finally {
      vi.useRealTimers();
    }
  });
});
