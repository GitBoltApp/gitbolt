import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';

const poll = vi.hoisted(() => ({ refreshMr: vi.fn(async () => {}), loadMrDetail: vi.fn(async () => {}), openMrView: vi.fn() }));
vi.mock('../poll', () => poll);
const api = vi.hoisted(() => ({ forgeLabels: vi.fn(async () => [{ name: 'ui', color: '#1f75cb', description: null }]), forgeSearchUsers: vi.fn(async () => []), openUrl: vi.fn(async () => null), forgeImage: vi.fn(async () => ({ kind: 'found', mime: 'image/png', base64: 'iVBORw==' })), forgeProjectSettings: vi.fn(() => new Promise(() => {})), forgePeopleLimits: vi.fn(() => new Promise(() => {})), forgeReviewDrafts: vi.fn(async () => ({ refs: null, drafts: [] as unknown[], pendingReview: null as string | null, canDraft: true })) }));
vi.mock('../../api/client', () => ({ api, errorMessage: String }));
const note = vi.hoisted(() => ({ openNoteFile: vi.fn(async () => {}) }));
vi.mock('./openNote', () => note);

const { MrView } = await import('./MrView');
const { forgeOf, patchForge, useForge } = await import('../mrStore');
const { detailOf, mrOf, projectOf, user } = await import('../testMrs');
const { useRuntime } = await import('../../app/runtime');
const { useThreadFolds } = await import('./noteActionsStore');

const grace = user('Grace Hopper');
const mr = mrOf(12, { title: 'Dev work', pipeline: { status: 'success', webUrl: 'https://gitlab.example.com/p/-/pipelines/1' }, labels: ['backend'] });
const detail = detailOf({ ...mr, review: { decision: 'reviewRequired', approvals: 0, approvalsRequired: 1, reviews: [] } }, { reviewers: [user('Ada Lovelace')], mergeStatus: { kind: 'blocked', reason: 'It needs approval first' } });
const threads: ForgeDiscussion[] = [
  { id: 'd1', resolvable: false, resolved: false, notes: [{ id: '101', author: grace, body: 'Looks good overall.', createdAt: 1_791_100_000, system: false, position: null }] },
  { id: 'd2', resolvable: true, resolved: true, notes: [{ id: '102', author: grace, body: 'Why the second line?', createdAt: 1_791_100_300, system: false, position: { path: 'README.md', oldPath: null, line: 2, oldLine: null, snippet: ' Readme\n+Second line', startLine: 1, startOldLine: 1 } }] },
  { id: 'd3', resolvable: false, resolved: false, notes: [{ id: '103', author: grace, body: 'added 1 commit', createdAt: 1_791_100_600, system: true, position: null }] },
];
const close = vi.fn();
const show = () => render(<MrView tabId="t" props={{ number: 12 }} close={close} />);

// The lazy Markdown chunk's first import is slow: load it once before the tests.
beforeAll(async () => { await import('../../markdown/Markdown'); });

beforeEach(() => {
  vi.clearAllMocks();
  useForge.setState({ byTab: {} });
  useThreadFolds.setState({ open: {} });
  useRuntime.setState({ tabs: { t: { repo: { id: 4 } } as never } });
  patchForge('t', { kind: 'gitlab', remote: 'origin', details: { 12: { value: detail, at: 1 } }, discussions: { 12: threads } });
});

describe('the MR/PR view (spec #4 §4 "4B")', () => {
  it('only the Review… button carries a caret: the people + buttons and the Labels pencil have none', () => {
    show();
    const summary = within(screen.getByRole('dialog', { name: 'Merge request !12' })).getByRole('region', { name: 'Summary' });
    const carets = [...summary.querySelectorAll('.card-caret')].map((c) => c.closest('button')?.getAttribute('aria-label'));
    expect(carets).toEqual(['Review…']);
  });

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
    const flow = within(summary).getByRole('region', { name: 'Branches' });
    expect(flow).toHaveTextContent(/From\s*dev.*Into\s*main/);
    expect(flow.querySelector('svg.lucide-arrow-right')).not.toBeNull();
    const people = within(summary).getByRole('group', { name: 'Reviewers, assignees and labels' });
    expect(people).toHaveTextContent(/Reviewers.*Ada Lovelace.*Assignees\s*None/);
    expect(people).toHaveTextContent(/Labels\s*backend/);
    // Reviewers and assignees change here (MrPeople.test); labels in Edit, which the Labels card's pencil opens.
    // As cards: each header's + (top right), then the chips.
    expect([...people.querySelectorAll('.people-card')].map((c) => c.querySelector('.people-card-k')?.textContent)).toEqual(['Reviewers', 'Assignees', 'Labels']);
    expect(within(people).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Add reviewer', 'Remove Ada Lovelace', 'Add assignee', 'Edit labels']);
    for (const text of ['Open', 'Grace Hopper', 'Passed', '0 of 1 approval', 'None']) expect(summary).toHaveTextContent(text);
  });

  it('the status line ends in Check out, Edit and ⋯; Approve and Review… sit in the APPROVALS box; no "·" before the time', () => {
    show();
    const summary = screen.getByRole('region', { name: 'Summary' });
    const line = summary.querySelector<HTMLElement>('.mr-line')!;
    expect(line).toHaveTextContent(/^Open\s*(GH)?Grace Hopper\s*updated /);
    expect(line.textContent).not.toContain('·');
    const actions = within(line).getByRole('group', { name: 'Actions' });
    expect(within(actions).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim())).toEqual([expect.any(String), 'Edit', 'More actions']);
    expect(actions.previousElementSibling).toHaveClass('mr-spacer');
    const approvals = summary.querySelector<HTMLElement>('.mr-fact[data-fact="reviews"]')!;
    expect(within(approvals).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Approve', 'Review…']);
    // The old actions row is gone: nothing between the header and the merge box but the stack.
    expect(document.querySelectorAll('.mr-actions')).toHaveLength(1);
  });

  it('Review… opens its composer under the header', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Review…' }));
    const form = screen.getByRole('form', { name: 'Review' });
    expect(screen.getByRole('region', { name: 'Summary' }).compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(form.compareDocumentPosition(screen.getByRole('region', { name: 'Merge' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("colours a label with the forge's colour and shows its emoji shortcode as the emoji", async () => {
    const labelled = { ...detail.mr, labels: ['feature :gear:', 'plain :not_an_emoji:', 'constructor'], labelColors: { 'feature :gear:': '#a2eeef' } };
    patchForge('t', { details: { 12: { value: { ...detail, mr: labelled }, at: 1 } } });
    show();
    const chips = () => [...document.querySelectorAll<HTMLElement>('.people-pill')];
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

  it("shows the discussion: notes, a diff note's file:start-end and snippet (which opens the file), system notes as timeline events", () => {
    show();
    const activity = screen.getByRole('region', { name: 'Activity' });
    expect(within(activity).getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['Thread by Grace Hopper', 'Thread by Grace Hopper']);
    expect(activity).toHaveTextContent('Looks good overall.');
    expect(activity).toHaveTextContent('Grace Hopper added 1 commit');
    // The resolved diff thread is rolled up; its file:line still opens the file.
    expect(activity).toHaveTextContent('Grace Hopper started a thread on README.md:1-2');
    expect(activity).not.toHaveTextContent('+Second line');
    fireEvent.click(within(activity).getByRole('button', { name: 'README.md:1-2' }));
    expect(note.openNoteFile).toHaveBeenCalledWith('t', 'gitlab', expect.objectContaining({ number: 12 }), expect.objectContaining({ path: 'README.md', line: 2 }));
    fireEvent.click(within(activity).getByRole('button', { name: 'Show the resolved thread' }));
    expect(activity).toHaveTextContent('+Second line');
    expect(within(activity).getByRole('button', { name: 'Unresolve thread' })).toHaveAttribute('aria-pressed', 'true');
  });

  it("shows a diff note's suggestion as a diff of the lines it replaces, from the thread's snippet; past what the snippet has, only the lines it puts in", async () => {
    const at = (id: string, body: string, snippet: string) => ({ id, resolvable: true, resolved: false, notes: [{ id: `n${id}`, author: grace, body, createdAt: 1_791_100_300, system: false, position: { path: 'src/app.ts', oldPath: null, line: 7, oldLine: null, snippet, startLine: 5, startOldLine: 5 } }] });
    // A range note's snippet: its lines from the first, a removed one among them.
    const range = ' let a = 1;\n-let b = 2;\n+let b = 3;\n+let c = 4;';
    patchForge('t', { discussions: { 12: [
      at('s1', '```suggestion:-2+0\nlet a = 1;\nlet b = 30;\nlet c = 4;\n```', range),
      at('s2', '```suggestion:-5+0\nlet z = 0;\n```', range),
    ] } });
    show();
    const activity = screen.getByRole('region', { name: 'Activity' });
    await waitFor(() => expect(activity.querySelectorAll('.md-suggestion')).toHaveLength(2));
    const [one, two] = [...activity.querySelectorAll('.md-suggestion')].map((b) => [...b.querySelectorAll('.md-code-line')].map((l) => `${l.classList.contains('md-code-del') ? '-' : l.classList.contains('md-code-add') ? '+' : ' '}${l.textContent}`));
    expect(one).toEqual([' let a = 1;', '-let b = 3;', '+let b = 30;', ' let c = 4;']);
    expect(two).toEqual(['+let z = 0;']);
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

  it('keeps the tab bar while loading', () => {
    patchForge('t', { discussions: {} });
    show();
    expect(screen.getAllByRole('tab').filter((t) => !t.classList.contains('md-field-tab'))).toHaveLength(3);
    expect(screen.getByRole('status', { name: 'Loading the discussion' })).toBeTruthy();
  });

  it("shows a thread's own system note inside the thread, in order, not on the timeline", () => {
    const changed = 'changed this line in [version 2 of the diff](/group/project/-/merge_requests/12/diffs?diff_id=2#note_2)';
    const diff: ForgeDiscussion = { ...threads[1]!, resolved: false, notes: [
      threads[1]!.notes[0]!,
      { id: '2', author: grace, body: changed, createdAt: 1_791_136_000, system: true, position: null },
      { id: '3', author: user('Ada Lovelace'), body: 'Fixed it.', createdAt: 1_791_136_100, system: false, position: null },
    ] };
    patchForge('t', { discussions: { 12: [diff, threads[2]!] } });
    show();
    const article = screen.getByRole('article');
    const row = article.querySelector('.mr-thread-sys');
    expect(row).toHaveTextContent('Grace Hopper changed this line in version 2 of the diff');
    expect(row?.querySelector('.mr-node')).not.toBeNull();
    expect(row?.querySelector('time, .mr-when')).not.toBeNull();
    // In order among the thread's comments.
    const order = [...article.querySelectorAll('.mr-note, .mr-thread-sys')].map((e) => (e.classList.contains('mr-thread-sys') ? 'sys' : e.getAttribute('data-note')));
    expect(order).toEqual(['102', 'sys', '3']);
    // Not a standalone event: the timeline is the thread, then the later "added 1 commit".
    const events = [...document.querySelectorAll('.mr-timeline > .mr-ev')].map((e) => (e.classList.contains('mr-thread-ev') ? 'thread' : e.textContent));
    expect(events).toEqual(['thread', expect.stringContaining('added 1 commit')]);
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'version 2 of the diff' }));
    expect(api.openUrl).toHaveBeenCalledWith('https://gitlab.example.com/group/project/-/merge_requests/12/diffs?diff_id=2#note_2');
  });

  it("a folded thread folds its system notes with its replies, and counts only the replies", () => {
    const d: ForgeDiscussion = { ...threads[1]!, resolved: true, notes: [
      threads[1]!.notes[0]!,
      { id: '2', author: grace, body: 'changed this line in version 2 of the diff', createdAt: 1_791_136_000, system: true, position: null },
      { id: '3', author: user('Ada Lovelace'), body: 'Fixed it.', createdAt: 1_791_136_100, system: false, position: null },
    ] };
    patchForge('t', { discussions: { 12: [d] } });
    show();
    const article = screen.getByRole('article');
    expect(within(article).getByRole('button', { name: '1 reply' })).toHaveAttribute('aria-expanded', 'false');
    expect(article.querySelector('.mr-thread-sys')).toBeNull();
    expect(article).toHaveTextContent('Last reply by Ada Lovelace');
    fireEvent.click(within(article).getByRole('button', { name: '1 reply' }));
    expect(article.querySelector('.mr-thread-sys')).not.toBeNull();
  });

  it('a resolved thread rolls up whole, as GitLab: who started it where, who resolved it when, its replies; the chevron unrolls it and rolls it back', () => {
    const now = Math.floor(Date.now() / 1000);
    const d: ForgeDiscussion = { ...threads[1]!, resolved: true, resolvedBy: 'Ada Lovelace', resolvedAt: now - 120, notes: [
      threads[1]!.notes[0]!,
      { id: '3', author: user('Ada Lovelace'), body: 'Fixed it.', createdAt: 1_791_136_100, system: false, position: null },
    ] };
    const open: ForgeDiscussion = { ...threads[0]!, resolvable: true, resolved: false };
    patchForge('t', { discussions: { 12: [d, open] } });
    show();
    const [unresolved, rolled] = screen.getAllByRole('article');
    expect(rolled).toHaveTextContent('Grace Hopper started a thread on README.md:1-2');
    expect(rolled).toHaveTextContent('Resolved 2 minutes ago by Ada Lovelace');
    expect(rolled).toHaveTextContent('Last reply by Ada Lovelace');
    // The first comment's body and snippet are rolled up too.
    expect(rolled).not.toHaveTextContent('Second line');
    expect(rolled).not.toHaveTextContent('Fixed it.');
    // An unresolved thread stays unrolled.
    expect(unresolved).toHaveTextContent('Looks good overall.');
    expect(within(unresolved!).queryByRole('button', { name: /resolved thread/ })).toBeNull();
    const chevron = within(rolled!).getByRole('button', { name: 'Show the resolved thread' });
    expect(chevron).toHaveAttribute('aria-expanded', 'false');
    chevron.focus();
    fireEvent.click(chevron);
    expect(rolled).toHaveTextContent('+Second line');
    expect(rolled).toHaveTextContent('Fixed it.');
    const back = within(rolled!).getByRole('button', { name: 'Roll up the resolved thread' });
    expect(back).toHaveAttribute('aria-expanded', 'true');
    // The keyboard follows to the new chevron.
    expect(back).toHaveFocus();
    fireEvent.click(back);
    expect(rolled).not.toHaveTextContent('Fixed it.');
    // A click on the header unrolls it too; the choice is kept for the session (a new view).
    fireEvent.click(rolled!.querySelector('.mr-rolled')!);
    expect(rolled).toHaveTextContent('Fixed it.');
    cleanup();
    show();
    expect(screen.getAllByRole('article')[1]).toHaveTextContent('Fixed it.');
  });

  it("a resolved thread the forge says nothing more of says just Resolved; one with no replies has no replies' row", () => {
    patchForge('t', { discussions: { 12: [{ ...threads[1]!, resolved: true, resolvedBy: undefined }] } });
    show();
    const rolled = screen.getByRole('article');
    expect(rolled.querySelector('.mr-rolled-resolved')).toHaveTextContent(/^Resolved$/);
    expect(rolled.querySelector('.mr-replies-row')).toBeNull();
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

  it('a review left pending on it (a restart, the web page) is picked up once per open: the chip and Review… send it', async () => {
    api.forgeReviewDrafts.mockResolvedValueOnce({ refs: null, drafts: [{ id: '5', body: 'Why?', replyTo: null, position: null }], pendingReview: null, canDraft: true });
    show();
    await waitFor(() => expect(forgeOf('t').review?.number).toBe(12));
    expect(api.forgeReviewDrafts).toHaveBeenCalledTimes(1);
    expect(api.forgeReviewDrafts).toHaveBeenCalledWith(4, 12);
    expect(forgeOf('t').review?.drafts.map((d) => d.id)).toEqual(['5']);
    // A poll that changes the MR reads nothing more.
    act(() => patchForge('t', { details: { 12: { value: { ...detail, description: 'Edited' }, at: 2 } } }));
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(api.forgeReviewDrafts).toHaveBeenCalledTimes(1);
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

  describe('Edit mode: the form first', () => {
    const edit = () => fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    it('hides the cards, the merge box, the description and the activity (still mounted) and shows the form with the people rows below the description', () => {
      show();
      edit();
      const view = screen.getByRole('dialog', { name: 'Merge request !12' });
      // Reachable by role only while shown.
      for (const name of ['Merge', 'Description', 'Activity']) expect(within(view).queryByRole('region', { name })).toBeNull();
      expect(view.querySelector('.mr-facts')).toBeNull();
      expect(view.querySelector('.people-cards')).toBeNull();
      expect(view.querySelector('.mr-rest[hidden] [aria-label="Activity"]')).not.toBeNull();
      const summary = within(view).getByRole('region', { name: 'Summary' });
      expect(summary.querySelector('[aria-label="Branches"]')).not.toBeNull();
      const form = within(view).getByRole('form', { name: 'Edit' });
      const people = within(form).getByRole('group', { name: 'Reviewers, assignees and labels' });
      expect(people).toHaveTextContent(/Reviewers.*Ada Lovelace.*Assignees\s*.*Labels\s*backend/);
      expect(form.querySelector('.md-field')!.compareDocumentPosition(people) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(people).getByRole('button', { name: 'Add reviewer' })).toBeInTheDocument();
      expect(within(form).getByRole('textbox', { name: 'Title' })).toHaveFocus();
    });

    it('Cancel and Esc bring the normal layout back', async () => {
      show();
      edit();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.getByRole('region', { name: 'Activity' })).toBeInTheDocument();
      expect(screen.queryByRole('form', { name: 'Edit' })).toBeNull();
      edit();
      // The flyout host's Esc asks the owners (FlyoutHost.test): the form's leaves Edit.
      const { escOwners } = await import('../../app/modalKeys');
      const e = new KeyboardEvent('keydown', { key: 'Escape' });
      Object.defineProperty(e, 'target', { value: screen.getByRole('textbox', { name: 'Title' }) });
      act(() => { expect([...escOwners].some((own) => own(e))).toBe(true); });
      expect(screen.queryByRole('form', { name: 'Edit' })).toBeNull();
      expect(screen.getByRole('region', { name: 'Merge' })).toBeInTheDocument();
    });

    it("the Labels card's pencil opens Edit with the label picker open", async () => {
      show();
      fireEvent.click(screen.getByRole('button', { name: 'Edit labels' }));
      expect(screen.getByRole('form', { name: 'Edit' })).toBeInTheDocument();
      expect(await screen.findByRole('combobox', { name: /label/i })).toBeInTheDocument();
    });
  });
});
// --- end 5B T3 ---
