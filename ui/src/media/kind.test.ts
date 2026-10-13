import { describe, expect, it } from 'vitest';
import type { BlobPayload } from '../api/gen/BlobPayload';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import { wantsHex } from '../diff/hexContents';
import { mediaOf, showsMedia } from './kind';

const side = (o: Partial<BlobPayload>): BlobPayload => ({ size: 4, binary: true, encoding: '', eol: 'none', text: null, base64: 'AAEC', hash: 'h', ...o });
const contents = (o: Partial<DiffContentsPayload>): DiffContentsPayload => ({ old: side({}), new: side({}), tooLarge: false, eolOnly: false, image: false, media: true, ...o });

describe('media kinds', () => {
  it('reads the kind and type from the extension, in any case', () => {
    expect(mediaOf('sounds/Bell.MP3')).toEqual({ kind: 'audio', mime: 'audio/mpeg' });
    for (const p of ['a.wav', 'a.flac', 'a.ogg', 'a.oga', 'a.opus', 'a.m4a', 'a.aac', 'a.weba']) expect(mediaOf(p)?.kind, p).toBe('audio');
    for (const p of ['a.webm', 'a.ogv', 'a.mp4', 'a.m4v', 'a.mov']) expect(mediaOf(p)?.kind, p).toBe('video');
    for (const p of ['a.ttf', 'a.otf', 'a.woff', 'a.woff2']) expect(mediaOf(p)?.kind, p).toBe('font');
    expect(mediaOf('clip.mov')?.mime).toBe('video/quicktime');
    for (const p of ['logo.png', 'notes.txt', 'mp3', 'dir.mp3/readme', 'Makefile']) expect(mediaOf(p), p).toBeNull();
  });

  it("shows media only with every side's bytes; a text side (an LFS pointer) leaves it to the hex or text view", () => {
    expect(showsMedia(contents({}))).toBe(true);
    expect(showsMedia(contents({ old: null }))).toBe(true);
    expect(showsMedia(contents({ media: undefined }))).toBe(false);
    expect(showsMedia(contents({ tooLarge: true }))).toBe(false);
    expect(showsMedia(contents({ old: null, new: null }))).toBe(false);
    expect(showsMedia(contents({ new: side({ binary: false, base64: null, text: 'version https://git-lfs.example/spec/v1\n' }) }))).toBe(false);
    // The hex dumps load with a binary's contents only when it isn't shown as media.
    expect(wantsHex(contents({}))).toBe(false);
    expect(wantsHex(contents({ media: false, old: side({ base64: null }), new: side({ base64: null }) }))).toBe(true);
  });
});
