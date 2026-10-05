import { act, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForgeAvatarStoreContext, createAvatarStore } from '../avatars/avatarStore';
import { patchForge, useForge } from '../forge/mrStore';
import { RemoteIcon } from './brands';

const ALICE = 'https://gitlab.example.com/uploads/-/system/user/avatar/7/alice.png';

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:alice');
  URL.revokeObjectURL = vi.fn();
});

describe("RemoteIcon: a user's fork shows its owner's picture", () => {
  let fetch: ReturnType<typeof vi.fn<(url: string) => Promise<{ mime: string; base64: string } | null>>>;
  let store: ReturnType<typeof createAvatarStore>;
  beforeEach(() => {
    useForge.setState({ byTab: {} });
    patchForge('t', { ownerAvatars: { alice: ALICE } });
    fetch = vi.fn(async (url: string) => (url === ALICE ? { mime: 'image/png', base64: btoa('png') } : null));
    store = createAvatarStore(fetch, { keyOf: (u) => u.trim() });
  });
  const show = (remote: string, tabId: string | null = 't') =>
    render(<ForgeAvatarStoreContext value={store}><RemoteIcon kind="gitlab" host="gitlab.example.com" remote={remote} size={12} tabId={tabId ?? undefined} /></ForgeAvatarStoreContext>);

  it('is the forge mark until the picture loads, then the picture, round and the same size', async () => {
    show('alice');
    expect(screen.getByLabelText('remote alice').tagName.toLowerCase()).toBe('svg');
    await act(async () => {});
    const img = screen.getByLabelText('remote alice');
    expect(img.tagName.toLowerCase()).toBe('img');
    expect([img.getAttribute('src'), img.getAttribute('width'), img.getAttribute('height'), img.style.borderRadius]).toEqual(['blob:alice', '12', '12', '50%']);
    expect(fetch).toHaveBeenCalledWith(ALICE);
  });

  it('stays the mark for the target, an organization or a failed picture, and outside a tab', async () => {
    patchForge('t', { ownerAvatars: { alice: ALICE, bob: 'https://gitlab.example.com/uploads/missing.png' } });
    for (const [remote, tabId] of [['origin', 't'], ['bob', 't'], ['alice', null]] as const) {
      const { unmount } = show(remote, tabId);
      await act(async () => {});
      expect(screen.getByLabelText(`remote ${remote}`).tagName.toLowerCase()).toBe('svg');
      unmount();
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://gitlab.example.com/uploads/missing.png');
  });
});
