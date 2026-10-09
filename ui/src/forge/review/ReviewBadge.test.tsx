import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DiffSpec } from '../../api/gen/DiffSpec';
import type { GraphPayload } from '../../api/gen/GraphPayload';
import type { FileRow } from '../../files/fileTree';

const { useReviewRowBadge } = await import('./ReviewBadge');
const { commentableIndex } = await import('./model');
const { patchForge, useForge } = await import('../mrStore');
const { createRepoViewStore, RepoViewContext, targetFor } = await import('../../repo/store');
const { fakeServices } = await import('../../repo/testServices');

const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] };
const BASE = 'b'.repeat(40);
const HEAD = 'h'.repeat(40);
const SPEC: DiffSpec = { kind: 'compare', from: BASE, to: HEAD };
const FILE = commentableIndex({ path: 'README.md', oldPath: 'README.md', tooLarge: false, lines: [{ kind: 'context', oldLine: 1, newLine: 1 }, { kind: 'added', oldLine: 2, newLine: 2 }] });
const pos = (line: number) => ({ path: 'README.md', oldPath: null, line, oldLine: null, snippet: null, startLine: null, startOldLine: null, headSha: HEAD });
const thread = (id: string, line: number, resolved: boolean) => ({ id, resolvable: true, resolved, notes: [{ id: `n${id}`, author: { id: 1, username: 'grace', name: 'Grace', avatarUrl: null, webUrl: '', email: null }, body: 'Hm', createdAt: 0, system: false, position: pos(line) }] });
const target = targetFor({ path: 'README.md', oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'absent' }, new: { kind: 'absent' }, submodule: false } as never, SPEC);
const fileRow: FileRow = { kind: 'file', id: target.key, depth: 0, name: 'README.md', dir: '', change: null, target };
const folderRow = { kind: 'folder', id: 'docs', depth: 0, name: 'docs', path: 'docs', expanded: true } as unknown as FileRow;

function Row({ spec, row }: { spec: DiffSpec; row: FileRow }) {
  const badge = useReviewRowBadge('t', spec);
  return <div data-testid="row">{badge?.(row)}</div>;
}
function show(spec: DiffSpec = SPEC, row: FileRow = fileRow) {
  const store = createRepoViewStore(1, '/r', graph, fakeServices());
  render(<RepoViewContext value={store}><Row spec={spec} row={row} /></RepoViewContext>);
  return store;
}

beforeEach(() => {
  useForge.setState({ byTab: {} });
  patchForge('t', {
    kind: 'gitlab',
    review: { number: 12, kind: 'gitlab', compare: { from: BASE, to: HEAD }, refs: { baseSha: BASE, startSha: BASE, headSha: HEAD }, files: { 'README.md': FILE }, diffHead: HEAD, drafts: [], pendingReview: null, canDraft: true, closed: false, error: null, loaded: true },
    discussions: { 12: [thread('t1', 1, true), thread('t2', 2, false)] as never },
  });
});

describe("the file list's review badges (spec 2026-10-08 §5)", () => {
  it("a file with threads gets a badge, highlighted for its unresolved one; a click opens the file at that thread", () => {
    const store = show();
    const badge = screen.getByRole('button', { name: '2 threads, 1 unresolved' });
    expect(badge).toHaveAttribute('data-unresolved');
    expect(badge).toHaveTextContent('2');
    fireEvent.click(badge);
    expect(store.getState().diff).toMatchObject({ path: 'README.md', view: 'diff', line: { side: 'modified', line: 2 } });
  });

  it('none while the Compare is stale (the MR moved on, or GitLab is still catching up): neither view shows the cards', () => {
    patchForge('t', (f) => ({ review: { ...f.review!, refs: { baseSha: BASE, startSha: BASE, headSha: 'n'.repeat(40) } } }));
    show();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('only on the review Compare, and only on file rows', () => {
    show({ kind: 'commit', id: HEAD, parent: 0 });
    expect(screen.queryByRole('button')).toBeNull();
    show(SPEC, folderRow);
    expect(screen.getAllByTestId('row')[1]).toBeEmptyDOMElement();
  });
});
