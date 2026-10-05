import { act, fireEvent, render, screen } from '@testing-library/react';
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

let objectUrls = 0;
beforeAll(() => {
  // Unique, as the browser's are: an image known to have loaded is known by its URL.
  URL.createObjectURL = vi.fn(() => `blob:ada-${++objectUrls}`);
  URL.revokeObjectURL = vi.fn();
});

describe('Avatar', () => {
  it('shows initials on a lane colour picked by the email, then the image once it arrives', async () => {
    render(<Avatar name="Ada Lovelace" email="Ada@Example.com" size={28} />);
    const el = screen.getByTestId('avatar');
    expect(el).toHaveTextContent('AL');
    expect(GRAPH_COLORS.map((c) => c.toLowerCase())).toContain(rgbToHex(el.style.background));
    await act(async () => {});
    // It waits, unseen, over the initials until the browser has loaded it.
    const img = el.querySelector('img')!;
    expect(img.getAttribute('src')).toMatch(/^blob:ada-/);
    expect(img).toHaveAttribute('data-loading');
    expect(el).toHaveTextContent('AL');
    fireEvent.load(img);
    expect(img).not.toHaveAttribute('data-loading');
    expect(el).toHaveTextContent('');
    expect(avatar).toHaveBeenCalledWith('ada@example.com', undefined, 'Ada Lovelace');
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
    expect(byEmail).toHaveBeenCalledWith('octo@example.com', undefined, 'The Octocat');
    expect(screen.getByTestId('avatar')).toHaveTextContent('TO');
  });

  it('asks for nothing without a URL or an email', async () => {
    const fetch = vi.fn(async () => null);
    render(<ForgeAvatarStoreContext value={createAvatarStore(fetch)}><ForgeAvatar user={{ id: 1, username: 'g', name: 'Grace Hopper', avatarUrl: null, webUrl: '', email: null }} size={20} /></ForgeAvatarStoreContext>);
    await act(async () => {});
    expect(fetch).not.toHaveBeenCalled();
    expect(avatar).not.toHaveBeenCalledWith('');
  });

  it("an avatar URL whose image fails to load shows the initials, not an <img> (no broken-image icon)", async () => {
    // The fake forge's truncated PNG: it arrives, but the browser can't decode it.
    const urls = createAvatarStore(vi.fn(async () => ({ mime: 'image/png', base64: btoa('\x89PNG\r\n\x1a\nfake') })), { keyOf: (u) => u.trim() });
    const ada: ForgeUser = { id: 7, username: 'ada', name: 'Ada Lovelace', avatarUrl: 'https://gitlab.example.com/uploads/ada.png', webUrl: '', email: null };
    render(<ForgeAvatarStoreContext value={urls}><ForgeAvatar user={ada} size={18} /></ForgeAvatarStoreContext>);
    const el = screen.getByTestId('avatar');
    expect(el).toHaveTextContent('AL');
    await act(async () => {});
    // Loading: the initials show; the image waits unseen over them.
    expect(el).toHaveTextContent('AL');
    expect(el.querySelector('img')).toHaveAttribute('data-loading');
    fireEvent.error(el.querySelector('img')!);
    expect(el.querySelector('img')).toBeNull();
    expect(el).toHaveTextContent('AL');
  });
});

describe('Avatar for an image already loaded elsewhere (the graph, then the details header)', () => {
  it('renders the <img> on its first render, with no initials frame', async () => {
    const fetch = vi.fn(async () => ({ mime: 'image/png', base64: btoa('png') }));
    const store = createAvatarStore(fetch);
    const wrap = (size: number) => <AvatarStoreContext value={store}><Avatar name="Ada Lovelace" email="ada@seen" size={size} /></AvatarStoreContext>;
    const first = render(wrap(16));
    await act(async () => {});
    fireEvent.load(first.getByTestId('avatar').querySelector('img')!);
    first.unmount();
    // A new surface mounts the same person: the image straight away, no initials, no waiting.
    const frames: string[] = [];
    const Probe = () => { frames.push(document.querySelector('[data-testid=avatar]')?.textContent ?? ''); return null; };
    const { getByTestId } = render(<>{wrap(28)}<Probe /></>);
    const el = getByTestId('avatar');
    const img = el.querySelector('img')!;
    expect(img).not.toBeNull();
    expect(img).not.toHaveAttribute('data-loading');
    expect(el).toHaveTextContent('');
    expect(frames.every((t) => t === '')).toBe(true);
  });

  it('an image the store decoded on arrival renders directly, with no load event needed', async () => {
    const decode = vi.fn(async () => {});
    const proto = HTMLImageElement.prototype as unknown as { decode?: () => Promise<void> };
    const had = proto.decode;
    proto.decode = decode;
    try {
      const store = createAvatarStore(vi.fn(async () => ({ mime: 'image/png', base64: btoa('png') })));
      render(<AvatarStoreContext value={store}><Avatar name="Ada Lovelace" email="ada@decoded" /></AvatarStoreContext>);
      await act(async () => {});
      await act(async () => {});
      const el = screen.getByTestId('avatar');
      expect(decode).toHaveBeenCalledOnce();
      expect(el.querySelector('img')).not.toHaveAttribute('data-loading');
      expect(el).toHaveTextContent('');
    } finally {
      proto.decode = had;
    }
  });

  it('two surfaces at different sizes share one entry and one request', async () => {
    const fetch = vi.fn(async () => ({ mime: 'image/png', base64: btoa('png') }));
    const store = createAvatarStore(fetch);
    render(
      <AvatarStoreContext value={store}>
        <Avatar name="Ada Lovelace" email="Ada@Shared" size={16} />
        <Avatar name="Ada Lovelace" email="ada@shared" size={28} />
      </AvatarStoreContext>,
    );
    await act(async () => {});
    expect(fetch).toHaveBeenCalledExactlyOnceWith('ada@shared', undefined, 'Ada Lovelace');
    const [a, b] = screen.getAllByTestId('avatar').map((el) => el.querySelector('img')!);
    expect(a.getAttribute('src')).toBe(b.getAttribute('src'));
    expect([a.getAttribute('width'), b.getAttribute('width')]).toEqual(['16', '28']);
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
