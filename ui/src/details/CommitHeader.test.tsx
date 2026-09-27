import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createCommitMessageCache } from '../api/commitMessages';
import type { CommitDetailsPayload } from '../api/gen/CommitDetailsPayload';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { RepoView } from '../repo/RepoView';
import { fakeServices } from '../repo/testServices';

// No transport in unit tests: `api.avatar` rejects, so every avatar keeps its initials.
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}) }));
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const row = (id: string, summary: string, parents: string[]): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary, bodyFirstLine: '', authorName: 'Grace Hopper', authorEmail: 'grace@example.com', authorTime: 1_767_225_600, committerTime: 1_767_225_600, parents, mrRefs: [], wip: null });
const graph: GraphPayload = { rows: [row(A, 'Rename', [B]), row(B, 'First', [])], labels: [], maxLanes: 1, pinnedRef: null, head: { branch: 'refs/heads/main', target: A, detached: false, unborn: false }, truncated: false };
const details: CommitDetailsPayload = {
  id: A, parents: [B], signed: false,
  author: { name: 'Grace Hopper', email: 'grace@example.com', time: 1_767_225_600 },
  committer: { name: 'Ada Lovelace', email: 'ada@example.com', time: 1_767_225_660 },
  coAuthors: [{ name: 'Margaret Hamilton', email: 'margaret@example.com' }, { name: 'Linus Torvalds', email: 'linus@example.com' }],
};

function renderView() {
  const services = fakeServices({
    details: new Loader(async () => details, new Lru(4)),
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

  it('a co-author chip shows the name and email in a hover card outside the scrolling panel', async () => {
    renderView();
    const chip = (await screen.findAllByTestId('co-author'))[0];
    fireEvent.mouseEnter(chip);
    const card = screen.getByRole('tooltip');
    expect(card).toHaveTextContent('Margaret Hamilton');
    expect(card).toHaveTextContent('margaret@example.com');
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
});
