import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { SignaturePayload } from '../api/gen/SignaturePayload';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { createRepoViewStore, RepoViewContext } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { SignatureBadge } from './SignatureBadge';

const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: true }, truncated: false };
const verified: SignaturePayload = { kind: 'verified', signer: 'ada@example.com', key: 'SHA256:k', fingerprint: 'SHA256:k', trust: 'fully', detail: null };

function renderBadge(fetch: (id: string) => Promise<SignaturePayload>, id: string, signed: boolean) {
  const store = createRepoViewStore(1, '/r', graph, fakeServices({ signature: new Loader(fetch, new Lru(5)) }));
  return render(<RepoViewContext value={store}><SignatureBadge id={id} signed={signed} /></RepoViewContext>);
}

describe('SignatureBadge', () => {
  it('shows "Not signed" without asking git, and no hover card', () => {
    const fetch = vi.fn(async () => verified);
    renderBadge(fetch, 'a'.repeat(40), false);
    const badge = screen.getByTestId('signature-badge');
    expect(badge).toHaveAttribute('data-kind', 'unsigned');
    expect(badge).toHaveTextContent('Not signed');
    fireEvent.mouseEnter(badge);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('checks a signed commit lazily and shows the signer, key and trust in a portaled hover card', async () => {
    const fetch = vi.fn(async () => verified);
    renderBadge(fetch, 'b'.repeat(40), true);
    expect(screen.getByTestId('signature-badge')).toHaveAttribute('data-kind', 'loading');
    expect(await screen.findByText('Verified')).toBeInTheDocument();
    const badge = screen.getByTestId('signature-badge');
    expect(badge).toHaveAttribute('data-kind', 'verified');
    expect(fetch).toHaveBeenCalledWith('b'.repeat(40));
    fireEvent.mouseEnter(badge);
    const card = screen.getByRole('tooltip');
    // Portaled to <body>, so the scrolling details panel can't clip it.
    expect(badge.contains(card)).toBe(false);
    expect(card).toHaveTextContent('Signer: ada@example.com');
    expect(card).toHaveTextContent('Key: SHA256:k');
    expect(card).toHaveTextContent('Trust: fully');
    // The fingerprint equals the key: not repeated.
    expect(card).not.toHaveTextContent('Fingerprint');
    fireEvent.mouseLeave(badge);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows a bad signature with its detail, and a failed check as such', async () => {
    renderBadge(async () => ({ kind: 'bad', signer: '', key: 'ABCD', fingerprint: 'ABCD1234', trust: '', detail: 'BAD signature from x' }), 'c'.repeat(40), true);
    const badge = await screen.findByText('Bad signature');
    fireEvent.mouseEnter(screen.getByTestId('signature-badge'));
    const card = screen.getByRole('tooltip');
    expect(card).toHaveTextContent('Fingerprint: ABCD1234');
    expect(card).toHaveTextContent('BAD signature from x');
    expect(card).not.toHaveTextContent('Signer');
    expect(card).not.toHaveTextContent('Trust');
    expect(badge).toBeInTheDocument();
  });

  it('a failed check says so instead of staying on "Checking"', async () => {
    renderBadge(async () => { throw { kind: 'Git', message: 'gpg not found' }; }, 'd'.repeat(40), true);
    expect(await screen.findByText('Signature check failed')).toBeInTheDocument();
    const badge = screen.getByTestId('signature-badge');
    expect(badge).toHaveAttribute('data-kind', 'error');
    fireEvent.mouseEnter(badge);
    expect(screen.getByRole('tooltip')).toHaveTextContent('gpg not found');
  });
});
