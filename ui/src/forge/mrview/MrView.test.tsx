import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';

const poll = vi.hoisted(() => ({ refreshMr: vi.fn(async () => {}), loadMrDetail: vi.fn(async () => {}), openMrView: vi.fn() }));
vi.mock('../poll', () => poll);
const api = vi.hoisted(() => ({ openUrl: vi.fn(async () => null), forgeImage: vi.fn(async () => ({ kind: 'found', mime: 'image/png', base64: 'iVBORw==' })), forgeProjectSettings: vi.fn(() => new Promise(() => {})) }));
vi.mock('../../api/client', () => ({ api, errorMessage: String }));
const note = vi.hoisted(() => ({ openNoteFile: vi.fn(async () => {}) }));
vi.mock('./openNote', () => note);

const { MrView } = await import('./MrView');
const { forgeOf, patchForge, useForge } = await import('../mrStore');
const { detailOf, mrOf, projectOf, user } = await import('../testMrs');
const { useRuntime } = await import('../../app/runtime');

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

// The lazy Markdown chunk's first import is slow: load it once before the tests.
beforeAll(async () => { await import('../../markdown/Markdown'); });

beforeEach(() => {
  vi.clearAllMocks();
  useForge.setState({ byTab: {} });
  useRuntime.setState({ tabs: { t: { repo: { id: 4 } } as never } });
  patchForge('t', { kind: 'gitlab', remote: 'origin', details: { 12: { value: detail, at: 1 } }, discussions: { 12: threads } });
});

describe('the MR/PR view (spec #4 §4 "4B")', () => {
  it('renders the description as Markdown, with its references (spec #5 §1)', async () => {
    // A reference links only with a project to resolve it against (inert without one).
    patchForge('t', { project: projectOf(), details: { 12: { value: { ...detail, description: '## What / why\n\nFollows !5.' }, at: 1 } } });
    show();
    const region = screen.getByRole('region', { name: 'Description' });
    expect(await within(region).findByRole('heading', { name: 'What / why' })).toBeInTheDocument();
    expect(within(region).getByRole('link', { name: '!5' })).toBeInTheDocument();
  });

  it('renders every comment as Markdown, and keeps system notes as events', async () => {
    patchForge('t', { discussions: { 12: [{ ...threads[0]!, notes: [{ ...threads[0]!.notes[0]!, body: 'Use **this**' }] }, threads[2]!] } });
    show();
    const activity = screen.getByRole('region', { name: 'Activity' });
    await waitFor(() => expect(activity.querySelector('.mr-note-body strong')).toHaveTextContent('this'));
    expect(activity).toHaveTextContent('added 1 commit');
  });

  it('keeps a description over 1 MB as plain text', async () => {
    const big = `## Big\n\n${'x'.repeat(1_000_100)}`;
    patchForge('t', { details: { 12: { value: { ...detail, description: big }, at: 1 } } });
    show();
    const region = screen.getByRole('region', { name: 'Description' });
    await new Promise((r) => setTimeout(r, 20));
    expect(within(region).queryByRole('heading', { name: 'Big' })).toBeNull();
    expect(region.querySelector('.md-plain')).not.toBeNull();
  });

  it('loads a GitHub attachment through its signed URL from bodyHtml', async () => {
    const uuid = '1b2c3d4e-0000-4000-8000-00000000abcd';
    const signedUrl = `https://private-user-images.githubusercontent.com/1/2-${uuid}.png?jwt=a`;
    patchForge('t', { kind: 'github', project: projectOf('octo-org/widget', 'github'), details: { 12: { value: { ...detail, description: `![shot](https://github.com/user-attachments/assets/${uuid})`, bodyHtml: `<p><img src="${signedUrl}"></p>` }, at: 1 } } });
    show();
    await waitFor(() => expect(api.forgeImage).toHaveBeenCalledWith(4, signedUrl, false));
  });

  it('renders the new text when a poll or an edit changes the description', async () => {
    patchForge('t', { details: { 12: { value: { ...detail, description: '## Before' }, at: 1 } } });
    show();
    const region = screen.getByRole('region', { name: 'Description' });
    expect(await within(region).findByRole('heading', { name: 'Before' })).toBeInTheDocument();
    act(() => { patchForge('t', { details: { 12: { value: { ...detail, description: '## After' }, at: 2 } } }); });
    expect(await within(region).findByRole('heading', { name: 'After' })).toBeInTheDocument();
    expect(within(region).queryByRole('heading', { name: 'Before' })).toBeNull();
  });

  it('is the flyout "Merge request !12", with its state, branches, author, pipeline, review, conflicts, reviewers and labels', () => {
    show();
    const view = screen.getByRole('dialog', { name: 'Merge request !12' });
    expect(within(view).getByRole('heading')).toHaveTextContent('!12 Dev work');
    const summary = within(view).getByRole('region', { name: 'Summary' });
    expect(summary.querySelector('.mr-branches svg.lucide-arrow-right')).not.toBeNull();
    for (const text of ['Open', 'dev → main', 'Grace Hopper', 'Passed', '0 of 1 approval', 'None', 'Reviewers:', 'Ada Lovelace', 'backend']) expect(summary).toHaveTextContent(text);
  });

  it("colours a label with the forge's colour and shows its emoji shortcode as the emoji", async () => {
    const labelled = { ...detail.mr, labels: ['feature :gear:', 'plain :not_an_emoji:', 'constructor'], labelColors: { 'feature :gear:': '#a2eeef' } };
    patchForge('t', { details: { 12: { value: { ...detail, mr: labelled }, at: 1 } } });
    show();
    const chips = () => [...document.querySelectorAll<HTMLElement>('.mr-label')];
    expect(await screen.findByText('feature ⚙️')).toBeInTheDocument();
    expect(chips().map((c) => [c.textContent, c.style.getPropertyValue('--chip-color'), c.hasAttribute('data-colored')])).toEqual([
      ['feature ⚙️', '#a2eeef', true],
      ['plain :not_an_emoji:', '', false],
      ['constructor', '', false],
    ]);
  });

  it('one divider between the merge box and the description: the box follows the actions and the description drops its own rule', async () => {
    show();
    const merge = screen.getByRole('region', { name: 'Merge' });
    expect(merge.nextElementSibling).toBe(screen.getByRole('region', { name: 'Description' }));
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('src/forge/mrview/mrview.css', 'utf8')).toMatch(/\.mr-merge \+ \.mr-description \{[^}]*border-top: 0/);
  });

  it('the fact strip: Conflicts is None, Yes or Checking…; GitHub calls the second tile Reviews', () => {
    const tiles = () => [...document.querySelectorAll('.mr-fact')].map((e) => e.textContent);
    const { unmount } = show();
    expect(tiles()[1]).toMatch(/^Approvals/);
    expect(tiles()[2]).toBe('ConflictsNone');
    unmount();
    patchForge('t', { kind: 'github', details: { 12: { value: { ...detail, mr: { ...detail.mr, conflicts: true } }, at: 1 } } });
    const again = show();
    expect(tiles()[1]).toMatch(/^Reviews/);
    expect(tiles()[2]).toBe('ConflictsYes');
    expect(document.querySelector('.mr-fact[data-fact="conflicts"] .bad')).not.toBeNull();
    again.unmount();
    patchForge('t', { details: { 12: { value: { ...detail, mr: { ...detail.mr, conflicts: null } }, at: 1 } }, discussions: { 12: threads } });
    show();
    expect(tiles()[2]).toBe('ConflictsChecking…');
  });

  it('opens the pipeline and the MR in the browser', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Passed' }));
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

  it("shows the discussion: notes, a diff note's file:line and snippet (which opens the file), system notes as timeline events", () => {
    show();
    const activity = screen.getByRole('region', { name: 'Activity' });
    expect(within(activity).getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['Thread by Grace Hopper', 'Thread by Grace Hopper']);
    expect(activity).toHaveTextContent('Looks good overall.');
    expect(activity).toHaveTextContent('+Second line');
    expect(activity).toHaveTextContent('Resolved');
    expect(activity).toHaveTextContent('Grace Hopper added 1 commit');
    fireEvent.click(within(activity).getByRole('button', { name: 'README.md:2' }));
    expect(note.openNoteFile).toHaveBeenCalledWith('t', 'gitlab', expect.objectContaining({ number: 12 }), 'README.md');
  });

  it('has the tabs Activity, Comments and Diff notes, with counts on the last two', () => {
    show();
    const tab = (n: RegExp) => screen.getByRole('tab', { name: n });
    expect(tab(/^Activity$/)).toHaveAttribute('aria-selected', 'true');
    expect(tab(/^Comments2$/)).toBeTruthy();
    expect(tab(/^Diff notes1$/)).toBeTruthy();
    fireEvent.click(tab(/^Diff notes/));
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.queryByText('Grace Hopper added 1 commit')).toBeNull();
    fireEvent.click(tab(/^Comments/));
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(document.querySelector('.mr-system')).toBeNull();
    fireEvent.click(tab(/^Activity/));
    expect(document.querySelector('.mr-system')).not.toBeNull();
  });

  it('renders system events with their type classes, in time order, parsed (never as HTML)', () => {
    const sys = (id: string, body: string, at: number): ForgeDiscussion => ({ id, resolvable: false, resolved: false, notes: [{ id, author: grace, body, createdAt: at, system: true, position: null }] });
    patchForge('t', { discussions: { 12: [
      sys('s3', 'merged', 1_791_100_900),
      sys('s1', 'added 1 commit <ul><li>9a4c1e07 - Fix the callback&#39;s fields</li></ul> [Compare with previous version](/group/project/-/merge_requests/12/diffs?diff_id=1) <img src=x onerror=alert(1)>', 1_791_100_100),
      sys('s2', 'mentioned in merge request !1204', 1_791_100_200),
      ...threads.slice(0, 1),
    ] } });
    show();
    const events = [...document.querySelectorAll('.mr-system')];
    expect(events.map((e) => e.getAttribute('data-kind'))).toEqual(['commits', 'mention', 'merged']);
    expect(document.querySelector('.mr-node.kind-commits')).not.toBeNull();
    expect(document.querySelector('.mr-node.kind-merged')).not.toBeNull();
    expect(events[0]).toHaveTextContent("9a4c1e07Fix the callback's fields");
    expect(events[0]?.querySelector('img')).toBeNull();
    fireEvent.click(within(events[0] as HTMLElement).getByRole('button', { name: 'Compare with previous version' }));
    expect(api.openUrl).toHaveBeenCalledWith('https://gitlab.example.com/group/project/-/merge_requests/12/diffs?diff_id=1');
    // The thread (first note at ...000) comes before the events by time.
    const order = [...document.querySelectorAll('.mr-ev')].map((e) => (e.classList.contains('mr-thread-ev') ? 'thread' : e.getAttribute('data-kind')));
    expect(order).toEqual(['thread', 'commits', 'mention', 'merged']);
  });

  it('keeps the tab bar while loading, and shows a forge note inside a human thread as an event', () => {
    patchForge('t', { discussions: {} });
    const { unmount } = show();
    expect(screen.getAllByRole('tab').filter((t) => !t.classList.contains('md-field-tab'))).toHaveLength(3);
    expect(screen.getByText('Loading the discussion…')).toBeTruthy();
    unmount();
    patchForge('t', { discussions: { 12: [{ id: 'm', resolvable: false, resolved: false, notes: [
      { id: '1', author: grace, body: 'hello', createdAt: 1_791_100_000, system: false, position: null },
      { id: '2', author: grace, body: 'approved this merge request', createdAt: 1_791_100_500, system: true, position: null },
    ] }] } });
    show();
    expect(document.querySelector('.mr-system[data-kind="approved"]')).not.toBeNull();
    expect(screen.getAllByRole('article')).toHaveLength(1);
  });

  it('Reply opens the reply box in the thread', () => {
    show();
    fireEvent.click(within(screen.getAllByRole('article')[0]!).getByRole('button', { name: 'Reply' }));
    expect(screen.getByRole('textbox', { name: 'Reply' })).toBeTruthy();
  });

  it('the new-comment box sits at the bottom', () => {
    show();
    expect(document.querySelector('.mr-new-comment')).toContainElement(screen.getByRole('textbox', { name: 'Write a comment' }));
  });

  it('GitHub reviews are timeline events with the same colours', () => {
    patchForge('t', { kind: 'github', discussions: { 12: [] }, details: { 12: { value: { ...detail, mr: { ...detail.mr, review: { decision: 'approved', approvals: 1, approvalsRequired: null, reviews: [
      { user: user('Ada Lovelace'), state: 'approved', submittedAt: 1_791_100_000 },
      { user: user('Linus T'), state: 'changesRequested', submittedAt: 1_791_100_100 },
      { user: user('Alan T'), state: 'commented', submittedAt: 1_791_100_200 },
    ] } } }, at: 1 } } });
    show();
    expect([...document.querySelectorAll('.mr-system')].map((e) => e.getAttribute('data-kind'))).toEqual(['approved', 'unapproved', 'review']);
    expect(screen.getByText('approved these changes')).toBeTruthy();
  });

  it('loads the MR/PR when it opens (after a beat, so arrowing past loads nothing), and forgets it when it closes', async () => {
    const { unmount } = show();
    await waitFor(() => expect(poll.refreshMr).toHaveBeenCalledWith('t', 12));
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

// --- 5B T3 ---
describe('navigation history (spec #5 §3.4)', () => {
  it('comes back to where the view was scrolled, and notes its scroll for the next step', async () => {
    const { scrollOf, setPendingScroll } = await import('../../nav/scroll');
    setPendingScroll('t', 'mr', { key: 'mr:12', view: null, top: 300, anchor: null });
    show();
    const body = document.querySelector<HTMLElement>('.flyout-body')!;
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 4000 });
    await waitFor(() => expect(body.scrollTop).toBe(300));
    body.scrollTop = 120;
    fireEvent.scroll(body);
    expect(scrollOf('t', 'mr', 'mr:12')).toBe(120);
  });
});
// --- end 5B T3 ---
