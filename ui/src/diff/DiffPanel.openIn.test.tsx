import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlobPayload } from '../api/gen/BlobPayload';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import type { DiffSpec } from '../api/gen/DiffSpec';
import type { FileChange } from '../api/gen/FileChange';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { OpenerPayload } from '../api/gen/OpenerPayload';

const OPENERS: OpenerPayload[] = [
  { id: 'vscode', name: 'VS Code', kind: 'editor' },
  { id: 'file-manager', name: 'Files', kind: 'fileManager' },
];
const listOpeners = vi.hoisted(() => vi.fn(async (): Promise<OpenerPayload[]> => []));
const openIn = vi.hoisted(() => vi.fn(async (_repo: number, _r: unknown): Promise<null> => null));
vi.mock('../api/client', () => ({ api: { listOpeners, openIn, wipHunks: vi.fn(async () => ({ base: { index: null, worktree: null }, hunks: [], binary: false, refused: null })) }, errorMessage: (e: { message: string }) => e.message }));
const host = vi.hoisted(() => ({
  attachDiff: vi.fn(), detachDiff: vi.fn(), showDiff: vi.fn(async () => {}), setDiffPrefs: vi.fn(), goToChange: vi.fn(),
  attachFile: vi.fn(), detachFile: vi.fn(), showFile: vi.fn(async () => {}), setFileWordWrap: vi.fn(), focus: vi.fn(), setModifiedEditable: vi.fn(), onModifiedEdit: vi.fn(), modifiedText: vi.fn(() => null), setFileEditable: vi.fn(), onFileEdit: vi.fn(), fileText: vi.fn(() => null), keepViewOnNextShow: vi.fn(), keepDiff: vi.fn((_el: HTMLElement, _next: unknown) => false), keepFile: vi.fn((_el: HTMLElement, _next: unknown) => false),
  setContextMenuHandler: vi.fn(), layout: vi.fn(), setLineGutter: vi.fn(), onDiffSelection: vi.fn(),
}));
vi.mock('./monaco/load', () => ({ loadMonacoHost: async () => host }));

const { Loader } = await import('../data/loader');
const { Lru } = await import('../data/lru');
const { ContextMenu } = await import('../menu/ContextMenu');
const { createRepoViewStore, RepoViewContext, targetFor, useRepoView } = await import('../repo/store');
const { fakeServices } = await import('../repo/testServices');
const { resetOpenersForTests } = await import('../openIn/openers');
const { DiffPanel } = await import('./DiffPanel');

const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRefs: [], head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] };
const blob = (text: string): BlobPayload => ({ size: text.length, binary: false, encoding: 'UTF-8', eol: 'lf', text, base64: null, hash: null });
const change: FileChange = { path: 'src/app.php', oldPath: null, status: 'M', additions: 1, deletions: 1, old: { kind: 'object', oid: 'a'.repeat(40) }, new: { kind: 'object', oid: 'b'.repeat(40) }, submodule: false };
const contents: DiffContentsPayload = { old: blob('a\nb\nc\n'), new: blob('a\nb\nC\n'), tooLarge: false, eolOnly: false, image: false };

function renderPanel(spec: DiffSpec, file: FileChange = change) {
  const loader = new Loader(async () => contents, new Lru<string, DiffContentsPayload>(10));
  const store = createRepoViewStore(3, '/repo', graph, fakeServices({ contents: loader }));
  // The file list the target came from, as the right panel holds it.
  store.setState({ panel: { sections: [{ title: null, spec, list: { status: 'idle' } }] } as never });
  act(() => store.getState().openFile(targetFor(file, spec)));
  const Connected = () => {
    const diff = useRepoView((s) => s.diff);
    return diff && <DiffPanel target={diff} />;
  };
  render(<RepoViewContext value={store}><Connected /><ContextMenu /></RepoViewContext>);
  return store;
}

beforeEach(() => {
  localStorage.clear();
  resetOpenersForTests();
  listOpeners.mockReset().mockResolvedValue(OPENERS);
  openIn.mockReset().mockResolvedValue(null);
});
afterEach(cleanup);

describe('the diff toolbar\'s "Open in…" (H9, J1)', () => {
  it('sits at the toolbar\'s far left, not in the header, and opens the shown version at its first change', async () => {
    renderPanel({ kind: 'commit', id: 'c'.repeat(40), parent: 0 });
    const main = await screen.findByRole('button', { name: 'Open in VS Code' });
    expect(main.closest('.diff-toolbar-start')).not.toBeNull();
    expect(main.closest('.diff-header')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('diff-encoding')).toBeInTheDocument());
    fireEvent.click(main);
    await waitFor(() => expect(openIn).toHaveBeenCalledExactlyOnceWith(3, { worktree: '/repo', path: 'src/app.php', line: 3, opener: 'vscode', source: change.new, fallback: null }));
  });

  it("a staged WIP file opens the working-tree file of the list's worktree", async () => {
    renderPanel({ kind: 'wip', worktree: '/wt/linked', staged: true });
    await waitFor(() => expect(screen.getByTestId('diff-encoding')).toBeInTheDocument());
    fireEvent.click(await screen.findByRole('button', { name: 'More ways to open' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show in Files' }));
    await waitFor(() => expect(openIn).toHaveBeenCalledExactlyOnceWith(3, { worktree: '/wt/linked', path: 'src/app.php', line: 3, opener: 'file-manager', source: { kind: 'worktree', worktree: '/wt/linked' }, fallback: change.new }));
  });

  it('Escape in its menu closes the menu, not the file', async () => {
    const store = renderPanel({ kind: 'commit', id: 'c'.repeat(40), parent: 0 });
    const toggle = await screen.findByRole('button', { name: 'More ways to open' });
    // A real click focuses a button first (jsdom's `fireEvent.click` doesn't emulate that default
    // action): the shared menu's focus-restore reads whatever had focus when it opened.
    act(() => toggle.focus());
    fireEvent.click(toggle);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(store.getState().diff).not.toBeNull();
    expect(screen.getByRole('button', { name: 'More ways to open' })).toHaveFocus();
  });
});
