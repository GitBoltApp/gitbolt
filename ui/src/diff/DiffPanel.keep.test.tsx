import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommitMessageCache } from '../api/commitMessages';
import type { BlobPayload } from '../api/gen/BlobPayload';
import type { CommitDetailsPayload } from '../api/gen/CommitDetailsPayload';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import type { FileListPayload } from '../api/gen/FileListPayload';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';

// J16: a closed diff's panel is kept (hidden), with the shared editor still attached in it.
// The host remembers the box it was attached to, as the real one does.
const host = vi.hoisted(() => {
  const h = {
    box: null as HTMLElement | null,
    attachDiff: vi.fn((el: HTMLElement) => { h.box = el; }),
    detachDiff: vi.fn((el: HTMLElement) => { if (h.box === el) h.box = null; }),
    keepDiff: vi.fn((el: HTMLElement, _next: unknown) => el === h.box),
    showDiff: vi.fn(async (_req: { path: string; modified: string }) => {}),
    setDiffPrefs: vi.fn(), goToChange: vi.fn(),
    attachFile: vi.fn(), detachFile: vi.fn(), keepFile: vi.fn(() => false), showFile: vi.fn(async () => {}), setFileWordWrap: vi.fn(), focus: vi.fn(),
    setContextMenuHandler: vi.fn(), layout: vi.fn(),
    // As the real host's: lets go of a box that left the document.
    releaseDetached: vi.fn(() => { if (h.box && !h.box.isConnected) h.detachDiff(h.box); }),
  };
  return h;
});
vi.mock('./monaco/load', () => ({ loadMonacoHost: async () => host }));
// Counts DiffPanel renders through its toolbar (not memoized: it renders whenever the panel does).
const toolbarRenders = vi.hoisted(() => ({ n: 0 }));
vi.mock('./DiffToolbar', async (importOriginal) => {
  const real = await importOriginal<typeof import('./DiffToolbar')>();
  return { ...real, DiffToolbar: (props: Parameters<typeof real.DiffToolbar>[0]) => { toolbarRenders.n++; return real.DiffToolbar(props); } };
});
vi.mock('../api/client', async (actual) => ({ ...(await actual<typeof import('../api/client')>()), api: { listOpeners: async () => [], openIn: async () => null } }));
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}) }));
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { Loader } = await import('../data/loader');
const { Lru } = await import('../data/lru');
const { fakeServices } = await import('../repo/testServices');
const { RepoView } = await import('../repo/RepoView');

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const row = (id: string, summary: string, parents: string[]): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary, bodyFirstLine: '', authorName: 'Grace Hopper', authorEmail: 'grace@example.com', authorTime: 1_767_225_600, committerTime: 1_767_225_600, parents, mrRefs: [], wip: null });
const graph: GraphPayload = { rows: [row(A, 'Second', [B]), row(B, 'First', [])], labels: [], maxLanes: 1, pinnedRef: null, head: { branch: 'refs/heads/main', target: A, detached: false, unborn: false }, truncated: false };
const details = (id: string, parents: string[]): CommitDetailsPayload => ({ id, parents, coAuthors: [], signed: false, author: { name: 'Grace Hopper', email: 'grace@example.com', time: 1_767_225_600 }, committer: { name: 'Ada Lovelace', email: 'ada@example.com', time: 1_767_225_660 } });
const file = (path: string) => ({ path, oldPath: null, status: 'M', additions: 1, deletions: 1, old: { kind: 'object' as const, oid: B }, new: { kind: 'object' as const, oid: A }, submodule: false });
const list: FileListPayload = { files: [file('a.txt'), file('b.txt')], added: 2, deleted: 2 };
const blob = (text: string): BlobPayload => ({ size: text.length, binary: false, encoding: 'UTF-8', eol: 'lf', text, base64: null });

function renderView() {
  const services = fakeServices({
    details: new Loader(async (id) => ({ [A]: details(A, [B]), [B]: details(B, []) })[id], new Lru(10)),
    messages: createCommitMessageCache(async (id) => ({ id, summary: id === A ? 'Second' : 'First', body: '' })),
    files: new Loader(async () => list, new Lru(10)),
    contents: new Loader(async (key: string): Promise<DiffContentsPayload> => ({ old: blob('old\n'), new: blob(`${key.includes('b.txt') ? 'b' : 'a'} new\n`), tooLarge: false, eolOnly: false, image: false }), new Lru(10)),
  });
  return render(<RepoView repo={1} repoPath="/r" graph={graph} services={services} />);
}
const fileRow = (path: string) => screen.getAllByRole('option').find((o) => o.getAttribute('data-path') === path)!;
const openRow = async (path: string) => {
  await act(async () => fireEvent.mouseDown(fileRow(path), { button: 0, detail: 1 }));
  await waitFor(() => expect(screen.getByTestId('diff-path')).toHaveTextContent(path), W);
};

// Generous waits: a full run on a loaded machine is slow.
const W = { timeout: 3000 };

describe('a closed diff is kept, hidden (J16)', () => {
  afterEach(() => vi.clearAllMocks());

  it('the hidden panel does not re-render when the graph selection moves', async () => {
    renderView();
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    await screen.findByRole('listbox', { name: 'Changed files' }, W);
    await openRow('a.txt');
    await act(async () => fireEvent.mouseDown(fileRow('a.txt'), { button: 0, detail: 1 }));
    expect(screen.queryByRole('region', { name: 'Diff' })).toBeNull();
    const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    await settle();
    const before = toolbarRenders.n;
    // Select the other commit, then back: each moves the panel's sections, details and message.
    for (const i of [1, 0, 1]) {
      fireEvent.mouseDown(screen.getAllByRole('row')[i]);
      await waitFor(() => expect(screen.getAllByRole('row')[i]).toHaveAttribute('aria-selected', 'true'), W);
      await waitFor(() => expect(screen.getByRole('complementary', { name: 'Commit details' })).toHaveAttribute('aria-busy', 'false'), W);
      await settle();
    }
    expect(toolbarRenders.n - before).toBe(0);
  });

  it('the view unmounting while the kept panel is hidden lets the editor go of its box', async () => {
    const view = renderView();
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    await screen.findByRole('listbox', { name: 'Changed files' }, W);
    await openRow('a.txt');
    await waitFor(() => expect(host.attachDiff).toHaveBeenCalledTimes(1), W);
    const box = host.box!;
    await act(async () => fireEvent.mouseDown(fileRow('a.txt'), { button: 0, detail: 1 }));
    expect(screen.queryByRole('region', { name: 'Diff' })).toBeNull();
    // Hidden: the attach cleanup ran and kept the editor (the box is still in the document).
    await act(async () => {});
    expect(host.detachDiff).not.toHaveBeenCalled();
    expect(box.isConnected).toBe(true);
    // Unmounted while hidden: React runs no cleanup of the panel's again; the view's releases it.
    view.unmount();
    await act(async () => {});
    expect(host.releaseDetached).toHaveBeenCalled();
    expect(host.detachDiff).toHaveBeenCalledWith(box);
    expect(host.box).toBeNull();
  });

  it('close then reopen: the editor stays attached (no attach, no detach), and the reopen presents again', async () => {
    renderView();
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    await screen.findByRole('listbox', { name: 'Changed files' }, W);
    await openRow('a.txt');
    await waitFor(() => expect(host.showDiff).toHaveBeenCalledTimes(1), W);
    expect(host.attachDiff).toHaveBeenCalledTimes(1);
    const box = host.box!;
    // Close (the open file's row toggles it, H5b): the panel's gone from the accessibility tree
    // and the screen, but its box (and the editor in it) stays.
    await act(async () => fireEvent.mouseDown(fileRow('a.txt'), { button: 0, detail: 1 }));
    expect(screen.queryByRole('region', { name: 'Diff' })).toBeNull();
    expect(screen.getByRole('grid', { name: 'Commit graph' })).toBeVisible();
    expect(box.isConnected).toBe(true);
    // Hidden, it takes no keys.
    fireEvent.keyDown(document.body, { key: 'F7' });
    fireEvent.keyDown(document.body, { key: 'ArrowDown', shiftKey: true });
    expect(host.goToChange).not.toHaveBeenCalled();
    // Reopen: kept, not attached again; shown again, through the same editor.
    await openRow('a.txt');
    await waitFor(() => expect(host.showDiff).toHaveBeenCalledTimes(2), W);
    // And another file, after a close: the editor is told what comes next, so it can hide the
    // closed file's diff until then (H6).
    await act(async () => fireEvent.mouseDown(fileRow('a.txt'), { button: 0, detail: 1 }));
    await openRow('b.txt');
    await waitFor(() => expect(host.showDiff).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'b.txt' })), W);
    expect(host.keepDiff).toHaveBeenLastCalledWith(box, expect.objectContaining({ path: 'b.txt', modified: 'b new\n' }));
    expect(host.attachDiff).toHaveBeenCalledTimes(1);
    expect(host.detachDiff).not.toHaveBeenCalled();
    // F7 works again once it's shown.
    fireEvent.keyDown(document.body, { key: 'F7' });
    await waitFor(() => expect(host.goToChange).toHaveBeenCalledWith('next'), W);
  });

  it("reopened on another file, it never presents the closed file's header or body first (H6)", async () => {
    renderView();
    fireEvent.mouseDown(screen.getAllByRole('row')[0]);
    await screen.findByRole('listbox', { name: 'Changed files' }, W);
    await openRow('a.txt');
    await waitFor(() => expect(host.showDiff).toHaveBeenCalledTimes(1), W);
    await act(async () => fireEvent.mouseDown(fileRow('a.txt'), { button: 0, detail: 1 }));
    // Every render the reopened panel commits shows b.txt (or nothing yet), never a.txt.
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      const region = screen.queryByRole('region', { name: 'Diff' });
      if (region) seen.push(region.querySelector('[data-testid="diff-path"]')?.textContent ?? '');
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    await openRow('b.txt');
    observer.disconnect();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((p) => p.includes('a.txt'))).toEqual([]);
  });
});
