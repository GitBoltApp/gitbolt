import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';

const poll = vi.hoisted(() => ({ refreshMr: vi.fn(async () => {}), loadMrDetail: vi.fn(async () => {}), openMrView: vi.fn() }));
vi.mock('../poll', () => poll);
const api = vi.hoisted(() => ({ openUrl: vi.fn(async () => null) }));
vi.mock('../../api/client', () => ({ api, errorMessage: String }));
const note = vi.hoisted(() => ({ openNoteFile: vi.fn(async () => {}) }));
vi.mock('./openNote', () => note);

const { MrView } = await import('./MrView');
const { forgeOf, patchForge, useForge } = await import('../mrStore');
const { detailOf, mrOf, user } = await import('../testMrs');

const grace = user('Grace Hopper');
const mr = mrOf(12, { title: 'Dev work', pipeline: { status: 'success', webUrl: 'https://gitlab.example.com/p/-/pipelines/1' }, labels: ['backend'] });
const detail = detailOf({ ...mr, review: { decision: 'reviewRequired', approvals: 0, approvalsRequired: 1, reviews: [] } }, { reviewers: [user('Ada Lovelace')], mergeStatus: { kind: 'blocked', reason: 'It needs approval first' } });
const threads: ForgeDiscussion[] = [
  { id: 'd1', resolvable: false, resolved: false, notes: [{ id: '101', author: grace, body: 'Looks good overall.', createdAt: 1_791_100_000, system: false, position: null }] },
  { id: 'd2', resolvable: true, resolved: true, notes: [{ id: '102', author: grace, body: 'Why the second line?', createdAt: 1_791_100_300, system: false, position: { path: 'README.md', oldPath: null, line: 2, oldLine: null, snippet: ' Readme\n+Second line' } }] },
  { id: 'd3', resolvable: false, resolved: false, notes: [{ id: '103', author: grace, body: 'added 1 commit', createdAt: 1_791_100_600, system: true, position: null }] },
];
const close = vi.fn();
const show = () => render(<MrView tabId="t" props={{ number: 12 }} close={close} />);

beforeEach(() => {
  vi.clearAllMocks();
  useForge.setState({ byTab: {} });
  patchForge('t', { kind: 'gitlab', remote: 'origin', details: { 12: { value: detail, at: 1 } }, discussions: { 12: threads } });
});

describe('the MR/PR view (spec #4 §4 "4B")', () => {
  it('is the flyout "Merge request !12", with its state, branches, author, pipeline, review, conflicts, reviewers and labels', () => {
    show();
    const view = screen.getByRole('dialog', { name: 'Merge request !12' });
    expect(within(view).getByRole('heading')).toHaveTextContent('!12 Dev work');
    const summary = within(view).getByRole('region', { name: 'Summary' });
    for (const text of ['Open', 'dev → main', 'Grace Hopper', 'Pipeline passed', '0 of 1 approval', 'No conflicts', 'Reviewers: Ada Lovelace', 'backend']) expect(summary).toHaveTextContent(text);
  });

  it('opens the pipeline and the MR in the browser', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Pipeline passed' }));
    expect(api.openUrl).toHaveBeenCalledWith('https://gitlab.example.com/p/-/pipelines/1');
    fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }));
    expect(api.openUrl).toHaveBeenLastCalledWith(mr.webUrl);
  });

  it('shows the description, or says there is none', () => {
    const { unmount } = show();
    expect(screen.getByRole('region', { name: 'Description' })).toHaveTextContent('Adds the dev work.');
    unmount();
    patchForge('t', { details: { 12: { value: { ...detail, description: '  ' }, at: 1 } } });
    show();
    expect(screen.getByRole('region', { name: 'Description' })).toHaveTextContent('No description');
  });

  it("shows the discussion: notes, a diff note's file:line and snippet (which opens the file), system notes in one line", () => {
    show();
    const discussion = screen.getByRole('region', { name: 'Discussion' });
    expect(within(discussion).getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['Thread by Grace Hopper', 'Thread by Grace Hopper']);
    expect(discussion).toHaveTextContent('Looks good overall.');
    expect(discussion).toHaveTextContent('+Second line');
    expect(discussion).toHaveTextContent('Resolved');
    expect(discussion).toHaveTextContent('Grace Hopper added 1 commit');
    fireEvent.click(within(discussion).getByRole('button', { name: 'README.md:2' }));
    expect(note.openNoteFile).toHaveBeenCalledWith('t', 'gitlab', expect.objectContaining({ number: 12 }), 'README.md');
  });

  it('loads the MR/PR when it opens, and forgets it when it closes', () => {
    const { unmount } = show();
    expect(poll.refreshMr).toHaveBeenCalledWith('t', 12);
    expect(forgeOf('t').openMr).toBe(12);
    unmount();
    expect(forgeOf('t').openMr).toBeNull();
  });

  it("says it's loading, or why it couldn't load", () => {
    useForge.setState({ byTab: {} });
    patchForge('t', { kind: 'github' });
    const { unmount } = show();
    expect(screen.getByRole('dialog', { name: 'Pull request #12' })).toHaveTextContent('Loading…');
    unmount();
    patchForge('t', { detailErrors: { 12: 'Not found on github.com' } });
    show();
    expect(screen.getByRole('dialog', { name: 'Pull request #12' })).toHaveTextContent("Couldn't load Pull request #12: Not found on github.com");
  });

  it("says when the MR/PR's own refresh failed while an older detail is shown", () => {
    patchForge('t', { detailErrors: { 12: "Couldn't reach gitlab.example.com: timed out" } });
    show();
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't refresh !12: Couldn't reach gitlab.example.com: timed out");
    expect(screen.getByRole('region', { name: 'Description' })).toHaveTextContent('Adds the dev work.');
  });

  it('keeps what it shows after a failed poll, with a note', () => {
    patchForge('t', { error: 'boom', updatedAt: Date.now() - 60_000 });
    show();
    expect(screen.getByRole('status')).toHaveTextContent(/^Couldn't refresh: boom\. Last updated/);
    expect(screen.getByRole('region', { name: 'Description' })).toHaveTextContent('Adds the dev work.');
  });
});
