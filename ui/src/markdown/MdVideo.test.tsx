import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ forgeImage: vi.fn(), forgeVideo: vi.fn(), forgeOpenVideo: vi.fn(async () => null), openUrl: vi.fn(async () => {}) }));
vi.mock('../api/client', () => ({ api, errorMessage: (e: { message?: string }) => e?.message ?? String(e) }));
vi.mock('../forge/poll', () => ({ refreshMr: vi.fn(async () => {}) }));

const { MdImage } = await import('./MdImage');
const { resetVideoSession } = await import('./videos');
const { resetImageSession } = await import('./images');
const { patchForge, useForge } = await import('../forge/mrStore');
const { projectOf } = await import('../forge/testMrs');
const { useRuntime } = await import('../app/runtime');
const { useLightbox } = await import('../lightbox/store');

const forge = { kind: 'forge', tabId: 't' } as const;
const UPLOADS = 'https://gitlab.example.com/group/project/uploads/0123abcd0123abcd';
const MP4 = { kind: 'found', mime: 'video/mp4', base64: btoa('\0\0\0 ftypisom....avc1') } as const;
const WEBM = { kind: 'found', mime: 'video/webm', base64: btoa('\x1aE\xdf\xa3webm') } as const;

beforeEach(() => {
  vi.clearAllMocks();
  resetVideoSession();
  resetImageSession();
  useLightbox.setState({ item: null });
  useForge.setState({ byTab: {} });
  patchForge('t', { kind: 'gitlab', remote: 'origin', project: projectOf(), openMr: 12 });
  useRuntime.setState({ tabs: { t: { repo: { id: 4 } } as never } });
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:video-${++n}`);
  URL.revokeObjectURL = vi.fn();
});

const video = (c: HTMLElement) => c.querySelector('video')!;

describe('a video in rendered Markdown (GitLab renders ![clip](….webm) as one)', () => {
  it('plays inline from the URL the core loaded: controls, metadata only, never autoplay; sized by its attributes', async () => {
    api.forgeVideo.mockResolvedValue(WEBM);
    const { container } = render(<MdImage ctx={forge} src="/uploads/0123abcd0123abcd/clip.webm" alt="clip" width={320} height={240} />);
    expect(container.querySelector('.md-video-box')).toHaveTextContent('clip.webm');
    await waitFor(() => expect(video(container)).toHaveAttribute('src', 'blob:video-1'));
    const v = video(container);
    expect(v).toHaveAttribute('controls');
    expect(v).toHaveAttribute('preload', 'metadata');
    expect(v).not.toHaveAttribute('autoplay');
    expect(v).toHaveAttribute('width', '320');
    expect(api.forgeVideo).toHaveBeenCalledWith(4, `${UPLOADS}/clip.webm`, false);
    expect(api.forgeImage).not.toHaveBeenCalled();
  });

  it('its expand button opens the viewer with the same URL, and pauses it here', async () => {
    api.forgeVideo.mockResolvedValue(WEBM);
    const { container } = render(<MdImage ctx={forge} src="/uploads/0123abcd0123abcd/clip.webm" alt="clip" />);
    await waitFor(() => expect(video(container)).toHaveAttribute('src'));
    const pause = vi.spyOn(video(container), 'pause').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'View full size' }));
    expect(useLightbox.getState().item).toEqual({ kind: 'video', url: 'blob:video-1', alt: 'clip', browserUrl: `${UPLOADS}/clip.webm` });
    expect(pause).toHaveBeenCalled();
  });

  it("a format the webview can't play says which, with Open in browser and Open with default app", async () => {
    api.forgeVideo.mockResolvedValue(MP4);
    const { container } = render(<MdImage ctx={forge} src="/uploads/0123abcd0123abcd/screen.mp4" alt="screen" />);
    await waitFor(() => expect(video(container)).toHaveAttribute('src'));
    Object.defineProperty(video(container), 'error', { configurable: true, value: { code: 4 } });
    fireEvent.error(video(container));
    expect(await screen.findByText("This video's format (H.264) can't play here")).toBeInTheDocument();
    expect(container.querySelector('video')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }));
    expect(api.openUrl).toHaveBeenCalledWith(`${UPLOADS}/screen.mp4`);
    fireEvent.click(screen.getByRole('button', { name: 'Open with default app' }));
    expect(api.forgeOpenVideo).toHaveBeenCalledWith(4, `${UPLOADS}/screen.mp4`, false);
  });

  it('one too large (or missing) says why, like a broken image', async () => {
    api.forgeVideo.mockResolvedValue({ kind: 'missing', reason: 'larger than 100 MB' });
    const { container } = render(<MdImage ctx={forge} src="/uploads/0123abcd0123abcd/big.mp4" alt="big" />);
    await waitFor(() => expect(container.querySelector('.md-img-broken')).not.toBeNull());
    expect(container.querySelector('.md-img-broken')!.getAttribute('title')).toBe("Couldn't load: larger than 100 MB");
  });

  it('from another host, it asks first', async () => {
    api.forgeVideo.mockResolvedValue(WEBM);
    const { container } = render(<MdImage ctx={forge} src="https://videos.example.org/a.webm" alt="ext" />);
    expect(api.forgeVideo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Load video from videos.example.org' }));
    await waitFor(() => expect(video(container)).toHaveAttribute('src'));
    expect(api.forgeVideo).toHaveBeenCalledWith(4, 'https://videos.example.org/a.webm', true);
  });
});
