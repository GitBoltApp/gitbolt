import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createCommitMessageCache } from '../api/commitMessages';
import type { CommitDetailsPayload } from '../api/gen/CommitDetailsPayload';
import type { CommitMessage } from '../api/gen/CommitMessage';
import type { FileListPayload } from '../api/gen/FileListPayload';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { RepoView } from './RepoView';
import type { RepoServices } from './services';
import { fakeServices } from './testServices';

vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}) }));

// Counts renders of the two heavy children a right-panel drag (K26) must not re-render per
// pointer event: the graph and the details panel. The graph stub exposes `onSelect` through a
// button, so the real selection/store/panel-loading path still runs under test.
const renders = vi.hoisted(() => ({ graph: 0, details: 0 }));
vi.mock('../graph/GraphView', () => ({
  GraphView: (props: { onSelect?: (i: number) => void }) => {
    renders.graph++;
    return <button type="button" data-testid="select-first" onClick={() => props.onSelect?.(0)} />;
  },
}));
vi.mock('../details/DetailsPanel', () => ({ DetailsPanel: () => { renders.details++; return null; } }));

/** Waits a frame: PanelResizer's drag writes the live width in a `requestAnimationFrame`. */
const nextFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const row = (id: string, summary: string, parents: string[]): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary, bodyFirstLine: '', authorName: 'Grace Hopper', authorEmail: 'grace@example.com', authorTime: 0, committerTime: 0, parents, mrRefs: [], wip: null });
const graph: GraphPayload = { rows: [row(A, 'Second', [B]), row(B, 'First', [])], labels: [], maxLanes: 1, pinnedRef: null, head: { branch: 'refs/heads/main', target: A, detached: false, unborn: false }, truncated: false };
const details = (id: string, parents: string[]): CommitDetailsPayload => ({
  id, parents, coAuthors: [], signed: false,
  author: { name: 'Grace Hopper', email: 'grace@example.com', time: 0 },
  committer: { name: 'Grace Hopper', email: 'grace@example.com', time: 0 },
});
const EMPTY_LIST: FileListPayload = { files: [], added: 0, deleted: 0 };

function services(): RepoServices {
  const byId: Record<string, CommitDetailsPayload> = { [A]: details(A, [B]), [B]: details(B, []) };
  const msgs: Record<string, CommitMessage> = { [A]: { id: A, summary: 'Second', body: '' }, [B]: { id: B, summary: 'First', body: '' } };
  return fakeServices({
    details: new Loader(async (id) => byId[id], new Lru(10)),
    messages: createCommitMessageCache(async (id) => msgs[id]),
    files: new Loader(async () => EMPTY_LIST, new Lru(10)),
  });
}

describe('RepoView drag performance (K26)', () => {
  it('a right-panel drag causes zero graph/details re-renders until release, then exactly one', async () => {
    render(<RepoView repo={1} repoPath="/r" graph={graph} services={services()} />);
    fireEvent.click(screen.getByTestId('select-first'));
    const panel = await screen.findByRole('complementary', { name: 'Commit details' });
    const sep = screen.getByRole('separator', { name: 'Resize details panel' });
    const graphBefore = renders.graph;
    const detailsBefore = renders.details;

    fireEvent.pointerDown(sep, { clientX: 800, pointerId: 1, button: 0 });
    // A burst of pointer events, well beyond one per animation frame — exactly what a fast mouse
    // or trackpad fires during a real drag.
    for (const x of [790, 770, 750, 720, 700, 680, 650]) fireEvent.pointerMove(sep, { clientX: x, pointerId: 1 });
    expect(renders.graph).toBe(graphBefore); // 0 re-renders mid-drag
    expect(renders.details).toBe(detailsBefore);
    await nextFrame(); // flush the rAF-coalesced DOM write
    expect(renders.graph).toBe(graphBefore); // still 0: the write went straight to the DOM
    expect(renders.details).toBe(detailsBefore);
    // The panel still tracks the pointer visually (only the latest, coalesced move: 400 -
    // (650 - 800) = 550), just without a React commit behind it yet.
    expect(panel).toHaveStyle({ width: '550px' });

    fireEvent.pointerUp(sep, { clientX: 650, pointerId: 1 });
    // Exactly one commit, at release — same final width, now backed by React state.
    expect(renders.graph).toBe(graphBefore + 1);
    expect(renders.details).toBe(detailsBefore + 1);
    expect(panel).toHaveStyle({ width: '550px' });
  });
});
