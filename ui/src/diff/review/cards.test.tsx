import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';
import type { ReviewDraft } from '../../api/gen/ReviewDraft';

const S = vi.hoisted(() => ({ review: null as unknown }));
const session = vi.hoisted(() => ({ editDraft: vi.fn(), deleteDraft: vi.fn() }));
vi.mock('../../forge/review/session', () => ({ useReview: () => S.review, ...session }));
vi.mock('../../forge/usePolling', () => ({ notifyForgeWrite: vi.fn() }));
vi.mock('../../forge/mrview/openNote', () => ({ openNoteFile: vi.fn() }));

const { ThreadCard } = await import('./ThreadCard');
const { DraftCard } = await import('./DraftCard');
const { RenderedCards } = await import('./RenderedCards');
const { ReviewNewText, textLines } = await import('./newText');
const { useReviewUi } = await import('./store');
const { patchForge, useForge } = await import('../../forge/mrStore');
const { detailOf, mrOf, user } = await import('../../forge/testMrs');
const { ArmLayer } = await import('../../ui/arm/ArmLayer');
const { disarm } = await import('../../ui/arm/store');
const { setOrigin } = await import('../../ui/arm/origin');
const { armClock, press } = await import('../../ui/arm/armTesting');
const { preloadMarkdown } = await import('../../markdown/lazy');
const { useReplyDrafts } = await import('../../forge/mrview/drafts');

beforeAll(() => preloadMarkdown(), 60_000);

const position = { path: 'README.md', oldPath: null, line: 2, oldLine: null, snippet: null, startLine: null, startOldLine: null };
const note = (id: string, who: string, body: string) => ({ id, author: user(who), body, createdAt: 1, system: false, position });
const thread = (resolved: boolean, replies = 0): ForgeDiscussion => ({
  id: 'd1', resolvable: true, resolved,
  notes: [note('n1', 'Grace Hopper', 'Why this line?\nMore below.'), ...Array.from({ length: replies }, (_, i) => note(`r${i}`, 'Ada Lovelace', 'Because.'))],
});
const draft = (body: string): ReviewDraft => ({ id: '5', body, position: null, replyTo: null });
const overlay = () => document.querySelector<HTMLElement>('.arm-overlay');
let clock: ReturnType<typeof armClock>;
let rects: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  useForge.setState({ byTab: {} });
  patchForge('t', { kind: 'gitlab', details: { 12: { value: detailOf(mrOf(12)), at: 1 } } });
  S.review = { number: 12, kind: 'gitlab' };
  useReviewUi.setState({ boxes: {}, folds: {} });
  useReplyDrafts.setState({ text: {} });
  clock = armClock();
  rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return (this.isConnected ? [new DOMRect(10, 10, 24, 24)] : []) as unknown as DOMRectList;
  });
});
afterEach(() => {
  act(() => disarm());
  setOrigin(null);
  rects.mockRestore();
  clock.restore();
  cleanup();
});

describe('a thread under its line (spec 2026-10-08 §2)', () => {
  it("is the MR view's thread: Reply and Resolve; no file:line, it's at its line", () => {
    render(<ThreadCard tabId="t" thread={thread(false)} outdated={false} />);
    expect(screen.getByRole('article', { name: 'Thread by Grace Hopper' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resolve thread' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'README.md:2' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Collapse the thread by Grace Hopper' })).toHaveAttribute('data-review-focus');
  });

  it('a resolved thread starts folded to one line; its toggle opens it, and the choice stays for the session', () => {
    const { unmount } = render(<ThreadCard tabId="t" thread={thread(true, 2)} outdated={false} />);
    const toggle = screen.getByRole('button', { name: 'Expand the thread by Grace Hopper' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Why this line? More below.')).toBeInTheDocument();
    expect(screen.getByText('2 replies')).toBeInTheDocument();
    expect(screen.getByText('Resolved')).toBeInTheDocument();
    expect(screen.queryByRole('article')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole('article', { name: 'Thread by Grace Hopper' })).toBeInTheDocument();
    unmount();
    render(<ThreadCard tabId="t" thread={thread(true, 2)} outdated={false} />);
    expect(screen.getByRole('button', { name: 'Collapse the thread by Grace Hopper' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('an outdated one says so', () => {
    render(<ThreadCard tabId="t" thread={thread(false)} outdated />);
    expect(screen.getByText('Outdated')).toBeInTheDocument();
  });

  it('resolved with the keyboard in it, it folds and the keyboard goes to its toggle, not the page', () => {
    const { rerender } = render(<ThreadCard tabId="t" thread={thread(false)} outdated={false} />);
    screen.getByRole('button', { name: 'Resolve thread' }).focus();
    rerender(<ThreadCard tabId="t" thread={thread(true)} outdated={false} />);
    expect(screen.getByRole('button', { name: 'Expand the thread by Grace Hopper' })).toHaveFocus();
  });

  it("folded by someone else while the keyboard is elsewhere, it doesn't take it", () => {
    const { rerender } = render(<><button type="button">Elsewhere</button><ThreadCard tabId="t" thread={thread(false)} outdated={false} /></>);
    screen.getByRole('button', { name: 'Resolve thread' }).focus();
    screen.getByRole('button', { name: 'Elsewhere' }).focus();
    rerender(<><button type="button">Elsewhere</button><ThreadCard tabId="t" thread={thread(true)} outdated={false} /></>);
    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus();
  });
});

describe('a pending draft under its line', () => {
  it('shows Pending and its text; Edit saves through the forge, and a refusal keeps the editor and says why', async () => {
    session.editDraft.mockResolvedValueOnce({ ok: false, error: 'GitLab refused: 403 Forbidden' }).mockResolvedValueOnce({ ok: true, value: draft('Better?') });
    render(<DraftCard tabId="t" draft={draft('Why?')} outdated />);
    const card = screen.getByRole('article', { name: 'Pending comment' });
    expect(card).toHaveTextContent('Pending');
    expect(card).toHaveTextContent('Outdated');
    await waitFor(() => expect(card).toHaveTextContent('Why?'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const field = screen.getByRole('textbox', { name: 'Edit pending comment' });
    fireEvent.change(field, { target: { value: 'Better?' } });
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('GitLab refused: 403 Forbidden');
    expect(field).toHaveValue('Better?');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Edit pending comment' })).toBeNull());
    expect(session.editDraft).toHaveBeenLastCalledWith('t', '5', 'Better?');
  });

  it('an edit outlives the card being laid out again (a tab shown again), without taking the keyboard back', () => {
    const { unmount } = render(<DraftCard tabId="t" draft={draft('Why?')} outdated={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('textbox', { name: 'Edit pending comment' })).toHaveFocus();
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit pending comment' }), { target: { value: 'Half an edit' } });
    unmount();
    render(<DraftCard tabId="t" draft={draft('Why?')} outdated={false} />);
    const field = screen.getByRole('textbox', { name: 'Edit pending comment' });
    expect(field).toHaveValue('Half an edit');
    expect(field).not.toHaveFocus();
  });

  it('Esc leaves the edit; Delete arms in place, then deletes', async () => {
    session.deleteDraft.mockResolvedValue({ ok: true, value: null });
    render(<><DraftCard tabId="t" draft={draft('Why?')} outdated={false} /><ArmLayer /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit pending comment' }), { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Edit pending comment' })).toBeNull();
    press(screen.getByRole('button', { name: 'Delete' }));
    expect(overlay()).toHaveTextContent('Click again to delete the pending comment');
    expect(session.deleteDraft).not.toHaveBeenCalled();
    clock.settle();
    press(overlay()!);
    await waitFor(() => expect(session.deleteDraft).toHaveBeenCalledWith('t', '5'));
  });

  it('leaving the edit (Esc, Cancel, Save) hands the keyboard to Edit, not the page', async () => {
    session.editDraft.mockResolvedValue({ ok: true, value: draft('Better?') });
    render(<DraftCard tabId="t" draft={draft('Why?')} outdated={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit pending comment' }), { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    screen.getByRole('button', { name: 'Cancel' }).focus();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit pending comment' }), { target: { value: 'Better?' } });
    screen.getByRole('button', { name: 'Save' }).focus();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus());
  });

  it('deleted with the keyboard in it: the keyboard goes where the view says (the diff)', async () => {
    const onGone = vi.fn();
    const r = render(<><DraftCard tabId="t" draft={draft('Why?')} outdated={false} onGone={onGone} /><ArmLayer /></>);
    // The session's answer takes the card away.
    session.deleteDraft.mockImplementation(async () => { r.rerender(<ArmLayer />); return { ok: true, value: null }; });
    screen.getByRole('button', { name: 'Delete' }).focus();
    press(screen.getByRole('button', { name: 'Delete' }));
    clock.settle();
    press(overlay()!);
    await waitFor(() => expect(onGone).toHaveBeenCalledTimes(1));
  });
});

describe('a suggestion in a card: a diff of the lines it replaces, from the diff’s text', () => {
  const FILE_TEXT = 'Title\nFirst line\nSecond line\nThird line';
  const marked = (c: HTMLElement) => [...c.querySelectorAll('.md-suggestion .md-code-line')].map((l) => `${l.classList.contains('md-code-del') ? '-' : l.classList.contains('md-code-add') ? '+' : ' '}${l.textContent}`);
  const body = '```suggestion:-1+0\nFirst line\nSecond line, edited\n```\n\nTighter?';
  const at = { path: 'README.md', side: 'new' as const, line: 3, startLine: null, outdated: false };
  const pos3 = { ...position, line: 3 };

  it("a draft's and a thread's, at their lines (the rendered diff's cards: the file's text)", async () => {
    const items = [
      { kind: 'draft' as const, draft: { ...draft(body), position: pos3 }, at },
      { kind: 'thread' as const, thread: { ...thread(false), id: 'd2', notes: [{ ...note('n9', 'Grace Hopper', body), position: pos3 }] }, at },
    ];
    const { container } = render(<RenderedCards tabId="t" items={items} boxes={[]} fresh={null} disabledReason={null} text={FILE_TEXT} onClose={vi.fn()} onFocus={vi.fn()} onLeave={vi.fn()} />);
    await waitFor(() => expect(container.querySelectorAll('.md-suggestion')).toHaveLength(2));
    for (const box of container.querySelectorAll<HTMLElement>('.md-suggestion')) expect(marked(box)).toEqual([' First line', '-Second line', '+Second line, edited']);
  });

  it('without the diff’s text (Submit review…’s list), or on a removed line: only the lines it puts in', async () => {
    const { container } = render(<DraftCard tabId="t" draft={{ ...draft(body), position: pos3 }} outdated={false} />);
    await waitFor(() => expect(container.querySelector('.md-suggestion')).not.toBeNull());
    expect(marked(container)).toEqual(['+First line', '+Second line, edited']);
    cleanup();
    const old = render(<ReviewNewText value={textLines(FILE_TEXT)}><DraftCard tabId="t" draft={{ ...draft(body), position: { ...position, line: null, oldLine: 3 } }} outdated={false} /></ReviewNewText>);
    await waitFor(() => expect(old.container.querySelector('.md-suggestion')).not.toBeNull());
    expect(marked(old.container)).toEqual(['+First line', '+Second line, edited']);
  });

  it('folded, a thread reads as plain text: a suggestion as "Suggested change", no fences or markup', () => {
    render(<ThreadCard tabId="t" thread={{ ...thread(true), notes: [note('n1', 'Grace Hopper', '```suggestion:-1+0\nFirst line\n```\n\nTighter **this** way?')] }} outdated={false} />);
    expect(screen.getByText('Suggested change · Tighter this way?')).toBeInTheDocument();
  });
});
