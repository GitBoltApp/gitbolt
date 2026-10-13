import { useEffect, useState } from 'react';
import type { BlobPayload } from '../api/gen/BlobPayload';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import { base64Bytes } from '../image/sources';
import { videoCodec } from '../markdown/videos';
import { mediaOf, type MediaKind } from './kind';

/** One side to play or preview: an object URL of its bytes. A font keeps the bytes themselves
 * (its FontFace is built from them); a video, the codec its MP4 names. */
export interface MediaSource { url: string; size: number; kind: MediaKind; mime: string; bytes?: Uint8Array<ArrayBuffer>; codec?: string | null }

/** Object URLs for both sides, revoked when the contents change or the view unmounts. The old
 * side has its own path's type on a rename (song.wav → song.mp3), else the new one's. */
export function useMediaSources(c: DiffContentsPayload, path: string, oldPath: string | null = null) {
  // Keyed by what they were built for: the next file's first render shows none, not the last file's.
  const [built, setBuilt] = useState<{ c: DiffContentsPayload; path: string; oldPath: string | null; sources: { old: MediaSource | null; new: MediaSource | null } } | null>(null);
  useEffect(() => {
    const type = mediaOf(path);
    const oldType = (oldPath && mediaOf(oldPath)) || type;
    const make = (b: BlobPayload | null, t: typeof type): MediaSource | null => {
      if (!b || b.base64 === null || !t) return null;
      const bytes = base64Bytes(b.base64);
      const side: MediaSource = { url: URL.createObjectURL(new Blob([bytes], { type: t.mime })), size: b.size, kind: t.kind, mime: t.mime };
      if (t.kind === 'font') side.bytes = bytes;
      if (t.kind === 'video') side.codec = videoCodec(bytes);
      return side;
    };
    const next = { old: make(c.old, oldType), new: make(c.new, type) };
    setBuilt({ c, path, oldPath, sources: next });
    return () => {
      for (const s of [next.old, next.new]) if (s) URL.revokeObjectURL(s.url);
    };
  }, [c, path, oldPath]);
  return built && built.c === c && built.path === path && built.oldPath === oldPath ? built.sources : null;
}
