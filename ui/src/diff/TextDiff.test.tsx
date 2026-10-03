import { fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { act, Activity } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  attachDiff: vi.fn(), detachDiff: vi.fn(), showDiff: vi.fn(async () => {}), setDiffPrefs: vi.fn(), goToChange: vi.fn(),
  attachFile: vi.fn(), detachFile: vi.fn(), showFile: vi.fn(async () => {}), setFileWordWrap: vi.fn(), focus: vi.fn(), setModifiedEditable: vi.fn(), onModifiedEdit: vi.fn(), modifiedText: vi.fn(() => null), setFileEditable: vi.fn(), onFileEdit: vi.fn(), fileText: vi.fn(() => null), keepViewOnNextShow: vi.fn(), keepDiff: vi.fn((_el: HTMLElement, _next: unknown) => false), keepFile: vi.fn((_el: HTMLElement, _next: unknown) => false),
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
afterEach(() => {
  vi.clearAllMocks();
  host.attachDiff.mockReset();
  host.attachFile.mockReset();
  host.keepDiff.mockReset().mockReturnValue(false);
  host.keepFile.mockReset().mockReturnValue(false);
});

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
    await waitFor(() => expect(host.detachDiff).toHaveBeenCalledWith(expect.any(HTMLElement)));
  });

  it('hidden (a closed diff kept by <Activity>, J16), it keeps the editor attached; shown again, it keeps it, not attaching again', async () => {
    const { TextDiff } = mod;
    // The host holds its editor in the box it was attached to.
    let box: HTMLElement | null = null;
    host.attachDiff.mockImplementation((el: HTMLElement) => { box = el; });
    host.keepDiff.mockImplementation((el: HTMLElement) => el === box);
    const ui = (mode: 'visible' | 'hidden', modified: string) => <Activity mode={mode}><TextDiff path="a.php" original="1" modified={modified} language="php" /></Activity>;
    const view = render(ui('visible', '2'));
    await waitFor(() => expect(host.showDiff).toHaveBeenCalledTimes(1));
    view.rerender(ui('hidden', '2'));
    await act(async () => {});
    expect(host.detachDiff).not.toHaveBeenCalled();
    // Shown again, for another file: kept, told what comes next (so it can hide the old one), shown.
    view.rerender(ui('visible', '3'));
    await waitFor(() => expect(host.showDiff).toHaveBeenLastCalledWith(expect.objectContaining({ modified: '3' })));
    expect(host.keepDiff).toHaveBeenLastCalledWith(box, { path: 'a.php', original: '1', modified: '3' });
    expect(host.attachDiff).toHaveBeenCalledTimes(1);
    expect(host.detachDiff).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(host.detachDiff).toHaveBeenCalledWith(box));
  });
});

describe('useShow', () => {
  // K7: stepping ↑/↓, a file's load lands and renders the next file: that render updates the
  // `onShown` ref at once, but its effects (the next show, and this one's cleanup) wait past a
  // paint. The previous file's show finishing in that window reports *its* view as shown, not the
  // next file's: else the panel's header moved on over the previous file's lines.
  it("a show reports through the callback of the render that asked for it, not a later render's", async () => {
    const { useShow } = await import('./TextDiff');
    let finish!: () => void;
    const show = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    const shownA = vi.fn();
    const shownB = vi.fn();
    const ref = { current: shownA as (() => void) | undefined };
    renderHook(() => useShow(host as never, show, ['a.txt'], ref));
    expect(show).toHaveBeenCalledTimes(1);
    // The next file's render has run (useOnShown set the ref); its effects haven't yet.
    ref.current = shownB;
    await act(async () => finish());
    expect(shownA).toHaveBeenCalledTimes(1);
    expect(shownB).not.toHaveBeenCalled();
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
    await waitFor(() => expect(host.detachFile).toHaveBeenCalled());
  });

  it('hidden and shown again (J16), it keeps the file editor attached', async () => {
    const { FileView } = mod;
    let box: HTMLElement | null = null;
    host.attachFile.mockImplementation((el: HTMLElement) => { box = el; });
    host.keepFile.mockImplementation((el: HTMLElement) => el === box);
    const ui = (mode: 'visible' | 'hidden') => <Activity mode={mode}><FileView path="a.txt" text={'x\n'} language="plaintext" /></Activity>;
    const view = render(ui('visible'));
    await waitFor(() => expect(host.showFile).toHaveBeenCalledTimes(1));
    view.rerender(ui('hidden'));
    await act(async () => {});
    view.rerender(ui('visible'));
    await waitFor(() => expect(host.showFile).toHaveBeenCalledTimes(2));
    expect(host.attachFile).toHaveBeenCalledTimes(1);
    expect(host.detachFile).not.toHaveBeenCalled();
    view.unmount();
  });
});
