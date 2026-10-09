import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffPosition } from '../../api/gen/DiffPosition';
import type { ReviewDraft } from '../../api/gen/ReviewDraft';

const writes = vi.hoisted(() => ({ editDraft: vi.fn(async () => ({ ok: true, value: {} })), deleteDraft: vi.fn(async () => ({ ok: true, value: null })) }));
vi.mock('./session', async (orig) => ({ ...(await orig<typeof import('./session')>()), ...writes }));
vi.mock('../../ui/ConfirmDialog', () => ({ confirmAction: vi.fn(async () => true) }));
// The MR view's composer (MrActions.test covers it): here, that Mod+Enter reaches its form.
const composer = vi.hoisted(() => ({ submit: vi.fn() }));
vi.mock('../mrview/MrActions', () => ({
  ReviewComposer: () => <form aria-label="Review" onSubmit={(e) => { e.preventDefault(); composer.submit(); }}><textarea aria-label="Summary" /></form>,
}));

const { default: SubmitPopover } = await import('./SubmitPopover');
const { chipView } = await import('./ReviewChip');
const { commentableIndex } = await import('./model');
const { patchForge, useForge } = await import('../mrStore');
const { preloadMarkdown } = await import('../../markdown/lazy');
const { useReplyDrafts } = await import('../mrview/drafts');

beforeAll(() => preloadMarkdown(), 60_000);

const HEAD = 'h'.repeat(40);
const OLD = 'o'.repeat(40);
const pos = (over: Partial<DiffPosition>): DiffPosition => ({ path: 'README.md', oldPath: null, line: 2, oldLine: null, snippet: null, startLine: null, startOldLine: null, headSha: HEAD, ...over });
const draft = (id: string, body: string, position: DiffPosition | null): ReviewDraft => ({ id, body, position, replyTo: null });
const FILE = commentableIndex({ path: 'README.md', oldPath: 'README.md', tooLarge: false, lines: [{ kind: 'added', oldLine: 1, newLine: 2 }] });
const DRAFTS = [draft('d1', 'On the line', pos({})), draft('d2', 'A reply made on the web', null), draft('d3', 'Its line is gone', pos({ line: 9, headSha: OLD }))];

beforeEach(() => {
  vi.clearAllMocks();
  useReplyDrafts.setState({ text: {} });
  useForge.setState({ byTab: {} });
  patchForge('t', {
    kind: 'gitlab',
    review: { number: 12, kind: 'gitlab', compare: null, refs: { baseSha: 'b'.repeat(40), startSha: 'b'.repeat(40), headSha: HEAD }, files: { 'README.md': FILE }, diffHead: HEAD, drafts: DRAFTS, pendingReview: null, canDraft: true, closed: false, error: null, loaded: true },
  });
});

const onClose = vi.fn();
const open = () => render(<SubmitPopover tabId="t" kind="gitlab" number={12} anchor={null} onClose={onClose} />);
const listed = () => within(screen.getByRole('region', { name: 'Not on a line in this diff' }));

describe('Submit review…: the pending comments on no line of the diff (spec 2026-10-08 §4)', () => {
  it('lists them above the composer, the outdated one marked; the chip counts them with the placed one', async () => {
    open();
    expect(await listed().findByText('A reply made on the web')).toBeInTheDocument();
    expect(await listed().findByText('Its line is gone')).toBeInTheDocument();
    expect(listed().queryByText('On the line')).toBeNull();
    expect(listed().getAllByRole('article', { name: 'Pending comment' })).toHaveLength(2);
    expect(listed().getAllByText('Outdated')).toHaveLength(1);
    // The region comes before the composer.
    const region = screen.getByRole('region', { name: 'Not on a line in this diff' });
    expect(region.compareDocumentPosition(screen.getByRole('form', { name: 'Review' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chipView('gitlab', useForge.getState().byTab.t!.review!, null).value).toBe('!12 · 3 pending');
  });

  it('none: no list', () => {
    patchForge('t', (f) => ({ review: { ...f.review!, drafts: [DRAFTS[0]!] } }));
    open();
    expect(screen.queryByRole('region', { name: 'Not on a line in this diff' })).toBeNull();
  });

  it('one edits in place: Esc leaves the edit and keeps the popover; Mod+Enter saves it; the composer takes Mod+Enter too', async () => {
    open();
    const card = (await listed().findByText('A reply made on the web')).closest('article')!;
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    const field = within(card).getByRole('textbox', { name: 'Edit pending comment' });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(within(card).queryByRole('textbox')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(card).getByRole('textbox', { name: 'Edit pending comment' }), { target: { value: 'Reworded' } });
    await act(async () => { fireEvent.keyDown(within(card).getByRole('textbox', { name: 'Edit pending comment' }), { key: 'Enter', ctrlKey: true }); });
    expect(writes.editDraft).toHaveBeenCalledWith('t', 'd2', 'Reworded');
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Summary' }), { key: 'Enter', ctrlKey: true });
    expect(composer.submit).toHaveBeenCalledTimes(1);
  });

  it('one deletes', async () => {
    open();
    const card = (await listed().findByText('Its line is gone')).closest('article')!;
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Delete' })); });
    expect(writes.deleteDraft).toHaveBeenCalledWith('t', 'd3');
  });
});
