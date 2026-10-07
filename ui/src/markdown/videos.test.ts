import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ forgeVideo: vi.fn() }));
vi.mock('../api/client', () => ({ api }));
const { isVideoSrc, loadForgeVideo, resetVideoSession, videoCodec, videoFormat } = await import('./videos');

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

beforeEach(() => {
  vi.clearAllMocks();
  resetVideoSession();
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:video-${++n}`);
  URL.revokeObjectURL = vi.fn();
});

describe('Markdown videos', () => {
  it('an image link to a video file is a video, as GitLab renders it', () => {
    for (const v of ['/uploads/0123abcd/clip.webm', 'https://gitlab.example.com/a/screen.MP4?x=1', 'a.mov#t=2', 'b.m4v', 'c.ogv']) expect(isVideoSrc(v), v).toBe(true);
    for (const v of ['/uploads/0123abcd/shot.png', 'clip.webm.png', 'https://example.org/mp4', '']) expect(isVideoSrc(v), v).toBe(false);
  });

  it('names the codec an MP4 carries, else its container', () => {
    expect(videoCodec(bytes('\0\0\0 ftypisom....moov....avc1....'))).toBe('H.264');
    expect(videoCodec(bytes('\0\0\0 ftypisom....hvc1'))).toBe('HEVC');
    expect(videoCodec(bytes('\0\0\0 ftypisom....av01'))).toBe('AV1');
    expect(videoCodec(bytes('\x1aE\xdf\xa3webm'))).toBeNull();
    expect(videoFormat('video/mp4', 'H.264')).toBe('H.264');
    expect(videoFormat('video/quicktime', null)).toBe('QuickTime');
    expect(videoFormat('video/webm', null)).toBe('WebM');
  });

  it('loads once per address through the core, as an object URL, and answers why it did not', async () => {
    api.forgeVideo.mockResolvedValueOnce({ kind: 'found', mime: 'video/mp4', base64: btoa('\0\0\0 ftypisomavc1') });
    const a = await loadForgeVideo(4, 'https://gitlab.example.com/-/project/42/uploads/0123abcd/screen.mp4', false);
    expect(a).toEqual({ kind: 'found', url: 'blob:video-1', mime: 'video/mp4', codec: 'H.264' });
    expect(await loadForgeVideo(4, 'https://gitlab.example.com/-/project/42/uploads/0123abcd/screen.mp4', false)).toBe(a);
    expect(api.forgeVideo).toHaveBeenCalledOnce();
    api.forgeVideo.mockResolvedValueOnce({ kind: 'missing', reason: 'larger than 100 MB' });
    expect(await loadForgeVideo(4, 'https://gitlab.example.com/-/project/42/uploads/0123abcd/big.mp4', false)).toEqual({ kind: 'missing', reason: 'larger than 100 MB' });
  });
});
