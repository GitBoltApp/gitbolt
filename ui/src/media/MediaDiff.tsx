import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatBytes } from '../diff/format';
import { videoFormat } from '../markdown/videos';
import { ArrowGlyph } from '../ui/ArrowGlyph';
import { HoverTooltip } from '../ui/HoverTooltip';
import { fontName, type FontName } from './fontName';
import type { MediaSource } from './sources';
import '../image/image.css';
import './media.css';

/** A codec an MP4 names, as `canPlayType` asks for it: the container alone says nothing (stock
 * Chromium demuxes MP4 but has no H.264 or HEVC decoder). */
const CODEC_TYPE: Record<string, string> = { 'H.264': 'avc1.42E01E', HEVC: 'hvc1.1.6.L93.B0', AV1: 'av01.0.05M.08', VP9: 'vp09.00.10.08' };

/** Whether the webview says it can play this type (`canPlayType` isn't ""): no means certainly not;
 * a "maybe" that fails shows as an `error` on the element. */
export function canPlay(kind: 'audio' | 'video', mime: string, codec: string | null): boolean {
  const codecs = codec ? CODEC_TYPE[codec] : undefined;
  return document.createElement(kind).canPlayType(codecs ? `${mime}; codecs="${codecs}"` : mime) !== '';
}

const PANGRAM = 'The quick brown fox jumps over the lazy dog';
const SAMPLE_SIZES = [12, 18, 24, 36, 48];
/** Basic Latin's printable characters, U+0021–U+007E. */
const GLYPHS = Array.from({ length: 0x7e - 0x20 }, (_, i) => String.fromCharCode(0x21 + i));

type Single = 'added' | 'deleted' | null;
const NO_BYTES = new Uint8Array();

/** An audio or video side: the native player (never autoplayed), or, for a format the webview
 * can't play, a note with Open in and the way to the hex view. */
function PlayerPane({ side, label, openIn, onShowHex }: { side: MediaSource; label: string | null; openIn?: ReactNode; onShowHex?: () => void }) {
  const kind = side.kind === 'audio' ? 'audio' : 'video';
  const codec = side.codec ?? null;
  const supported = useMemo(() => canPlay(kind, side.mime, codec), [kind, side.mime, codec]);
  const [failed, setFailed] = useState(false);
  const playable = !failed && supported;
  const what = kind === 'audio' ? 'audio file' : 'video';
  return (
    <div className={`media-pane media-${kind}-pane`} data-testid="media-pane">
      {label && <span className="media-label">{label}</span>}
      {playable ? (
        kind === 'audio'
          ? <audio className="media-audio" src={side.url} controls preload="metadata" aria-label={label ? `${label} audio` : 'Audio'} onError={() => setFailed(true)} />
          : <video className="media-video" src={side.url} controls preload="metadata" playsInline aria-label={label ? `${label} video` : 'Video'} onError={() => setFailed(true)} />
      ) : (
        <div className="media-unplayable" role="note">
          <span>{`This ${what}'s format (${videoFormat(side.mime, codec)}) can't play here`}</span>
          <span className="media-actions">
            {openIn}
            {onShowHex && <button type="button" className="text-button" onClick={onShowHex}>Show hex</button>}
          </span>
        </div>
      )}
    </div>
  );
}

let faces = 0;
type FaceState = { status: 'loading' } | { status: 'ready'; family: string } | { status: 'failed' };

/** The bytes as a FontFace (from the buffer: no URL, so no `font-src` source), in the document's
 * fonts while shown; and the font's own name, read from its `name` table. */
function useFontFace(bytes: Uint8Array<ArrayBuffer>) {
  const [face, setFace] = useState<FaceState>({ status: 'loading' });
  const [name, setName] = useState<FontName | null>(null);
  useEffect(() => {
    let live = true;
    setFace({ status: 'loading' });
    setName(null);
    void fontName(bytes).then((n) => { if (live) setName(n); }, () => {});
    if (typeof FontFace === 'undefined') {
      setFace({ status: 'failed' });
      return () => { live = false; };
    }
    const family = `gitbolt-font-preview-${++faces}`;
    let font: FontFace | null = null;
    try {
      font = new FontFace(family, bytes);
    } catch {
      setFace({ status: 'failed' });
    }
    font?.load().then((loaded) => {
      if (!live) return;
      document.fonts.add(loaded);
      setFace({ status: 'ready', family });
    }, () => { if (live) setFace({ status: 'failed' }); });
    return () => {
      live = false;
      if (font) document.fonts.delete(font);
    };
  }, [bytes]);
  return { face, name };
}

/** A font side: its name and style, a pangram at a few sizes, and Basic Latin's glyphs. */
function FontPane({ bytes, label }: { bytes: Uint8Array<ArrayBuffer>; label: string | null }) {
  const { face, name } = useFontFace(bytes);
  return (
    <div className="media-pane media-font-pane" data-testid="media-pane">
      {label && <span className="media-label">{label}</span>}
      {/* Its line is kept while the name is read, so the samples don't move when it arrives. */}
      <div className="font-name" data-testid="font-name">{name ? [name.family, name.style].filter(Boolean).join(' · ') : ' '}</div>
      {face.status === 'failed' && <div className="media-unplayable" role="note">This font couldn&apos;t be loaded</div>}
      {face.status === 'loading' && <div className="media-loading" aria-busy="true">Loading…</div>}
      {face.status === 'ready' && (
        <div className="font-sample" style={{ fontFamily: `"${face.family}"` }}>
          {SAMPLE_SIZES.map((px) => (
            <div key={px} className="font-line">
              <span className="font-size">{px}</span>
              <span style={{ fontSize: px }}>{PANGRAM}</span>
            </div>
          ))}
          <div className="font-glyphs" data-testid="font-glyphs">
            {GLYPHS.map((g) => <span key={g}>{g}</span>)}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Audio, video and fonts (ui/src/media), laid out as the image diff is: both sides side by side,
 * labelled, with their sizes in the toolbar; an added or deleted file (`single`), or File View's
 * one revision, shows only its side. `source` (the hex view) shows instead while its toggle is on.
 * `openIn`: the file's Open in control, offered where a format can't play: on the new side (or the
 * one side there is), the version it opens.
 */
export function MediaDiff({ old, new: neu, single = null, source, onSourceChange, openIn }: { old: MediaSource | null; new: MediaSource | null; single?: Single; source?: ReactNode; onSourceChange?: (on: boolean) => void; openIn?: ReactNode }) {
  const both = old !== null && neu !== null;
  const [showSource, setSource] = useState(false);
  const setShowSource = (on: boolean) => {
    setSource(on);
    onSourceChange?.(on);
  };
  // Gone (another file, File View): the hex view is off, so the panel's text tools go too, as for
  // an image's (H26).
  const reportSource = useRef(onSourceChange);
  reportSource.current = onSourceChange;
  const sourceNow = useRef(showSource);
  sourceNow.current = showSource;
  useEffect(() => {
    if (sourceNow.current) reportSource.current?.(true);
    return () => reportSource.current?.(false);
  }, []);
  const sizes = both
    ? <>{formatBytes(old.size)} <ArrowGlyph /> {formatBytes(neu.size)}</>
    : <>{formatBytes((old ?? neu)?.size)}{single && ` (${single})`}</>;
  const metaText = both ? `${formatBytes(old.size)} → ${formatBytes(neu.size)}` : `${formatBytes((old ?? neu)?.size)}${single ? ` (${single})` : ''}`;
  const pane = (side: MediaSource, label: string | null) => side.kind === 'font'
    ? <FontPane key={side.url} bytes={side.bytes ?? NO_BYTES} label={label} />
    : <PlayerPane key={side.url} side={side} label={label} openIn={side === neu || !both ? openIn : undefined} onShowHex={source ? () => setShowSource(true) : undefined} />;
  return (
    <div className="media-diff">
      <div className="image-toolbar" role="toolbar" aria-label="Media options">
        {source && <button type="button" className="toggle" aria-pressed={showSource} onClick={() => setShowSource(!showSource)}>Hex</button>}
        <HoverTooltip content={metaText}>
          <span className="dim image-meta" data-testid="media-meta">{sizes}</span>
        </HoverTooltip>
      </div>
      {showSource && source ? (
        <div className="image-source">{source}</div>
      ) : (
        <div className="media-stage">
          {old && pane(old, both ? 'Old' : null)}
          {both && <div className="side-divider" aria-hidden="true" />}
          {neu && pane(neu, both ? 'New' : null)}
        </div>
      )}
    </div>
  );
}
