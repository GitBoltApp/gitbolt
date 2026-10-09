import { Activity } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';
import type { ReviewLine } from '../../api/gen/ReviewLine';

const host = vi.hoisted(() => ({ setReviewZones: vi.fn(), setReviewGutter: vi.fn(), diffLines: vi.fn(), diffLineText: vi.fn(), goToReviewZone: vi.fn(), releaseDetached: vi.fn(), focus: vi.fn() }));
vi.mock('../monaco/load', () => ({ loadMonacoHost: async () => host }));
const S = vi.hoisted(() => ({ review: null as unknown, placements: null as unknown }));
vi.mock('../../forge/review/session', () => ({ useReview: () => S.review, useReviewPlacements: () => S.placements, useReviewMrHead: () => null, addToReview: vi.fn(), commentNow: vi.fn(), editDraft: vi.fn(), deleteDraft: vi.fn() }));
const compare = vi.hoisted(() => ({ compareMr: vi.fn(async () => true) }));
vi.mock('../../forge/mrview/compare', () => compare);
vi.mock('../../forge/mrview/openNote', () => ({ openNoteFile: vi.fn() }));
vi.mock('../../forge/usePolling', () => ({ notifyForgeWrite: vi.fn() }));

const { ActiveReview } = await import('./ActiveReview');
const { NOT_COMMENTABLE } = await import('./ReviewMode');
const { commentableIndex } = await import('../../forge/review/model');
const { lentHandler } = await import('../../app/lent');
const { EMPTY_PROFILE, useAppState } = await import('../../app/state');
const { useReviewUi } = await import('./store');
const { useReplyDrafts } = await import('../../forge/mrview/drafts');
const { patchForge, useForge } = await import('../../forge/mrStore');
const { detailOf, mrOf, user } = await import('../../forge/testMrs');
const { useToast } = await import('../../ui/toastStore');
const { preloadMarkdown } = await import('../../markdown/lazy');

beforeAll(() => preloadMarkdown(), 60_000);

const ctx = (o: number, n: number): ReviewLine => ({ kind: 'context', oldLine: o, newLine: n });
const add = (o: number, n: number): ReviewLine => ({ kind: 'added', oldLine: o, newLine: n });
const FILE = commentableIndex({ path: 'README.md', oldPath: 'README.md', tooLarge: false, lines: [ctx(1, 1), add(2, 2), add(2, 3)] });
const ON = { on: true as const, stale: false, tooLarge: false, file: FILE };
const position = { path: 'README.md', oldPath: null, line: 2, oldLine: null, snippet: null, startLine: null, startOldLine: null };
const thread: ForgeDiscussion = { id: 'd1', resolvable: true, resolved: false, notes: [{ id: 'n1', author: user('Grace Hopper'), body: 'Why?', createdAt: 1, system: false, position }] };

type Spec = { path: string; items: { key: string }[]; placed(nodes: Map<string, HTMLElement>): void };
const lastSpec = () => host.setReviewZones.mock.lastCall![0] as Spec;
/** The host lays the cards: a node per item, handed to the view. */
async function place(): Promise<Map<string, HTMLElement>> {
  const spec = lastSpec();
  const nodes = new Map(spec.items.map((i) => [i.key, document.body.appendChild(document.createElement('div'))]));
  await act(async () => {
    spec.placed(nodes);
    await Promise.resolve();
  });
  return nodes;
}

beforeEach(() => {
  vi.clearAllMocks();
  useForge.setState({ byTab: {} });
  patchForge('t', { kind: 'gitlab', details: { 12: { value: detailOf(mrOf(12)), at: 1 } } });
  S.review = { number: 12, kind: 'gitlab', canDraft: true };
  S.placements = { byPath: {}, unplacedDrafts: [] };
  useReviewUi.setState({ boxes: {}, folds: {} });
  useReplyDrafts.setState({ text: {} });
  useToast.getState().dismiss();
  useAppState.setState({ loaded: true, profile: { ...EMPTY_PROFILE, id: 'default', tabs: [{ id: 't', kind: 'repo', path: '/t', alias: null }], activeTab: 't' } });
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('review mode in the source diff (spec 2026-10-08 §2)', () => {
  it("the gutter's + goes on the lines that take a comment; a drag opens a box under the range's last line, Suggest change ready with its lines", async () => {
    render(<ActiveReview tabId="t" path="README.md" mode={ON} />);
    await waitFor(() => expect(host.setReviewGutter).toHaveBeenCalled());
    const gutter = host.setReviewGutter.mock.lastCall![0] as { old: Set<number>; new: Set<number>; onPick(side: string, a: number, b: number): void };
    expect([[...gutter.new].sort(), [...gutter.old]]).toEqual([[1, 2, 3], [1]]);
    host.diffLineText.mockReturnValue(['Second', 'Third']);
    act(() => gutter.onPick('modified', 3, 2));
    expect(host.diffLineText).toHaveBeenCalledWith('modified', 2, 3);
    expect(lastSpec()).toMatchObject({ path: 'README.md', items: [{ key: 'b:README.md:new:2-3', side: 'modified', line: 3, startLine: 2, stop: false }] });
    const nodes = await place();
    const box = within(nodes.get('b:README.md:new:2-3')!).getByRole('form', { name: 'New comment' });
    // Just opened: it takes the keyboard.
    expect(within(box).getByRole('textbox', { name: 'Comment' })).toHaveFocus();
    act(() => within(box).getByRole('button', { name: 'Suggest change' }).click());
    expect(within(box).getByRole('textbox', { name: 'Comment' })).toHaveValue('```suggestion:-1+0\nSecond\nThird\n```');
  });

  it("an old-side drag ending on an unchanged line lands on the new side: the box there, Suggest change from the new side's numbers alone", async () => {
    const del = (o: number, n: number): ReviewLine => ({ kind: 'removed', oldLine: o, newLine: n });
    // New line 1, two removed lines, then old line 7 (new line 2).
    const gone = commentableIndex({ path: 'README.md', oldPath: 'README.md', tooLarge: false, lines: [ctx(4, 1), del(5, 2), del(6, 2), ctx(7, 2)] });
    render(<ActiveReview tabId="t" path="README.md" mode={{ ...ON, file: gone }} />);
    await waitFor(() => expect(host.setReviewGutter).toHaveBeenCalled());
    const gutter = host.setReviewGutter.mock.lastCall![0] as { onPick(side: string, a: number, b: number): void };
    host.diffLineText.mockReturnValue(['Kept']);
    act(() => gutter.onPick('original', 5, 7));
    expect(host.diffLineText).toHaveBeenCalledWith('modified', 2, 2);
    expect(lastSpec().items).toMatchObject([{ side: 'modified', line: 2, startLine: null }]);
  });

  it("the MR's threads become cards in their zones; F9 goes to the next and puts the keyboard on it", async () => {
    S.placements = { byPath: { 'README.md': [{ kind: 'thread', thread, at: { path: 'README.md', side: 'new', line: 2, startLine: null, outdated: false } }] }, unplacedDrafts: [] };
    render(<ActiveReview tabId="t" path="README.md" mode={ON} />);
    await waitFor(() => expect(host.setReviewZones).toHaveBeenCalled());
    expect(lastSpec().items).toEqual([{ key: 't:d1', side: 'modified', line: 2, startLine: null, stop: true }]);
    const nodes = await place();
    expect(within(nodes.get('t:d1')!).getByRole('article', { name: 'Thread by Grace Hopper' })).toBeInTheDocument();
    host.goToReviewZone.mockReturnValue('t:d1');
    act(() => lentHandler('review.nextThread')!());
    expect(host.goToReviewZone).toHaveBeenCalledWith('next');
    expect(within(nodes.get('t:d1')!).getByRole('button', { name: 'Collapse the thread by Grace Hopper' })).toHaveFocus();
    // Esc on the card, which no control there takes: back to the diff.
    fireEvent.keyDown(within(nodes.get('t:d1')!).getByRole('button', { name: 'Collapse the thread by Grace Hopper' }), { key: 'Escape' });
    expect(host.focus).toHaveBeenCalled();
  });

  it('F9 onto a draft being edited puts the keyboard in its field', async () => {
    const draft = { id: '5', body: 'Why?', position, replyTo: null };
    S.placements = { byPath: { 'README.md': [{ kind: 'draft', draft, at: { path: 'README.md', side: 'new', line: 2, startLine: null, outdated: false } }] }, unplacedDrafts: [] };
    useReplyDrafts.setState({ text: { 't:12:review-draft:5': 'Better?' } });
    render(<ActiveReview tabId="t" path="README.md" mode={ON} />);
    await waitFor(() => expect(host.setReviewZones).toHaveBeenCalled());
    const nodes = await place();
    host.goToReviewZone.mockReturnValue('d:5');
    act(() => lentHandler('review.nextThread')!());
    expect(within(nodes.get('d:5')!).getByRole('textbox', { name: 'Edit pending comment' })).toHaveFocus();
  });

  it("Mod+Alt+C comments on the cursor's lines; a line outside the MR's diff says it takes none", async () => {
    render(<ActiveReview tabId="t" path="README.md" mode={ON} />);
    await waitFor(() => expect(lentHandler('review.comment')).not.toBeNull());
    host.diffLines.mockReturnValue({ side: 'modified', start: 1, end: 1 });
    act(() => lentHandler('review.comment')!());
    expect(lastSpec().items).toEqual([{ key: 'b:README.md:new:-1', side: 'modified', line: 1, startLine: null, stop: false }]);
    host.diffLines.mockReturnValue({ side: 'modified', start: 7, end: 7 });
    act(() => lentHandler('review.comment')!());
    expect(useToast.getState().message).toBe(NOT_COMMENTABLE);
  });

  it('a stale Compare: no gutter, no thread cards, a banner to compare again, and an open box that can only wait', async () => {
    S.placements = { byPath: { 'README.md': [{ kind: 'thread', thread, at: { path: 'README.md', side: 'new', line: 2, startLine: null, outdated: false } }] }, unplacedDrafts: [] };
    useReviewUi.setState({ boxes: { 't:12': [{ key: 'README.md:new:-2', anchor: { path: 'README.md', oldPath: 'README.md', start: null, end: add(2, 2) } }] }, folds: {} });
    render(<ActiveReview tabId="t" path="README.md" mode={{ on: true, stale: true, tooLarge: false, file: null }} />);
    await waitFor(() => expect(host.setReviewZones).toHaveBeenCalled());
    expect(host.setReviewGutter).not.toHaveBeenCalled();
    expect(lastSpec().items.map((i) => i.key)).toEqual(['b:README.md:new:-2']);
    expect(lentHandler('review.comment')).toBeNull();
    const banner = screen.getByRole('note');
    expect(banner).toHaveTextContent('!12 has new commits since this compare');
    within(banner).getByRole('button', { name: 'Compare again' }).click();
    await waitFor(() => expect(compare.compareMr).toHaveBeenCalledWith('t', 'gitlab', expect.objectContaining({ number: 12 }), expect.anything()));
    const nodes = await place();
    expect(within(nodes.get('b:README.md:new:-2')!).getByRole('button', { name: 'Add to review' })).toBeDisabled();
    // Open from before (laid out again): it doesn't take the keyboard.
    expect(within(nodes.get('b:README.md:new:-2')!).getByRole('textbox', { name: 'Comment' })).not.toHaveFocus();
    // Cancel (an empty box closes at once): the keyboard goes back to the diff.
    await act(async () => within(nodes.get('b:README.md:new:-2')!).getByRole('button', { name: 'Cancel' }).click());
    await waitFor(() => expect(useReviewUi.getState().boxes['t:12']).toEqual([]));
    expect(host.focus).toHaveBeenCalled();
  });

  it("GitLab still catching up with a push: a neutral note, no Compare again, and an open box that waits for it", async () => {
    S.placements = { byPath: { 'README.md': [{ kind: 'thread', thread, at: { path: 'README.md', side: 'new', line: 2, startLine: null, outdated: false } }] }, unplacedDrafts: [] };
    useReviewUi.setState({ boxes: { 't:12': [{ key: 'README.md:new:-2', anchor: { path: 'README.md', oldPath: 'README.md', start: null, end: add(2, 2) } }] }, folds: {} });
    render(<ActiveReview tabId="t" path="README.md" mode={{ on: true, stale: true, updating: true, tooLarge: false, file: null }} />);
    await waitFor(() => expect(host.setReviewZones).toHaveBeenCalled());
    expect(host.setReviewGutter).not.toHaveBeenCalled();
    expect(lastSpec().items.map((i) => i.key)).toEqual(['b:README.md:new:-2']);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent("GitLab is still updating !12's changes");
    expect(note).not.toHaveTextContent('new commits');
    expect(within(note).queryByRole('button')).toBeNull();
    const nodes = await place();
    expect(within(nodes.get('b:README.md:new:-2')!).getByRole('button', { name: 'Add to review' })).toBeDisabled();
    expect(within(nodes.get('b:README.md:new:-2')!).getByRole('alert')).toHaveTextContent("GitLab is still updating !12's changes");
  });

  it("the MR's diff couldn't be read: a note says why (no gutter to miss)", async () => {
    S.review = { number: 12, kind: 'gitlab', canDraft: true, error: 'GitLab answered 502 Bad Gateway' };
    render(<ActiveReview tabId="t" path="README.md" mode={{ on: true, stale: false, tooLarge: false, file: null }} />);
    expect(screen.getByRole('note')).toHaveTextContent("Couldn't read !12's changes: GitLab answered 502 Bad Gateway");
    await waitFor(() => expect(host.setReviewZones).toHaveBeenCalled());
    expect(host.setReviewGutter).not.toHaveBeenCalled();
  });

  it("a tab switch: the hidden tab's cards go, and the shown tab's stay (the editor is shared, the spec matched by path)", async () => {
    S.placements = { byPath: { 'README.md': [{ kind: 'thread', thread, at: { path: 'README.md', side: 'new', line: 2, startLine: null, outdated: false } }] }, unplacedDrafts: [] };
    const tabs = (shown: 'a' | 'b') => (
      <>
        <Activity mode={shown === 'a' ? 'visible' : 'hidden'}><ActiveReview tabId="t" path="README.md" mode={ON} /></Activity>
        <Activity mode={shown === 'b' ? 'visible' : 'hidden'}><ActiveReview tabId="t" path="other.md" mode={ON} /></Activity>
      </>
    );
    const { rerender } = render(tabs('a'));
    await waitFor(() => expect(host.setReviewZones).toHaveBeenCalled());
    expect(lastSpec().path).toBe('README.md');
    rerender(tabs('b'));
    await act(async () => { await Promise.resolve(); });
    expect(host.setReviewZones.mock.calls.map(([s]) => (s as Spec | null)?.path ?? null).slice(-2)).toEqual([null, 'other.md']);
    expect(host.setReviewGutter).toHaveBeenLastCalledWith(expect.objectContaining({ onPick: expect.any(Function) }));
  });

  it('leaving review mode takes the cards and the gutter away', async () => {
    const { unmount } = render(<ActiveReview tabId="t" path="README.md" mode={ON} />);
    await waitFor(() => expect(host.setReviewGutter).toHaveBeenCalled());
    unmount();
    expect(host.setReviewZones).toHaveBeenLastCalledWith(null);
    expect(host.setReviewGutter).toHaveBeenLastCalledWith(null);
  });
});
