import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createCommitMessageCache } from '../api/commitMessages';
import type { CommitDetailsPayload } from '../api/gen/CommitDetailsPayload';
import type { FileListPayload } from '../api/gen/FileListPayload';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { formatDate } from '../format/date';
import { RepoView } from '../repo/RepoView';
import { fakeServices } from '../repo/testServices';

// No transport in unit tests: `api.avatar` rejects, so every avatar keeps its initials.
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}) }));
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const row = (id: string, summary: string, parents: string[]): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary, bodyFirstLine: '', authorName: 'Grace Hopper', authorEmail: 'grace@example.com', authorTime: 1_767_225_600, committerTime: 1_767_225_600, parents, mrRefs: [], wip: null });
const graph: GraphPayload = { rows: [row(A, 'Rename', [B]), row(B, 'First', [])], labels: [], maxLanes: 1, pinnedRef: null, head: { branch: 'refs/heads/main', target: A, detached: false, unborn: false }, truncated: false, worktrees: [] };
const details: CommitDetailsPayload = {
  id: A, parents: [B], signed: false,
  author: { name: 'Grace Hopper', email: 'grace@example.com', time: 1_767_225_600 },
  committer: { name: 'Ada Lovelace', email: 'ada@example.com', time: 1_767_225_660 },
  coAuthors: [{ name: 'Margaret Hamilton', email: 'margaret@example.com' }, { name: 'Linus Torvalds', email: 'linus@example.com' }],
};

function renderView(d: CommitDetailsPayload = details) {
  const services = fakeServices({
    details: new Loader(async () => d, new Lru(4)),
    files: new Loader(async (): Promise<FileListPayload> => ({ files: [], added: 0, deleted: 0 }), new Lru(4)),
    messages: createCommitMessageCache(async (id) => ({ id, summary: 'Rename', body: 'Refs !42, fixes #12.' })),
    remotes: async () => [{ name: 'origin', host: 'gitlab.example.com', path: 'group/project', hostKind: 'gitlab' }],
  });
  render(<RepoView repo={1} repoPath="/r" graph={graph} services={services} />);
  fireEvent.mouseDown(screen.getAllByRole('row')[0]);
}

describe('commit header', () => {
  it('shows avatars for the author and committer, co-author chips, and the signature badge', async () => {
    renderView();
    const author = await screen.findByTestId('author');
    expect(within(author).getByTestId('avatar')).toHaveTextContent('GH');
    expect(within(screen.getByTestId('committer')).getByTestId('avatar')).toHaveTextContent('AL');
    const chips = screen.getAllByTestId('co-author');
    expect(chips.map((c) => c.textContent)).toEqual(['MHMargaret Hamilton', 'LTLinus Torvalds']);
    expect(screen.getByTestId('signature-badge')).toHaveAttribute('data-kind', 'unsigned');
  });

  it('K5: the signature and hashes row is the open file\'s bar box, its divider below it', async () => {
    renderView();
    const ids = (await screen.findByTestId('details-sha')).closest('.commit-ids');
    expect(ids).toHaveClass('panel-bar');
    expect(ids).toContainElement(screen.getByTestId('signature-badge'));
  });

  it('a co-author chip shows the name and email in a hover card outside the scrolling panel', async () => {
    renderView();
    const chip = (await screen.findAllByTestId('co-author'))[0];
    fireEvent.mouseEnter(chip);
    const card = screen.getByRole('tooltip');
    expect(card).toHaveTextContent(/^Margaret Hamilton <margaret@example\.com>$/);
    expect(screen.getByRole('complementary', { name: 'Commit details' }).contains(card)).toBe(false);
    fireEvent.mouseLeave(chip);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('links the message against the project remote and offers Open buttons', async () => {
    renderView();
    const link = await screen.findByRole('link', { name: '!42' });
    expect(link).toHaveAttribute('href', 'https://gitlab.example.com/group/project/-/merge_requests/42');
    expect(screen.getByRole('link', { name: '#12' })).toHaveAttribute('href', 'https://gitlab.example.com/group/project/-/issues/12');
    expect(screen.getByRole('button', { name: 'Open !42' })).toBeInTheDocument();
  });

  it('hovering the author or the committer shows their full "Name <email>" (F14)', async () => {
    renderView();
    const author = await screen.findByTestId('author');
    const name = within(author).getByText('Grace Hopper');
    fireEvent.mouseEnter(name);
    expect(screen.getByRole('tooltip')).toHaveTextContent(/^Grace Hopper <grace@example\.com>$/);
    expect(author.contains(screen.getByRole('tooltip'))).toBe(false); // portaled
    fireEvent.mouseLeave(name);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseEnter(within(screen.getByTestId('committer')).getByText('Ada Lovelace'));
    expect(screen.getByRole('tooltip')).toHaveTextContent(/^Ada Lovelace <ada@example\.com>$/);
  });

  // F15, with the review fix: the committed date is primary and first; when the committer is a
  // different person it sits on their row, so it can't be read as the author's.
  it('same person: the committed date first, the author date below it, dimmer, only when it differs (F15)', async () => {
    const same = { ...details, committer: { ...details.author, time: details.author.time + 60 } };
    renderView(same);
    const author = await screen.findByTestId('author');
    const dates = within(author).getAllByTestId(/-date$/);
    expect(dates.map((d) => d.dataset.testid)).toEqual(['commit-date', 'author-date']);
    expect(dates[0]).toHaveTextContent(new RegExp(`^${formatDate(same.committer.time)}$`));
    expect(dates[1]).toHaveTextContent(`authored ${formatDate(same.author.time)}`);
    expect(dates[1]).toHaveClass('dim');
    expect(dates[0]).not.toHaveClass('dim');
    expect(screen.queryByTestId('committer')).toBeNull();
  });

  it('shows one date when the author and commit dates are the same (F15)', async () => {
    renderView({ ...details, committer: { ...details.author } });
    const author = await screen.findByTestId('author');
    expect(within(author).getByTestId('commit-date')).toHaveTextContent(formatDate(details.author.time));
    expect(within(author).queryByTestId('author-date')).toBeNull();
  });

  it('a different committer\'s row carries the committed date; the author\'s row the author date (review fix)', async () => {
    renderView();
    const author = await screen.findByTestId('author');
    const committer = screen.getByTestId('committer');
    expect(within(committer).getByTestId('commit-date')).toHaveTextContent(new RegExp(`^${formatDate(details.committer.time)}$`));
    expect(within(committer).getByTestId('commit-date')).not.toHaveClass('dim');
    expect(within(author).queryByTestId('commit-date')).toBeNull();
    expect(within(author).getByTestId('author-date')).toHaveTextContent(`authored ${formatDate(details.author.time)}`);
    // Same time, different person: the committer row still has the date; the author row none.
    cleanup();
    renderView({ ...details, committer: { ...details.committer, time: details.author.time } });
    await screen.findByTestId('author');
    expect(within(screen.getByTestId('committer')).getByTestId('commit-date')).toBeInTheDocument();
    expect(within(screen.getByTestId('author')).queryByTestId('author-date')).toBeNull();
  });

  it('the top row is signature icon, SHA, parents: a justified three-part row (F16)', async () => {
    renderView();
    const sha = await screen.findByTestId('details-sha');
    const row = sha.parentElement!.parentElement!; // .commit-id, in the row (H11)
    expect(row).toHaveClass('commit-ids');
    expect([...row.children].map((c) => c.className)).toEqual(['commit-ids-start', 'commit-id', 'parents']);
    const badge = within(row.children[0] as HTMLElement).getByTestId('signature-badge');
    // Just an icon, named for assistive tech; no text label.
    expect(badge).toHaveAccessibleName('Not signed');
    expect(badge.textContent).toBe('');
    expect(within(row.children[2] as HTMLElement).getByTestId('parent-sha')).toHaveTextContent(B.slice(0, 6));
  });

  it('labels the hashes "commit:" and "parent:" (H11)', async () => {
    renderView();
    const sha = await screen.findByTestId('details-sha');
    const id = sha.parentElement!;
    expect(id).toHaveClass('commit-id');
    expect(id).toHaveTextContent(`commit: ${A.slice(0, 6)}`);
    expect(id.querySelector('.id-label')).toHaveTextContent(/^commit:$/);
    const parents = screen.getByTestId('parent-sha').parentElement!;
    expect(parents).toHaveTextContent(`parent: ${B.slice(0, 6)}`);
    expect(parents.querySelector('.id-label')).toHaveTextContent(/^parent:$/);
    cleanup();
    renderView({ ...details, parents: [B, A] });
    await screen.findByTestId('details-sha');
    expect(screen.getAllByTestId('parent-sha')[0].parentElement!.querySelector('.id-label')).toHaveTextContent(/^parents:$/);
  });

  it('the parent hash says "Go to parent commit" at once, and the SHA "Copy full SHA" (H11)', async () => {
    renderView();
    const parent = await screen.findByTestId('parent-sha');
    expect(parent).not.toHaveAttribute('title');
    fireEvent.mouseEnter(parent);
    expect(screen.getByRole('tooltip')).toHaveTextContent(/^Go to parent commit$/);
    fireEvent.mouseLeave(parent);
    const sha = screen.getByTestId('details-sha');
    expect(sha).not.toHaveAttribute('title');
    fireEvent.mouseEnter(sha);
    expect(screen.getByRole('tooltip')).toHaveTextContent(/^Copy full SHA$/);
    // Keyboard users get the same words as a description.
    expect(parent).toHaveAccessibleDescription('Go to parent commit');
    expect(sha).toHaveAccessibleDescription('Copy full SHA');
  });

  it('the message sits in its own darker box (H11)', async () => {
    renderView();
    await screen.findByTestId('details-sha');
    expect(screen.getByTestId('commit-message')).toHaveClass('message-box');
  });
});

