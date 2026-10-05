import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ForgeAvatarStoreContext, createAvatarStore } from '../avatars/avatarStore';
import { MrCard } from './MrCard';
import { detailOf, mrOf, user } from './testMrs';

describe('MrCard (spec #4 §4 "4B": the hover card)', () => {
  const mr = mrOf(12, { title: 'Dev work', pipeline: { status: 'success', webUrl: null }, conflicts: null });

  it('shows at once what the badge knows, and Loading… for what the detail adds', () => {
    render(<MrCard kind="gitlab" mr={mr} detail={null} hint="Click to open" />);
    const card = screen.getByLabelText('Merge request !12 details');
    expect(card).toHaveTextContent('!12 Dev work');
    expect(card).toHaveTextContent('Grace Hopper · dev → main');
    expect(card).toHaveTextContent('Pipeline passed');
    expect(card).toHaveTextContent('Loading…');
    expect(card).toHaveTextContent('Click to open');
  });

  it("shows the detail's review and conflicts, and a draft", () => {
    const draft = mrOf(5, { state: 'draft', title: 'Explore' });
    const d = detailOf(draft, { mr: { ...draft, conflicts: true, review: { decision: 'approved', approvals: 1, approvalsRequired: null, reviews: [{ user: user('Ada Lovelace'), state: 'approved', submittedAt: null }] } } });
    render(<MrCard kind="github" mr={draft} detail={d} />);
    const card = screen.getByLabelText('Pull request #5 details');
    expect(card).toHaveTextContent('· Draft');
    expect(card).toHaveTextContent('No checks');
    expect(card).toHaveTextContent('Approved by Ada Lovelace');
    expect(card).toHaveTextContent('Has conflicts');
    expect(card).not.toHaveTextContent('Loading…');
  });

  it("shows the author's avatar before the name: its box from the first render, initials until the picture comes", async () => {
    URL.createObjectURL = vi.fn(() => 'blob:grace');
    URL.revokeObjectURL = vi.fn();
    const url = 'https://gitlab.example.com/uploads/-/system/user/avatar/1/grace.png';
    const fetch = vi.fn(async () => ({ mime: 'image/png', base64: btoa('png') }));
    const store = createAvatarStore(fetch, { keyOf: (u) => u.trim() });
    const withPic = mrOf(12, { author: { ...user('Grace Hopper'), avatarUrl: url } });
    render(<ForgeAvatarStoreContext value={store}><MrCard kind="gitlab" mr={withPic} detail={null} /></ForgeAvatarStoreContext>);
    const avatar = screen.getByTestId('avatar');
    expect([avatar.textContent, avatar.style.width, avatar.style.height]).toEqual(['GH', '16px', '16px']);
    expect(avatar.closest('.mr-card-author')).toHaveTextContent('Grace Hopper · dev → main');
    await act(async () => {});
    expect(avatar.querySelector('img')).toHaveAttribute('src', 'blob:grace');
    expect([avatar.style.width, avatar.style.height]).toEqual(['16px', '16px']);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url);
  });

  it("says why the detail couldn't load", () => {
    render(<MrCard kind="gitlab" mr={mr} detail={null} error="gitlab.example.com rate limit reached: try again in 2 min" />);
    expect(screen.getByLabelText('Merge request !12 details')).toHaveTextContent("Couldn't load: gitlab.example.com rate limit reached: try again in 2 min");
  });
});
