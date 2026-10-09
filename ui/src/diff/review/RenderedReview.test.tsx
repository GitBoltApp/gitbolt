import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useCallback, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../../api/gen/GraphPayload';
import type { ReviewAnchor } from '../../api/gen/ReviewAnchor';

// Plan 2's cards and box: here, where they show and what they're given.
vi.mock('./ThreadCard', () => ({ ThreadCard: ({ thread, outdated }: { thread: { id: string }; outdated: boolean }) => <div data-testid="card">{thread.id}{outdated ? ' (outdated)' : ''}</div> }));
vi.mock('./DraftCard', () => ({ DraftCard: ({ draft }: { draft: { id: string } }) => <div data-testid="card">{draft.id}</div> }));
vi.mock('./CommentBox', () => ({
  CommentBox: ({ anchor, suggestion, onCancel, autoFocus, disabledReason }: { anchor: ReviewAnchor; suggestion?: string; onCancel: () => void; autoFocus?: boolean; disabledReason?: string | null }) => (
    <form aria-label="Comment"><output data-testid="autofocus">{String(autoFocus)}</output><output data-testid="blocked">{disabledReason ?? 'none'}</output><output data-testid="anchor">{JSON.stringify(anchor)}</output><output data-testid="suggestion">{suggestion ?? 'none'}</output><button type="button" onClick={onCancel}>Cancel</button></form>
  ),
}));

const { RenderedReview, RenderedReviewNote } = await import('./RenderedReview');
const { blockCommenter } = await import('./blockComment');
const { BlockSlot } = await import('../../markdown/blockSlot');
const { patchForge, useForge } = await import('../../forge/mrStore');
const { commentableIndex } = await import('../../forge/review/model');
const { createRepoViewStore, RepoViewContext } = await import('../../repo/store');
const { fakeServices } = await import('../../repo/testServices');
const { useToast } = await import('../../ui/toastStore');
const { NOT_COMMENTABLE } = await import('./ReviewMode');
const { detailOf, mrOf } = await import('../../forge/testMrs');
const { boxesOf, openBox, useReviewUi } = await import('./store');

const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRefs: [], head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] };
const BASE = 'b'.repeat(40);
const HEAD = 'h'.repeat(40);
const ctx = (o: number, n: number) => ({ kind: 'context' as const, oldLine: o, newLine: n });
const add = (o: number, n: number) => ({ kind: 'added' as const, oldLine: o, newLine: n });
const FILE = commentableIndex({ path: 'README.md', oldPath: 'README.md', tooLarge: false, lines: [ctx(1, 1), add(2, 2)] });
const pos = (line: number) => ({ path: 'README.md', oldPath: null, line, oldLine: null, snippet: null, startLine: null, startOldLine: null, headSha: HEAD });
const thread = (id: string, line: number) => ({ id, resolvable: true, resolved: false, notes: [{ id: `n${id}`, author: { id: 1, username: 'grace', name: 'Grace', avatarUrl: null, webUrl: '', email: null }, body: 'Hm', createdAt: 0, system: false, position: pos(line) }] });

function review(threads = [thread('t1', 1)], headSha = HEAD) {
  patchForge('t', {
    kind: 'gitlab',
    review: { number: 12, kind: 'gitlab', compare: { from: BASE, to: HEAD }, refs: { baseSha: BASE, startSha: BASE, headSha }, files: { 'README.md': FILE }, diffHead: HEAD, drafts: [{ id: 'd5', body: 'Why?', replyTo: null, position: pos(2) }], pendingReview: null, canDraft: true, closed: false, error: null, loaded: true },
    discussions: { 12: threads as never },
  });
}

/** What MarkdownDiff renders for README.md's diff: render.tsx's attributes and slots. */
function Diff({ late, list }: { late: boolean; list: boolean }) {
  // README.md as a list: a list block holding an item per line.
  if (list) {
    return (
      <div className="md md-diff">
        <ul data-src-id="5" data-src-new="1-2" data-src-old="1-1">
          <li data-src-id="6" data-src-new="1-1" data-src-old="1-1"><span>Readme item</span><BlockSlot id={6} sides={{ new: true, old: true }} /></li>
          <li data-src-id="7" data-src-new="2-2"><span>Second item</span><BlockSlot id={7} sides={{ new: true, old: false }} /></li>
        </ul>
        <BlockSlot id={5} sides={{ new: true, old: true }} />
      </div>
    );
  }
  return (
    <div className="md md-diff">
      <p data-src-id="1" data-src-new="1-2" data-src-old="1-1">Readme Second line</p>
      <BlockSlot id={1} sides={{ new: true, old: true }} />
      <p data-src-id="2" data-src-new="5-6" data-src-old="4-5">Far below</p>
      <BlockSlot id={2} sides={{ new: true, old: true }} />
      {late && <><p data-src-id="3" data-src-new="9-9">Late block</p><BlockSlot id={3} sides={{ new: true, old: false }} /></>}
    </div>
  );
}

function Pane({ late, list }: { late: boolean; list: boolean }) {
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => setPane(el), []);
  return <div ref={ref} data-testid="pane" tabIndex={-1}><RenderedReview tabId="t" path="README.md" pane={pane} modified={'Readme\nSecond line\n'}><Diff late={late} list={list} /></RenderedReview><RenderedReviewNote tabId="t" path="README.md" /></div>;
}

function show(sel: Record<string, unknown> = { kind: 'compare', from: BASE, to: HEAD }, list = false) {
  const store = createRepoViewStore(1, '/r', graph, fakeServices());
  store.setState({ selection: sel as never });
  const ui = (late: boolean) => <RepoViewContext value={store}><Pane late={late} list={list} /></RepoViewContext>;
  const r = render(ui(false));
  return { rerender: (late: boolean) => r.rerender(ui(late)) };
}
// The block, not the mocked box's suggestion (the same text).
/** A pointer move, and the frame the "+" follows it in. */
const move = async (el: Element, init?: PointerEventInit) => {
  fireEvent.pointerMove(el, init);
  await act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
};
const slotAfter = (text: string) => screen.getByText(text, { selector: 'p' }).nextElementSibling;

beforeEach(() => {
  useForge.setState({ byTab: {} });
  useReviewUi.setState({ boxes: {}, folds: {} });
  review();
});

describe('the rendered diff in review mode (spec 2026-10-08 §3)', () => {
  it('shows each thread and draft under the block holding its line', async () => {
    show();
    await screen.findAllByTestId('card');
    expect(slotAfter('Readme Second line')).toHaveAttribute('data-review-slot');
    expect(screen.getAllByTestId('card').map((c) => c.textContent)).toEqual(['t1', 'd5']);
    expect(screen.getAllByTestId('card').every((c) => c.closest('[data-review-slot]') === slotAfter('Readme Second line'))).toBe(true);
  });

  it('hovering a block that touches the diff shows its "+"; a click opens the box under it, its lines and source in it', async () => {
    show();
    await move(screen.getByText('Far below'));
    expect(screen.queryByRole('button', { name: /^Comment on/ })).toBeNull();
    await move(screen.getByText('Readme Second line'));
    fireEvent.click(screen.getByRole('button', { name: 'Comment on lines 1–2' }));
    await screen.findByRole('form', { name: 'Comment' });
    expect(JSON.parse(screen.getByTestId('anchor').textContent!)).toEqual({ path: 'README.md', oldPath: 'README.md', start: ctx(1, 1), end: add(2, 2) });
    expect(screen.getByTestId('suggestion').textContent).toBe('Readme\nSecond line');
    expect(screen.getByRole('form', { name: 'Comment' }).closest('[data-review-slot]')).toBe(slotAfter('Readme Second line'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Comment' })).toBeNull();
  });

  it('the "+" stays while the pointer crosses the gap between the block and it', async () => {
    show();
    const block = screen.getByText('Readme Second line', { selector: 'p' });
    block.getBoundingClientRect = () => ({ left: 60, top: 10, right: 600, bottom: 40 }) as DOMRect;
    await move(block, { clientX: 100, clientY: 20 });
    const plus = screen.getByRole('button', { name: 'Comment on lines 1–2' });
    // The gap left of the block: the pointer is over the Markdown's root, or the pane's padding.
    await move(block.parentElement!, { clientX: 50, clientY: 20 });
    await move(screen.getByTestId('pane'), { clientX: 40, clientY: 12 });
    expect(screen.getByRole('button', { name: 'Comment on lines 1–2' })).toBe(plus);
    await move(plus, { clientX: 36, clientY: 12 });
    expect(screen.getByRole('button', { name: 'Comment on lines 1–2' })).toBe(plus);
    // Below the block's row: gone.
    await move(block.parentElement!, { clientX: 50, clientY: 45 });
    expect(screen.queryByRole('button', { name: /^Comment on/ })).toBeNull();
  });

  it('measures the blocks once a frame at most, and not again while the page holds still', async () => {
    show();
    const block = screen.getByText('Readme Second line', { selector: 'p' });
    const measure = vi.fn(() => ({ left: 60, top: 10, right: 600, bottom: 40 }) as DOMRect);
    block.getBoundingClientRect = measure;
    fireEvent.pointerMove(block.parentElement!, { clientX: 40, clientY: 12 });
    fireEvent.pointerMove(block.parentElement!, { clientX: 45, clientY: 15 });
    await move(block.parentElement!, { clientX: 50, clientY: 20 });
    await move(block.parentElement!, { clientX: 52, clientY: 22 });
    expect(screen.getByRole('button', { name: 'Comment on lines 1–2' })).toBeInTheDocument();
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it("a list's box opens where its draft will show: under the item holding its last line", async () => {
    show(undefined, true);
    const list = screen.getByRole('list');
    await move(list);
    fireEvent.click(screen.getByRole('button', { name: 'Comment on lines 1–2' }));
    const form = await screen.findByRole('form', { name: 'Comment' });
    expect(form.closest('[data-review-slot]')).toBe(screen.getByText('Second item').nextElementSibling);
    // The draft on line 2 shows there too.
    expect(screen.getByText('d5').closest('[data-review-slot]')).toBe(form.closest('[data-review-slot]'));
  });

  it('the comment key opens the box on the first block in view that takes a comment', async () => {
    show();
    act(() => blockCommenter()!());
    expect((await screen.findByRole('form', { name: 'Comment' })).closest('[data-review-slot]')).toBe(slotAfter('Readme Second line'));
  });

  it("a thread whose block isn't rendered yet (a streamed chunk) waits under the last block before it, then moves to its own", async () => {
    review([thread('t1', 1), thread('t9', 9)]);
    const { rerender } = show();
    expect((await screen.findByText('t9')).closest('[data-review-slot]')).toBe(slotAfter('Far below'));
    rerender(true);
    await waitFor(() => expect(screen.getByText('t9').closest('[data-review-slot]')).toBe(slotAfter('Late block')));
  });

  it("the cards own their Esc: one no control took leaves them for the diff, as a closed box does", async () => {
    show();
    const card = (await screen.findAllByTestId('card'))[0]!;
    expect(card.closest('[data-owns-escape]')).not.toBeNull();
    fireEvent.keyDown(card, { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByTestId('pane'));
    act(() => blockCommenter()!());
    (document.activeElement as HTMLElement).blur();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(screen.getByTestId('pane'));
  });

  it('the comment key with no block in view that takes a comment says so, as the source diff does', () => {
    review([], HEAD);
    useForge.setState((s) => ({ byTab: { t: { ...s.byTab.t!, review: { ...s.byTab.t!.review!, files: { 'README.md': commentableIndex({ path: 'README.md', oldPath: 'README.md', tooLarge: false, lines: [add(8, 20)] }) } } } } }));
    useToast.setState({ message: null });
    show();
    act(() => blockCommenter()!());
    expect(useToast.getState().message).toBe(NOT_COMMENTABLE);
    expect(screen.queryByRole('form', { name: 'Comment' })).toBeNull();
  });

  it('a new box takes the keyboard once: after its first focus, laid out again, it doesn\'t', async () => {
    show();
    act(() => blockCommenter()!());
    const form = await screen.findByRole('form', { name: 'Comment' });
    expect(screen.getByTestId('autofocus').textContent).toBe('true');
    fireEvent.focusIn(form);
    expect(screen.getByTestId('autofocus').textContent).toBe('false');
  });

  it('a stale Compare (the MR moved on) shows no cards and no "+", and says to compare again', async () => {
    review([thread('t1', 1)], 'n'.repeat(40));
    show();
    expect(screen.getByRole('note')).toHaveTextContent('!12 has new commits since this compare');
    expect(screen.getByRole('button', { name: 'Compare again' })).toBeInTheDocument();
    expect(screen.queryByTestId('card')).toBeNull();
    await move(screen.getByText('Readme Second line'));
    expect(screen.queryByRole('button', { name: /^Comment on/ })).toBeNull();
    expect(blockCommenter()).toBeNull();
  });

  it("its boxes are the session's, as the source diff's: one opened here is there, one opened there shows here, under its last line's block", async () => {
    show();
    await move(screen.getByText('Readme Second line'));
    fireEvent.click(screen.getByRole('button', { name: 'Comment on lines 1–2' }));
    await screen.findByRole('form', { name: 'Comment' });
    expect(boxesOf(useReviewUi.getState(), 't', 12).map((b) => b.anchor.end)).toEqual([add(2, 2)]);
    // Cancelled: gone from the session too.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(boxesOf(useReviewUi.getState(), 't', 12)).toEqual([]);
    // One the source diff opened (on line 2), and one on another file.
    act(() => {
      openBox('t', 12, { path: 'README.md', oldPath: 'README.md', start: null, end: add(2, 2) });
      openBox('t', 12, { path: 'other.md', oldPath: 'other.md', start: null, end: add(2, 2) });
    });
    const form = await screen.findByRole('form', { name: 'Comment' });
    expect(form.closest('[data-review-slot]')).toBe(slotAfter('Readme Second line'));
    expect(screen.getAllByRole('form', { name: 'Comment' })).toHaveLength(1);
    // Not opened here: it doesn't take the keyboard.
    expect(screen.getByTestId('autofocus').textContent).toBe('false');
  });

  it('a box stays when the Compare goes stale, unable to send and saying why, as in the source diff', async () => {
    show();
    act(() => blockCommenter()!());
    await screen.findByRole('form', { name: 'Comment' });
    act(() => useForge.setState((s) => ({ byTab: { t: { ...s.byTab.t!, review: { ...s.byTab.t!.review!, refs: { baseSha: BASE, startSha: BASE, headSha: 'n'.repeat(40) } } } } })));
    expect(screen.getByRole('form', { name: 'Comment' })).toBeInTheDocument();
    expect(screen.getByTestId('blocked').textContent).toMatch(/^!12 has new commits since this compare/);
    expect(screen.queryByTestId('card')).toBeNull();
  });

  it("right after a push (the MR's head is the Compare's, GitLab's refs the last one): a neutral note, no cards, no \"+\", until the refs catch up", async () => {
    review([thread('t1', 1)], 'p'.repeat(40));
    patchForge('t', { details: { 12: { value: detailOf(mrOf(12, { headSha: HEAD })), at: 1 } } });
    show();
    expect(screen.getByRole('note')).toHaveTextContent("GitLab is still updating !12's changes");
    expect(screen.queryByRole('button', { name: 'Compare again' })).toBeNull();
    expect(screen.queryByTestId('card')).toBeNull();
    expect(blockCommenter()).toBeNull();
    act(() => review([thread('t1', 1)]));
    expect(await screen.findByText('t1')).toBeInTheDocument();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it("the MR's diff couldn't be read: a note says why, as in the source diff", () => {
    review([]);
    useForge.setState((s) => ({ byTab: { t: { ...s.byTab.t!, review: { ...s.byTab.t!.review!, refs: null, files: {}, diffHead: null, error: 'GitLab answered 502 Bad Gateway' } } } }));
    show();
    expect(screen.getByRole('note')).toHaveTextContent("Couldn't read !12's changes: GitLab answered 502 Bad Gateway");
    expect(blockCommenter()).toBeNull();
  });

  it('another diff (not the review Compare) shows no cards, no "+" and takes no comment key', async () => {
    show({ kind: 'commit', index: 0, id: HEAD });
    expect(screen.queryByTestId('card')).toBeNull();
    await move(screen.getByText('Readme Second line'));
    expect(screen.queryByRole('button', { name: /^Comment on/ })).toBeNull();
    expect(blockCommenter()).toBeNull();
  });
});
