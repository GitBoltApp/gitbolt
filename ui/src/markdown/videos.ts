import { api } from '../api/client';
import type { ForgeImage } from '../api/gen/ForgeImage';

/** The extensions GitLab renders an image link to as a video (`![clip](/uploads/…/clip.webm)`). */
const VIDEO_PATH = /\.(mp4|m4v|mov|webm|ogv)$/i;

export const isVideoSrc = (src: string): boolean => VIDEO_PATH.test(src.trim().split(/[?#]/)[0] ?? '');

const FOURCC: [string, string][] = [['avc1', 'H.264'], ['avc3', 'H.264'], ['hvc1', 'HEVC'], ['hev1', 'HEVC'], ['av01', 'AV1'], ['vp09', 'VP9']];
/** How much of each end of the file is searched: an MP4's `moov` (its codecs) is at the start or the end. */
const SCAN = 4 * 1024 * 1024;

/** The video codec an MP4 or QuickTime file names (its sample entry's four-character code), or null. */
export function videoCodec(bytes: Uint8Array): string | null {
  const find = (from: number, to: number) => {
    for (let i = Math.max(0, from); i + 4 <= to; i++) {
      for (const [code, name] of FOURCC) {
        if (bytes[i] === code.charCodeAt(0) && bytes[i + 1] === code.charCodeAt(1) && bytes[i + 2] === code.charCodeAt(2) && bytes[i + 3] === code.charCodeAt(3)) return name;
      }
    }
    return null;
  };
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(4, 8)) !== 'ftyp') return null;
  return find(0, Math.min(bytes.length, SCAN)) ?? (bytes.length > SCAN ? find(Math.max(SCAN, bytes.length - SCAN), bytes.length) : null);
}

const CONTAINER: Record<string, string> = { 'video/mp4': 'MP4', 'video/quicktime': 'QuickTime', 'video/webm': 'WebM', 'video/ogg': 'Ogg' };
/** What "This video's format (…) can't play here" names: the codec, else the container. */
export const videoFormat = (mime: string, codec: string | null): string => codec ?? CONTAINER[mime] ?? mime;

export type LoadedVideo = { kind: 'found'; url: string; mime: string; codec: string | null } | Exclude<ForgeImage, { kind: 'found' }>;

/** A few videos' object URLs for the session (each up to 100 MB): the oldest is let go. */
const KEPT = 6;
const loaded = new Map<string, Promise<LoadedVideo>>();

function toBlob(mime: string, base64: string): { blob: Blob; codec: string | null } {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { blob: new Blob([bytes], { type: mime }), codec: videoCodec(bytes) };
}

/** One core request per video for the session (an `expired` answer, or a failure, isn't kept). */
export function loadForgeVideo(repo: number, url: string, userAllowed: boolean): Promise<LoadedVideo> {
  const key = `${repo}\0${userAllowed ? 1 : 0}\0${url}`;
  let p = loaded.get(key);
  if (!p) {
    p = api.forgeVideo(repo, url, userAllowed).then((r): LoadedVideo => {
      if (r.kind !== 'found') {
        if (r.kind === 'expired') loaded.delete(key);
        return r;
      }
      const { blob, codec } = toBlob(r.mime, r.base64);
      return { kind: 'found', url: URL.createObjectURL(blob), mime: r.mime, codec };
    });
    loaded.set(key, p);
    p.catch(() => loaded.delete(key));
    if (loaded.size > KEPT) {
      const [oldest, gone] = loaded.entries().next().value!;
      loaded.delete(oldest);
      void gone.then((v) => { if (v.kind === 'found') URL.revokeObjectURL(v.url); }, () => {});
    }
  }
  return p;
}

/** Tests. */
export function resetVideoSession(): void {
  loaded.clear();
}
