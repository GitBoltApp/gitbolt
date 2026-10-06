import { useEffect, useState } from 'react';
import type { BlobPayload } from '../api/gen/BlobPayload';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import { svgIntrinsicSize } from './svgSize';

export interface ImageSource { url: string; size: number; /** An SVG's intrinsic size from its root, when it has one: a decoder reports 150×150 for a viewBox-only SVG. */ intrinsic?: { w: number; h: number } | null }

export const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
};

/** A side's bytes as a Blob: base64 for raster images, text for SVG. */
export function blobFor(b: BlobPayload | null, mime: string): Blob | null {
  if (!b) return null;
  if (b.base64 !== null) {
    const bin = atob(b.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  if (b.text !== null) return new Blob([b.text], { type: mime });
  return null;
}

const mimeOf = (path: string) => IMAGE_MIME[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';

/** Object URLs for both sides, revoked when the contents change or the view unmounts. `oldPath`:
 * a rename's source, whose type the old side has (an image format change, shot.png → shot.svg). */
export function useImageSources(c: DiffContentsPayload, path: string, oldPath: string | null = null) {
  const [sources, setSources] = useState<{ old: ImageSource | null; new: ImageSource | null } | null>(null);
  useEffect(() => {
    const make = (b: BlobPayload | null, mime: string): ImageSource | null => {
      const blob = blobFor(b, mime);
      return blob && b ? { url: URL.createObjectURL(blob), size: b.size, intrinsic: mime === IMAGE_MIME.svg && b.text !== null ? svgIntrinsicSize(b.text) : null } : null;
    };
    const next = { old: make(c.old, mimeOf(oldPath ?? path)), new: make(c.new, mimeOf(path)) };
    setSources(next);
    return () => {
      for (const s of [next.old, next.new]) if (s) URL.revokeObjectURL(s.url);
    };
  }, [c, path, oldPath]);
  return sources;
}
