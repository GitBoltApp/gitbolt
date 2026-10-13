// Audio, video and fonts in the diff and File View: played or previewed from their bytes instead
// of a hex dump. No React here: hexContents.ts (in the startup chunk) asks `showsMedia`.
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';

export type MediaKind = 'audio' | 'video' | 'font';

/** By extension; the core's `MEDIA_EXTENSIONS` (blob.rs) is the same list. `.webm` is a video:
 * a `<video>` plays a sound-only WebM too. */
const MEDIA: Record<string, { kind: MediaKind; mime: string }> = {
  mp3: { kind: 'audio', mime: 'audio/mpeg' },
  wav: { kind: 'audio', mime: 'audio/wav' },
  flac: { kind: 'audio', mime: 'audio/flac' },
  ogg: { kind: 'audio', mime: 'audio/ogg' },
  oga: { kind: 'audio', mime: 'audio/ogg' },
  opus: { kind: 'audio', mime: 'audio/ogg; codecs=opus' },
  m4a: { kind: 'audio', mime: 'audio/mp4' },
  aac: { kind: 'audio', mime: 'audio/aac' },
  weba: { kind: 'audio', mime: 'audio/webm' },
  webm: { kind: 'video', mime: 'video/webm' },
  ogv: { kind: 'video', mime: 'video/ogg' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  m4v: { kind: 'video', mime: 'video/mp4' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  ttf: { kind: 'font', mime: 'font/ttf' },
  otf: { kind: 'font', mime: 'font/otf' },
  woff: { kind: 'font', mime: 'font/woff' },
  woff2: { kind: 'font', mime: 'font/woff2' },
};

const extOf = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
};

export const mediaOf = (path: string): { kind: MediaKind; mime: string } | null => MEDIA[extOf(path)] ?? null;


/** The core sent the bytes to play or preview: a media path (`media`), loaded, and each side
 * there is binary with its bytes. A text side (a Git LFS pointer) leaves the diff to the text or
 * hex view. */
export const showsMedia = (c: DiffContentsPayload): boolean =>
  !!c.media && !c.tooLarge && !!(c.old || c.new) && [c.old, c.new].every((s) => !s || (s.binary && s.base64 !== null));

/** The most the core loads to play (its `MAX_FORCED_BYTES`, diff.rs): a side past it shows as a
 * capped hex dump. */
export const MEDIA_PLAY_CEILING = 64 * 1024 * 1024;

/** Media too large to play, so shown as hex. */
export const tooLargeToPlay = (c: DiffContentsPayload): boolean => !!c.media && [c.old, c.new].some((s) => !!s && s.size > MEDIA_PLAY_CEILING);
