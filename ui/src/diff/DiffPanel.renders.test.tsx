import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BlobPayload } from '../api/gen/BlobPayload';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import type { FileChange } from '../api/gen/FileChange';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { createRepoViewStore, RepoViewContext, targetFor, useRepoView } from '../repo/store';
import { fakeServices } from '../repo/testServices';

// The panel's store reads are memo-safe: it re-renders only when what it shows changes, not on
// every change of the panel's file sections (a WIP list re-read, a new selection's lists).
const host = vi.hoisted(() => ({
  attachDiff: vi.fn(), detachDiff: vi.fn(), keepDiff: vi.fn(() => false), showDiff: vi.fn(async () => {}), setDiffPrefs: vi.fn(), goToChange: vi.fn(),
  attachFile: vi.fn(), detachFile: vi.fn(), keepFile: vi.fn(() => false), showFile: vi.fn(async () => {}), setFileWordWrap: vi.fn(), focus: vi.fn(),
  setContextMenuHandler: vi.fn(), layout: vi.fn(), releaseDetached: vi.fn(),
}));
vi.mock('./monaco/load', () => ({ loadMonacoHost: async () => host }));
vi.mock('../api/client', async (actual) => ({ ...(await actual<typeof import('../api/client')>()), api: { listOpeners: async () => [], openIn: async () => null } }));
// Counts DiffPanel renders through its toolbar (not memoized: it renders whenever the panel does).
const toolbarRenders = vi.hoisted(() => ({ n: 0 }));
vi.mock('./DiffToolbar', async (importOriginal) => {
  const real = await importOriginal<typeof import('./DiffToolbar')>();
  return { ...real, DiffToolbar: (props: Parameters<typeof real.DiffToolbar>[0]) => { toolbarRenders.n++; return real.DiffToolbar(props); } };
});

const { DiffPanel } = await import('./DiffPanel');

const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: true }, truncated: false };
const spec = { kind: 'commit' as const, id: 'c'.repeat(40), parent: 0 };
const blob = (text: string): BlobPayload => ({ size: text.length, binary: false, encoding: 'UTF-8', eol: 'lf', text, base64: null });
const change: FileChange = { path: 'a.txt', oldPath: null, status: 'M', additions: 1, deletions: 1, old: { kind: 'object', oid: 'a'.repeat(40) }, new: { kind: 'object', oid: 'b'.repeat(40) }, submodule: false };

describe('DiffPanel store reads', () => {
  it('a new file-sections array (same lists, same worktree) re-renders nothing', async () => {
    const loader = new Loader(async (): Promise<DiffContentsPayload> => ({ old: blob('a\n'), new: blob('b\n'), tooLarge: false, eolOnly: false, image: false }), new Lru<string, DiffContentsPayload>(10));
    const store = createRepoViewStore(1, '/r', graph, fakeServices({ contents: loader }));
    const target = targetFor(change, spec);
    act(() => store.getState().openFile(target));
    const Connected = () => {
      const diff = useRepoView((s) => s.diff);
      return diff && <DiffPanel target={diff} />;
    };
    render(<RepoViewContext value={store}><Connected /></RepoViewContext>);
    await screen.findByTestId('diff-encoding');
    await waitFor(() => expect(host.showDiff).toHaveBeenCalled());
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const before = toolbarRenders.n;
    const list = { status: 'ready' as const, data: { files: [change], added: 1, deleted: 1 } };
    for (let i = 0; i < 3; i++) {
      act(() => store.setState((s) => ({ panel: { selection: s.selection, marks: s.marks, parent: s.parent, details: s.details, message: s.message, sections: [{ spec, list }] } as never })));
    }
    expect(toolbarRenders.n - before).toBe(0);
  });
});
