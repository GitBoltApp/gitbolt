import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlobPayload } from '../api/gen/BlobPayload';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import type { DiffSpec } from '../api/gen/DiffSpec';
import type { FileChange } from '../api/gen/FileChange';
import type { GraphPayload } from '../api/gen/GraphPayload';

const wipHunks = vi.hoisted(() => vi.fn(async () => ({ base: { index: null, worktree: null }, hunks: [], binary: false, refused: null })));
vi.mock('../api/client', () => ({ api: { listOpeners: vi.fn(async () => []), wipHunks, lfsStatus: vi.fn(async () => ({ used: true, version: '3.8.0', installUrl: 'https://git-lfs.com', filter: true, patterns: [] })) }, errorMessage: (e: { message: string }) => e.message }));
const host = vi.hoisted(() => ({
  attachDiff: vi.fn(), detachDiff: vi.fn(), showDiff: vi.fn(async () => {}), setDiffPrefs: vi.fn(), goToChange: vi.fn(),
  attachFile: vi.fn(), detachFile: vi.fn(), showFile: vi.fn(async () => {}), setFileWordWrap: vi.fn(), focus: vi.fn(), setModifiedEditable: vi.fn(), onModifiedEdit: vi.fn(), modifiedText: vi.fn(() => null), setFileEditable: vi.fn(), onFileEdit: vi.fn(), fileText: vi.fn(() => null), keepViewOnNextShow: vi.fn(), keepDiff: vi.fn((_el: HTMLElement, _next: unknown) => false), keepFile: vi.fn((_el: HTMLElement, _next: unknown) => false),
  setContextMenuHandler: vi.fn(), layout: vi.fn(), setLineGutter: vi.fn(), onDiffSelection: vi.fn(),
}));
vi.mock('./monaco/load', () => ({ loadMonacoHost: async () => host }));

const { Loader } = await import('../data/loader');
const { Lru } = await import('../data/lru');
const { createRepoViewStore, RepoViewContext, targetFor, useRepoView } = await import('../repo/store');
const { fakeServices } = await import('../repo/testServices');
const { DiffPanel } = await import('./DiffPanel');

const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRefs: [], head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] };
const blob = (text: string): BlobPayload => ({ size: text.length, binary: false, encoding: 'UTF-8', eol: 'lf', text, base64: null, hash: null });
const change: FileChange = { path: 'data.csv', oldPath: null, status: 'M', additions: 1, deletions: 1, old: { kind: 'object', oid: 'a'.repeat(40) }, new: { kind: 'worktree', worktree: '/repo' }, submodule: false };
const wip: DiffSpec = { kind: 'wip', worktree: '/repo', staged: false };

function renderPanel(contents: DiffContentsPayload) {
  const loader = new Loader(async () => contents, new Lru<string, DiffContentsPayload>(10));
  const store = createRepoViewStore(3, '/repo', graph, fakeServices({ contents: loader }));
  store.setState({ panel: { sections: [{ title: null, spec: wip, list: { status: 'idle' } }] } as never });
  act(() => store.getState().openFile(targetFor(change, wip)));
  const Connected = () => {
    const diff = useRepoView((s) => s.diff);
    return diff && <DiffPanel target={diff} />;
  };
  return render(<RepoViewContext value={store}><Connected /></RepoViewContext>);
}

beforeEach(() => { wipHunks.mockClear(); host.showDiff.mockClear(); });
afterEach(cleanup);

describe('an LFS file\'s diff', () => {
  it('a WIP text diff has hunk staging; an LFS file\'s has none', async () => {
    renderPanel({ old: blob('a\n'), new: blob('a\nb\n'), tooLarge: false, eolOnly: false, image: false });
    await waitFor(() => expect(wipHunks).toHaveBeenCalled());
    cleanup();
    wipHunks.mockClear();
    host.showDiff.mockClear();
    renderPanel({ old: blob('a\n'), new: blob('a\nb\n'), tooLarge: false, eolOnly: false, image: false, lfs: true });
    await waitFor(() => expect(host.showDiff).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(wipHunks).not.toHaveBeenCalled();
  });

  it('the "not downloaded" placeholder isn\'t a text diff: no editor, no change stepping', async () => {
    const oid = 'c'.repeat(64);
    const lfs = { oid, size: 2048, downloaded: false, pointer: `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 2048\n` };
    const missing = { size: 2048, binary: false, encoding: '', eol: 'none' as const, text: null, base64: null, hash: null, lfs };
    const { findByTestId, getByRole } = renderPanel({ old: blob('a\n'), new: missing, tooLarge: false, eolOnly: false, image: false, lfs: true });
    expect(await findByTestId('lfs-placeholder')).toHaveTextContent('LFS file (2.0 KB), not downloaded');
    expect(getByRole('button', { name: 'Next change' })).toBeDisabled();
    expect(host.showDiff).not.toHaveBeenCalled();
  });
});
