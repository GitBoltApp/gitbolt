import { act, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const avatar = vi.hoisted(() => vi.fn(async (email: string) => (email === 'ada@example.com' ? { mime: 'image/png', base64: btoa('png') } : null)));
vi.mock('../api/client', () => ({ api: { avatar } }));

import { GRAPH_COLORS } from '../theme/graphColors';
import { resolveColors } from '../theme/apply';
import { useTheme } from '../theme/store';
import { THEMES } from '../theme/themes';
import type { ForgeUser } from '../api/gen/ForgeUser';
import { Avatar, ForgeAvatar } from './Avatar';
import { AvatarStoreContext, ForgeAvatarStoreContext, createAvatarStore } from './avatarStore';

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:ada');
  URL.revokeObjectURL = vi.fn();
});

describe('Avatar', () => {
  it('shows initials on a lane colour picked by the email, then the image once it arrives', async () => {
    render(<Avatar name="Ada Lovelace" email="Ada@Example.com" size={28} />);
    const el = screen.getByTestId('avatar');
    expect(el).toHaveTextContent('AL');
    expect(GRAPH_COLORS.map((c) => c.toLowerCase())).toContain(rgbToHex(el.style.background));
    await act(async () => {});
    expect(el.querySelector('img')).toHaveAttribute('src', 'blob:ada');
    expect(el).toHaveTextContent('');
    expect(avatar).toHaveBeenCalledWith('ada@example.com');
  });

  it('keeps the initials when there is no avatar, and the same colour for the same email', async () => {
    const { unmount } = render(<Avatar name="Grace Hopper" email="grace@example.com" />);
    const first = screen.getByTestId('avatar').style.background;
    await act(async () => {});
    expect(screen.getByTestId('avatar')).toHaveTextContent('GH');
    unmount();
    render(<Avatar name="Someone Else" email="GRACE@example.com" />);
    expect(screen.getByTestId('avatar').style.background).toBe(first);
  });
});

describe('Avatar and the theme', () => {
  it("follows the theme's lane palette, the same lane for the same person", () => {
    act(() => useTheme.getState().set('default-dark', {}));
    render(<Avatar name="Grace Hopper" email="grace@example.com" request={false} />);
    const el = screen.getByTestId('avatar');
    const lane = GRAPH_COLORS.indexOf(rgbToHex(el.style.background));
    expect(lane).toBeGreaterThanOrEqual(0);
    expect(rgbToHex(el.style.color)).toBe('#ffffff');
    act(() => useTheme.getState().set('nord', {}));
    expect(rgbToHex(el.style.background)).toBe(THEMES.nord.graph[lane]);
    expect(rgbToHex(el.style.color)).toBe(resolveColors(THEMES.nord).laneText[lane]);
    act(() => useTheme.getState().set('default-dark', {}));
  });
});

describe('ForgeAvatar (the MR/PR view, the hover card)', () => {
  it("fetches the forge's avatar URL as given (case kept), and the email's only without one", async () => {
    const byUrl = vi.fn(async () => ({ mime: 'image/png', base64: btoa('png') }));
    const byEmail = vi.fn(async () => null);
    const urls = createAvatarStore(byUrl, { keyOf: (u) => u.trim() });
    const emails = createAvatarStore(byEmail);
    const url = 'https://avatars.githubusercontent.com/u/583231?v=4&X=Y';
    const octocat: ForgeUser = { id: 1, username: 'octocat', name: 'The Octocat', avatarUrl: url, webUrl: '', email: 'Octo@Example.com' };
    const wrap = (u: ForgeUser) => (
      <AvatarStoreContext value={emails}><ForgeAvatarStoreContext value={urls}><ForgeAvatar user={u} size={20} /></ForgeAvatarStoreContext></AvatarStoreContext>
    );
    const { unmount } = render(wrap(octocat));
    await act(async () => {});
    expect(screen.getByTestId('avatar').querySelector('img')).not.toBeNull();
    expect([byUrl.mock.calls, byEmail.mock.calls]).toEqual([[[url]], []]);
    unmount();
    render(wrap({ ...octocat, avatarUrl: null }));
    await act(async () => {});
    expect(byEmail).toHaveBeenCalledWith('octo@example.com');
    expect(screen.getByTestId('avatar')).toHaveTextContent('TO');
  });

  it('asks for nothing without a URL or an email', async () => {
    const fetch = vi.fn(async () => null);
    render(<ForgeAvatarStoreContext value={createAvatarStore(fetch)}><ForgeAvatar user={{ id: 1, username: 'g', name: 'Grace Hopper', avatarUrl: null, webUrl: '', email: null }} size={20} /></ForgeAvatarStoreContext>);
    await act(async () => {});
    expect(fetch).not.toHaveBeenCalled();
    expect(avatar).not.toHaveBeenCalledWith('');
  });
});

describe('Avatar with a bounded cache', () => {
  it('re-requests its image after the cache evicted it', async () => {
    const fetch = vi.fn(async () => ({ mime: 'image/png', base64: btoa('png') }));
    const store = createAvatarStore(fetch, { capacity: 1 });
    render(<AvatarStoreContext value={store}><Avatar name="Ada Lovelace" email="ada@x" /></AvatarStoreContext>);
    await act(async () => {});
    expect(screen.getByTestId('avatar').querySelector('img')).not.toBeNull();
    // Another avatar arrives and evicts Ada's (capacity 1): the mounted Avatar asks again.
    await act(async () => { store.request('other@x'); });
    await act(async () => {});
    expect(fetch.mock.calls.map((c) => (c as unknown as string[])[0])).toEqual(['ada@x', 'other@x', 'ada@x']);
    expect(screen.getByTestId('avatar').querySelector('img')).not.toBeNull();
  });
});

function rgbToHex(rgb: string): string {
  const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(rgb);
  return m ? `#${m.slice(1).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}` : rgb;
}

describe('Avatar that never asks (request={false})', () => {
  it('shows what the cache has, and picks up an image someone else requested, without asking itself', async () => {
    const fetch = vi.fn(async () => ({ mime: 'image/png', base64: btoa('png') }));
    const store = createAvatarStore(fetch);
    render(<AvatarStoreContext value={store}><Avatar name="Ada Lovelace" email="ada@y" request={false} /></AvatarStoreContext>);
    await act(async () => {});
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByTestId('avatar')).toHaveTextContent('AL');
    await act(async () => { store.request('ada@y'); });
    await act(async () => {});
    expect(screen.getByTestId('avatar').querySelector('img')).not.toBeNull();
  });
});
