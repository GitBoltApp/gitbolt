import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewAnchor } from '../../api/gen/ReviewAnchor';

const S = vi.hoisted(() => ({ review: null as unknown }));
const session = vi.hoisted(() => ({ addToReview: vi.fn(), commentNow: vi.fn() }));
vi.mock('../../forge/review/session', () => ({ useReview: () => S.review, ...session }));

const { CommentBox, NO_DRAFTS, NO_SUGGESTION } = await import('./CommentBox');
const { ArmLayer } = await import('../../ui/arm/ArmLayer');
const { disarm } = await import('../../ui/arm/store');
const { setOrigin } = await import('../../ui/arm/origin');
const { armClock, press } = await import('../../ui/arm/armTesting');
const { useReplyDrafts } = await import('../../forge/mrview/drafts');
const { preloadMarkdown } = await import('../../markdown/lazy');
const { ReviewNewText, textLines } = await import('./newText');

beforeAll(() => preloadMarkdown(), 60_000);

const anchor: ReviewAnchor = { path: 'README.md', oldPath: 'README.md', start: { kind: 'context', oldLine: 1, newLine: 1 }, end: { kind: 'added', oldLine: 2, newLine: 2 } };
const overlay = () => document.querySelector<HTMLElement>('.arm-overlay');
let clock: ReturnType<typeof armClock>;
let rects: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  useReplyDrafts.setState({ text: {} });
  S.review = { number: 12, kind: 'gitlab', canDraft: true };
  clock = armClock();
  // jsdom does no layout: a rendered control reports one box, so it arms in place.
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

function renderBox(over: { disabledReason?: string } = {}) {
  const onDone = vi.fn();
  const onCancel = vi.fn();
  render(<><CommentBox tabId="t" anchor={anchor} suggestion={'Readme\nSecond line'} onDone={onDone} onCancel={onCancel} {...over} /><p>elsewhere</p><ArmLayer /></>);
  return { onDone, onCancel, field: screen.getByRole('textbox', { name: 'Comment' }) };
}

describe('the comment box (spec 2026-10-08 §2)', () => {
  it('Add to review is the default (Mod+Enter): the draft goes in, the box closes and its text goes', async () => {
    session.addToReview.mockResolvedValue({ ok: true, value: { id: '5' } });
    const { field, onDone } = renderBox();
    expect(screen.getByRole('button', { name: 'Add to review' })).toBeDisabled();
    fireEvent.change(field, { target: { value: 'Why?' } });
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(session.addToReview).toHaveBeenCalledWith('t', anchor, 'Why?');
    expect(useReplyDrafts.getState().text).toEqual({});
  });

  it("a refused write keeps the text and gives the forge's reason; Comment now posts at once", async () => {
    session.addToReview.mockResolvedValue({ ok: false, error: "GitLab won't take a comment on that line: 400 Bad request" });
    session.commentNow.mockResolvedValue({ ok: true, value: { id: 'd9' } });
    const { field, onDone } = renderBox();
    fireEvent.change(field, { target: { value: 'Why?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to review' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("GitLab won't take a comment on that line: 400 Bad request");
    expect(field).toHaveValue('Why?');
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Comment now' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(session.commentNow).toHaveBeenCalledWith('t', anchor, 'Why?');
  });

  it("Suggest change puts the lines in a suggestion block, in the forge's syntax, after what's written", () => {
    const { field } = renderBox();
    fireEvent.click(screen.getByRole('button', { name: 'Suggest change' }));
    expect(field).toHaveValue('```suggestion:-1+0\nReadme\nSecond line\n```');
    fireEvent.change(field, { target: { value: 'Shorter:' } });
    fireEvent.click(screen.getByRole('button', { name: 'Suggest change' }));
    expect(field).toHaveValue('Shorter:\n\n```suggestion:-1+0\nReadme\nSecond line\n```');
  });

  it("with no lines to suggest (an old-side comment), Suggest change does nothing and its tooltip (the app's, not a native title) says why", async () => {
    render(<CommentBox tabId="t" anchor={anchor} onDone={vi.fn()} onCancel={vi.fn()} />);
    const suggest = screen.getByRole('button', { name: 'Suggest change' });
    expect(suggest).toHaveAttribute('aria-disabled', 'true');
    expect(suggest).not.toHaveAttribute('title');
    fireEvent.click(suggest);
    expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveValue('');
    fireEvent.mouseEnter(suggest);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(NO_SUGGESTION);
  });

  it('Cancel closes an empty box at once; with text it arms first, and Esc in the field arms it too', async () => {
    const empty = renderBox();
    press(screen.getByRole('button', { name: 'Cancel' }));
    expect(empty.onCancel).toHaveBeenCalledTimes(1);
    cleanup();
    const { field, onCancel } = renderBox();
    fireEvent.change(field, { target: { value: 'Half a thought' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(overlay()).toHaveTextContent('Click again to discard the comment');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    // A second Esc disarms: back to writing.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
    expect(overlay()).toBeNull();
    await waitFor(() => expect(field).toHaveFocus());
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(overlay()).toHaveTextContent('Click again to discard the comment');
    // A press elsewhere disarms: the text stays.
    fireEvent.pointerDown(screen.getByText('elsewhere'));
    expect(overlay()).toBeNull();
    expect(field).toHaveValue('Half a thought');
    press(screen.getByRole('button', { name: 'Cancel' }));
    clock.settle();
    press(overlay()!);
    await waitFor(() => expect(onCancel).toHaveBeenCalled());
    expect(useReplyDrafts.getState().text).toEqual({});
  });

  it("Esc in the box's Preview arms Cancel too (the box owns its Esc: it never closes the diff)", () => {
    const { field } = renderBox();
    fireEvent.change(field, { target: { value: 'Half a thought' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    const preview = screen.getByRole('tabpanel', { name: 'Comment preview' });
    expect(preview.closest('[data-owns-escape]')).not.toBeNull();
    fireEvent.keyDown(preview, { key: 'Escape' });
    expect(overlay()).toHaveTextContent('Click again to discard the comment');
  });

  it("Preview shows a suggestion as a diff of the lines it replaces: the commented ones, or with the diff's text, the lines around them", async () => {
    const marked = () => [...document.querySelectorAll('.md-suggestion .md-code-line')].map((l) => `${l.classList.contains('md-code-del') ? '-' : l.classList.contains('md-code-add') ? '+' : ' '}${l.textContent}`);
    const { field } = renderBox();
    fireEvent.click(screen.getByRole('button', { name: 'Suggest change' }));
    expect(field).toHaveValue('```suggestion:-1+0\nReadme\nSecond line\n```');
    fireEvent.change(field, { target: { value: '```suggestion:-1+0\nReadme\nSecond line, edited\n```' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    await waitFor(() => expect(marked()).toEqual([' Readme', '-Second line', '+Second line, edited']));
    // The preview grows to show it whole, not held at the textarea's height.
    expect(screen.getByRole('tabpanel', { name: 'Comment preview' }).closest('.md-field')).toHaveAttribute('data-grow');
    // Past the commented lines, only the diff's text knows them.
    fireEvent.click(screen.getByRole('tab', { name: 'Write' }));
    fireEvent.change(field, { target: { value: '```suggestion:-1+1\nReadme\n```' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    await waitFor(() => expect(marked()).toEqual(['+Readme']));
    // The same draft, in a box over the diff's text.
    cleanup();
    render(<ReviewNewText value={textLines('Readme\nSecond line\nThird line')}><CommentBox tabId="t" anchor={anchor} suggestion={'Readme\nSecond line'} onDone={vi.fn()} onCancel={vi.fn()} /></ReviewNewText>);
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    await waitFor(() => expect(marked()).toEqual([' Readme', '-Second line', '-Third line']));
  });

  it('without drafts (a GitLab before 16.3), Add to review says why; a stale Compare blocks both sends', () => {
    S.review = { number: 12, kind: 'gitlab', canDraft: false };
    const { field } = renderBox();
    fireEvent.change(field, { target: { value: 'Why?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to review' }));
    expect(screen.getByRole('alert')).toHaveTextContent(NO_DRAFTS);
    expect(session.addToReview).not.toHaveBeenCalled();
    cleanup();
    S.review = { number: 12, kind: 'gitlab', canDraft: true };
    const stale = renderBox({ disabledReason: '!12 has new commits since this compare: compare again to comment on them' });
    fireEvent.change(stale.field, { target: { value: 'Why?' } });
    expect(screen.getByRole('alert')).toHaveTextContent('!12 has new commits since this compare');
    expect(screen.getByRole('button', { name: 'Comment now' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add to review' })).toBeDisabled();
  });
});
