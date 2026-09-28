import { fireEvent, render, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  attachDiff: vi.fn(), detachDiff: vi.fn(), showDiff: vi.fn(async () => {}), setDiffPrefs: vi.fn(), goToChange: vi.fn(),
  attachFile: vi.fn(), detachFile: vi.fn(), showFile: vi.fn(async () => {}), setFileWordWrap: vi.fn(), focus: vi.fn(),
  setContextMenuHandler: vi.fn(), layout: vi.fn(),
}));
const load = vi.hoisted(() => ({ fail: false }));
vi.mock('./monaco/load', () => ({
  loadMonacoHost: async () => {
    if (load.fail) throw new Error('chunk failed to load');
    return host;
  },
}));

// `useMonacoHost` keeps a loaded host in a module variable. Each test imports fresh modules, so
// every test starts with no host loaded, whatever order the tests run in.
let mod: { TextDiff: typeof import('./TextDiff').TextDiff; FileView: typeof import('./FileView').FileView; useDiffPrefs: typeof import('./diffPrefs').useDiffPrefs };
beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  load.fail = false;
  const [t, f, p] = await Promise.all([import('./TextDiff'), import('./FileView'), import('./diffPrefs')]);
  mod = { TextDiff: t.TextDiff, FileView: f.FileView, useDiffPrefs: p.useDiffPrefs };
});
afterEach(() => vi.clearAllMocks());

describe('TextDiff', () => {
  it('a failed editor load shows the error and Retry loads it again', async () => {
    const { TextDiff } = mod;
    load.fail = true;
    const view = render(<TextDiff path="a.php" original="1" modified="2" language="php" />);
    expect(await view.findByRole('alert')).toHaveTextContent('chunk failed to load');
    expect(host.attachDiff).not.toHaveBeenCalled();
    load.fail = false;
    fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(host.showDiff).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.php' })));
    expect(host.attachDiff).toHaveBeenCalledWith(view.getByTestId('text-diff'), { path: 'a.php', original: '1', modified: '2' });
    expect(view.queryByRole('alert')).toBeNull();
    view.unmount();
  });

  it('attaches the shared editor, shows the texts, follows prefs and detaches on unmount', async () => {
    const { TextDiff, useDiffPrefs } = mod;
    const view = render(<TextDiff path="a.php" original="<?php 1" modified="<?php 2" language="php" />);
    await waitFor(() => expect(host.showDiff).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.php', original: '<?php 1', modified: '<?php 2', language: 'php' })));
    // With what it will show, so the shared editor can hide another view's diff meanwhile (H6).
    expect(host.attachDiff).toHaveBeenCalledWith(view.getByTestId('text-diff'), { path: 'a.php', original: '<?php 1', modified: '<?php 2' });
    // The shared editor must exist before anything is shown in it (MonacoHost's contract).
    expect(host.attachDiff.mock.invocationCallOrder[0]).toBeLessThan(host.showDiff.mock.invocationCallOrder[0]);
    act(() => useDiffPrefs.getState().set({ mode: 'split' }));
    expect(host.setDiffPrefs).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'split' }));
    view.unmount();
    expect(host.detachDiff).toHaveBeenCalled();
  });
});

describe('FileView', () => {
  it('word wrap goes through the editor options: the file is not shown again, so its scroll position survives', async () => {
    const { FileView, useDiffPrefs } = mod;
    const view = render(<FileView path="a.txt" text={'x\n'} language="plaintext" />);
    await waitFor(() => expect(host.showFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.txt', text: 'x\n', wordWrap: false })));
    act(() => useDiffPrefs.getState().set({ wordWrap: true }));
    expect(host.setFileWordWrap).toHaveBeenLastCalledWith(true);
    expect(host.showFile).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(host.detachFile).toHaveBeenCalled();
  });
});
