import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlobPayload } from '../api/gen/BlobPayload';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import { useMediaSources } from './sources';

const b64 = (s: string) => btoa(s);
const side = (bytes: string): BlobPayload => ({ size: bytes.length, binary: true, encoding: '', eol: 'none', text: null, base64: b64(bytes), hash: 'h' });
const contents = (old: BlobPayload | null, neu: BlobPayload | null): DiffContentsPayload => ({ old, new: neu, tooLarge: false, eolOnly: false, image: false, media: true });

const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
let urls = 0;
beforeEach(() => {
  urls = 0;
  URL.createObjectURL = vi.fn(() => `blob:m-${++urls}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  URL.createObjectURL = saved.create;
  URL.revokeObjectURL = saved.revoke;
});

describe('useMediaSources', () => {
  it('keeps the bytes for a font only, and reads a video codec when it builds the source', async () => {
    const f = contents(null, side('\0\x01\0\0font'));
    const font = renderHook(() => useMediaSources(f, 'a.ttf'));
    await waitFor(() => expect(font.result.current?.new?.bytes?.length).toBe(8));
    // One contents object per hook, as the loader's cache hands over: a new one is new sources.
    const v = contents(null, side('\0\0\0\x18ftypisom....avc1'));
    const video = renderHook(() => useMediaSources(v, 'clip.mp4'));
    await waitFor(() => expect(video.result.current?.new).toMatchObject({ kind: 'video', mime: 'video/mp4', codec: 'H.264' }));
    expect(video.result.current?.new?.bytes).toBeUndefined();
    const a = contents(side('\0ID3'), side('\0ID3!'));
    const audio = renderHook(() => useMediaSources(a, 'bell.mp3'));
    await waitFor(() => expect(audio.result.current?.old).toMatchObject({ kind: 'audio', size: 4 }));
    expect(audio.result.current?.old?.bytes).toBeUndefined();
    expect(audio.result.current?.old?.codec).toBeUndefined();
  });

  it("another file's render never shows the last file's sources", async () => {
    const [first, next] = [contents(null, side('\0one')), contents(null, side('\0two'))];
    const shown: (string | undefined)[] = [];
    const hook = renderHook(({ c }) => {
      const s = useMediaSources(c, 'bell.mp3');
      shown.push(s?.new?.url);
      return s;
    }, { initialProps: { c: first } });
    await waitFor(() => expect(hook.result.current?.new?.url).toBe('blob:m-1'));
    const from = shown.length;
    hook.rerender({ c: next });
    await waitFor(() => expect(hook.result.current?.new?.url).toBe('blob:m-2'));
    expect(shown.slice(from)).not.toContain('blob:m-1');
    expect(shown.slice(from)[0]).toBeUndefined();
  });
});
