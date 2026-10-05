import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ forgeImage: vi.fn() }));
vi.mock('../api/client', () => ({ api, errorMessage: String }));
const poll = vi.hoisted(() => ({ refreshMr: vi.fn(async () => {}) }));
vi.mock('../forge/poll', () => poll);

const { MdImage, registerRepoImageLoader } = await import('./MdImage');
const { resetImageSession, refreshSignedImages } = await import('./images');
const { patchForge, useForge } = await import('../forge/mrStore');
const { projectOf } = await import('../forge/testMrs');
const { useRuntime } = await import('../app/runtime');

const forge = { kind: 'forge', tabId: 't' } as const;
const PNG = { kind: 'found', mime: 'image/png', base64: 'iVBORw==' } as const;

beforeEach(() => {
  vi.clearAllMocks();
  resetImageSession();
  useForge.setState({ byTab: {} });
  patchForge('t', { kind: 'gitlab', remote: 'origin', project: projectOf(), openMr: 12 });
  useRuntime.setState({ tabs: { t: { repo: { id: 4 } } as never } });
});

describe('MdImage (spec #5 §4.2)', () => {
  it('loads a forge image through the core, reserving its box meanwhile', async () => {
    let answer: (v: unknown) => void = () => {};
    api.forgeImage.mockReturnValue(new Promise((r) => { answer = r; }));
    render(<MdImage ctx={forge} src="/uploads/0123abcd0123abcd/a.png" alt="shot" width={200} height={100} />);
    const box = screen.getByRole('img', { name: 'shot' });
    expect(box.style.width).toBe('200px');
    answer(PNG);
    await waitFor(() => expect(screen.getByRole('img', { name: 'shot' })).toHaveAttribute('src', 'data:image/png;base64,iVBORw=='));
    expect(api.forgeImage).toHaveBeenCalledWith(4, 'https://gitlab.example.com/group/project/uploads/0123abcd0123abcd/a.png', false);
  });

  it('asks before loading from another host, then keeps it loaded for the session', async () => {
    api.forgeImage.mockResolvedValue(PNG);
    const { unmount } = render(<MdImage ctx={forge} src="https://example.org/a.png" alt="ext" />);
    expect(api.forgeImage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Load image from example.org' }));
    await waitFor(() => expect(screen.getByRole('img', { name: 'ext' })).toHaveAttribute('src', 'data:image/png;base64,iVBORw=='));
    expect(api.forgeImage).toHaveBeenCalledWith(4, 'https://example.org/a.png', true);
    unmount();
    render(<MdImage ctx={forge} src="https://example.org/a.png" alt="ext" />);
    await waitFor(() => expect(screen.getByRole('img', { name: 'ext' })).toHaveAttribute('src'));
    expect(screen.queryByRole('button', { name: /Load image/ })).toBeNull();
  });

  it('a forge image that redirected elsewhere asks too', async () => {
    api.forgeImage.mockResolvedValueOnce({ kind: 'ask', host: 'objects.example.net' });
    render(<MdImage ctx={forge} src="https://gitlab.example.com/a.png" alt="r" />);
    expect(await screen.findByRole('button', { name: 'Load image from objects.example.net' })).toBeInTheDocument();
  });

  it('a protocol-relative src never loads nor asks', async () => {
    const { container } = render(<MdImage ctx={forge} src="//cdn.example.org/a.png" alt="pr" />);
    await waitFor(() => expect(container.querySelector('.md-img-broken')).not.toBeNull());
    expect(screen.queryByRole('button', { name: /Load image/ })).toBeNull();
    expect(api.forgeImage).not.toHaveBeenCalled();
  });

  it('a missing image shows its alt text and a broken-image icon', async () => {
    api.forgeImage.mockResolvedValue({ kind: 'missing' });
    const { container } = render(<MdImage ctx={forge} src="/uploads/0123abcd0123abcd/gone.png" alt="gone" />);
    await waitFor(() => expect(container.querySelector('.md-img-broken')).not.toBeNull());
    expect(container.querySelector('.md-img-broken svg')).not.toBeNull();
    expect(container).toHaveTextContent('gone');
  });

  it('an expired signed image asks for the bodies again, at most once a minute', async () => {
    api.forgeImage.mockResolvedValue({ kind: 'expired' });
    render(<MdImage ctx={forge} src="https://gitlab.example.com/a.png" alt="e" />);
    await waitFor(() => expect(poll.refreshMr).toHaveBeenCalledWith('t', 12));
    refreshSignedImages(forge, Date.now() + 30_000);
    expect(poll.refreshMr).toHaveBeenCalledTimes(1);
    refreshSignedImages(forge, Date.now() + 61_000);
    expect(poll.refreshMr).toHaveBeenCalledTimes(2);
  });

  it('a repo image goes to 5B’s loader in File View with a repo-root-relative path, else shows its alt text', async () => {
    const file = { kind: 'file', tabId: 't', commit: 'c0ffee1', path: 'docs/README.md' } as const;
    const { container, unmount } = render(<MdImage ctx={file} src="img/a.png" alt="local" />);
    await waitFor(() => expect(container.querySelector('.md-img-broken')).not.toBeNull());
    unmount();
    const off = registerRepoImageLoader(async (_ctx, path, commit) => `blob:${commit}/${path}`);
    render(<MdImage ctx={file} src="img/a.png" alt="local" />);
    await waitFor(() => expect(screen.getByRole('img', { name: 'local' })).toHaveAttribute('src', 'blob:c0ffee1/docs/img/a.png'));
    off();
  });

  it('releases a repo image’s URL when it unmounts, or when it arrives after the unmount', async () => {
    const file = { kind: 'file', tabId: 't', commit: 'c0ffee1', path: 'README.md' } as const;
    const release = vi.fn();
    let answer: (u: string) => void = () => {};
    const off = registerRepoImageLoader(async (_ctx, path) => (path === 'slow.png' ? new Promise<string>((r) => { answer = r; }) : `blob:${path}`), release);
    const { unmount } = render(<><MdImage ctx={file} src="a.png" alt="a" /><MdImage ctx={file} src="slow.png" alt="slow" /></>);
    await waitFor(() => expect(screen.getByRole('img', { name: 'a' })).toHaveAttribute('src', 'blob:a.png'));
    expect(release).not.toHaveBeenCalled();
    unmount();
    expect(release).toHaveBeenCalledWith('blob:a.png');
    answer('blob:slow.png');
    await waitFor(() => expect(release).toHaveBeenCalledWith('blob:slow.png'));
    off();
  });

  describe('GitHub’s signed attachment URLs, re-signed by a poll', () => {
    const signed = (jwt: string) => `https://private-user-images.githubusercontent.com/1/2-1b2c3d4e-0000-4000-8000-00000000abcd.png?jwt=${jwt}`;
    beforeEach(() => { patchForge('t', { kind: 'github', project: projectOf('octo-org/widget', 'github') }); });

    it('keep showing the image while the new URL loads, then swap without a loading box', async () => {
      api.forgeImage.mockResolvedValueOnce(PNG);
      const { container, rerender } = render(<MdImage ctx={forge} src={signed('a')} alt="shot" />);
      await waitFor(() => expect(screen.getByRole('img', { name: 'shot' })).toHaveAttribute('src', 'data:image/png;base64,iVBORw=='));
      let answer: (v: unknown) => void = () => {};
      api.forgeImage.mockReturnValueOnce(new Promise((r) => { answer = r; }));
      rerender(<MdImage ctx={forge} src={signed('b')} alt="shot" />);
      expect(api.forgeImage).toHaveBeenLastCalledWith(4, signed('b'), false);
      expect(container.querySelector('.md-img-loading')).toBeNull();
      expect(screen.getByRole('img', { name: 'shot' })).toHaveAttribute('src', 'data:image/png;base64,iVBORw==');
      answer({ kind: 'found', mime: 'image/png', base64: 'AAAA' });
      await waitFor(() => expect(screen.getByRole('img', { name: 'shot' })).toHaveAttribute('src', 'data:image/png;base64,AAAA'));
      expect(container.querySelector('.md-img-loading')).toBeNull();
    });

    it('keep the image when the new URL fails, and show it at once when the body remounts', async () => {
      api.forgeImage.mockResolvedValueOnce(PNG);
      const { container, rerender, unmount } = render(<MdImage ctx={forge} src={signed('a')} alt="shot" />);
      await waitFor(() => expect(screen.getByRole('img', { name: 'shot' })).toHaveAttribute('src', 'data:image/png;base64,iVBORw=='));
      let answer: (v: unknown) => void = () => {};
      api.forgeImage.mockReturnValueOnce(new Promise((r) => { answer = r; }));
      rerender(<MdImage ctx={forge} src={signed('b')} alt="shot" />);
      await act(async () => { answer({ kind: 'expired' }); });
      expect(container.querySelector('.md-img-broken')).toBeNull();
      expect(screen.getByRole('img', { name: 'shot' })).toHaveAttribute('src', 'data:image/png;base64,iVBORw==');
      unmount();
      api.forgeImage.mockReturnValueOnce(new Promise(() => {}));
      render(<MdImage ctx={forge} src={signed('c')} alt="shot" />);
      expect(screen.getByRole('img', { name: 'shot' })).toHaveAttribute('src', 'data:image/png;base64,iVBORw==');
    });
  });
});
