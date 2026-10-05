import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { SignaturePayload } from '../api/gen/SignaturePayload';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { createRepoViewStore, RepoViewContext } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { SignatureBadge } from './SignatureBadge';

const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] };
const verified: SignaturePayload = { kind: 'verified', signer: 'ada@example.com', key: 'SHA256:k', fingerprint: 'SHA256:k', trust: 'fully', detail: null };

function renderBadge(fetch: (id: string) => Promise<SignaturePayload>, id: string, signed: boolean) {
  const store = createRepoViewStore(1, '/r', graph, fakeServices({ signature: new Loader(fetch, new Lru(5)) }));
  return render(<RepoViewContext value={store}><SignatureBadge id={id} signed={signed} /></RepoViewContext>);
}

describe('SignatureBadge', () => {
  it('shows a dim "Not signed" icon without asking git; its hover card says so', () => {
    const fetch = vi.fn(async () => verified);
    renderBadge(fetch, 'a'.repeat(40), false);
    const badge = screen.getByTestId('signature-badge');
    expect(badge).toHaveAttribute('data-kind', 'unsigned');
    expect(badge).toHaveAccessibleName('Not signed');
    expect(badge.textContent).toBe(''); // icon only (F16)
    fireEvent.mouseEnter(badge);
    expect(screen.getByRole('tooltip')).toHaveTextContent(/^Not signed$/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('draws a different icon for every status (F16)', async () => {
    const kinds = ['verified', 'unverified', 'bad', 'expired', 'unknownKey'] as const;
    const drawings = new Set<string>();
    for (const [i, kind] of kinds.entries()) {
      const { unmount } = renderBadge(async () => ({ ...verified, kind }), String(i).repeat(40), true);
      const badge = await screen.findByTestId('signature-badge');
      await screen.findByRole('img', { name: { verified: 'Verified', unverified: 'Unverified', bad: 'Bad signature', expired: 'Expired', unknownKey: 'Unknown key' }[kind] });
      expect(badge).toHaveAttribute('data-kind', kind);
      drawings.add(badge.querySelector('svg')!.innerHTML);
      unmount();
    }
    const { unmount } = renderBadge(async () => verified, 'f'.repeat(40), false);
    drawings.add(screen.getByTestId('signature-badge').querySelector('svg')!.innerHTML);
    unmount();
    expect(drawings.size).toBe(kinds.length + 1);
  });

  it('checks a signed commit lazily and shows the signer, key and trust in a portaled hover card', async () => {
    const fetch = vi.fn(async () => verified);
    renderBadge(fetch, 'b'.repeat(40), true);
    expect(screen.getByTestId('signature-badge')).toHaveAttribute('data-kind', 'loading');
    const badge = await screen.findByRole('img', { name: 'Verified' });
    expect(badge).toBe(screen.getByTestId('signature-badge'));
    expect(badge).toHaveAttribute('data-kind', 'verified');
    expect(fetch).toHaveBeenCalledWith('b'.repeat(40));
    fireEvent.mouseEnter(badge);
    const card = screen.getByRole('tooltip');
    // Portaled to <body>, so the scrolling details panel can't clip it.
    expect(badge.contains(card)).toBe(false);
    expect(card).toHaveTextContent(/^Verified/); // the status, now that the badge has no text
    expect(card).toHaveTextContent('Signer: ada@example.com');
    expect(card).toHaveTextContent('Key: SHA256:k');
    expect(card).toHaveTextContent('Trust: fully');
    // The fingerprint equals the key: not repeated.
    expect(card).not.toHaveTextContent('Fingerprint');
    fireEvent.mouseLeave(badge);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('keeps its box empty for the first 300 ms of a check, then shows the dim "checking" shield', () => {
    vi.useFakeTimers();
    try {
      renderBadge(() => new Promise<SignaturePayload>(() => {}), '9'.repeat(40), true);
      const badge = screen.getByTestId('signature-badge');
      expect(badge).toHaveAttribute('data-kind', 'loading');
      expect(badge).toHaveClass('sig-pending');
      expect(badge.querySelector('svg')).not.toBeNull(); // the box is reserved: no shift later
      act(() => vi.advanceTimersByTime(299));
      expect(badge).toHaveClass('sig-pending');
      act(() => vi.advanceTimersByTime(1));
      expect(badge).not.toHaveClass('sig-pending');
      expect(badge).toHaveAccessibleName('Checking signature…');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a check already cached shows its status at once, never the pending box', () => {
    const loader = new Loader(async () => verified, new Lru<string, SignaturePayload>(5));
    loader.cache.set('8'.repeat(40), verified);
    const store = createRepoViewStore(1, '/r', graph, fakeServices({ signature: loader }));
    render(<RepoViewContext value={store}><SignatureBadge id={'8'.repeat(40)} signed /></RepoViewContext>);
    const badge = screen.getByTestId('signature-badge');
    expect(badge).toHaveAttribute('data-kind', 'verified');
    expect(badge).not.toHaveClass('sig-pending');
  });

  it('shows a bad signature with its detail, and a failed check as such', async () => {
    renderBadge(async () => ({ kind: 'bad', signer: '', key: 'ABCD', fingerprint: 'ABCD1234', trust: '', detail: 'BAD signature from x' }), 'c'.repeat(40), true);
    const badge = await screen.findByRole('img', { name: 'Bad signature' });
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
    expect(await screen.findByRole('img', { name: 'Signature check failed' })).toBeInTheDocument();
    const badge = screen.getByTestId('signature-badge');
    expect(badge).toHaveAttribute('data-kind', 'error');
    fireEvent.mouseEnter(badge);
    expect(screen.getByRole('tooltip')).toHaveTextContent('gpg not found');
  });

  it('is focusable, and keyboard focus shows the same hover card (review fix)', () => {
    renderBadge(async () => verified, 'e'.repeat(40), false);
    const badge = screen.getByTestId('signature-badge');
    expect(badge).toHaveAttribute('tabindex', '0');
    act(() => badge.focus());
    expect(screen.getByRole('tooltip')).toHaveTextContent(/^Not signed$/);
    act(() => badge.blur());
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
