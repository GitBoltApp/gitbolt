import { ImageOff, Maximize2, Play } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';
import { useRuntime } from '../app/runtime';
import { openLightbox } from '../lightbox/store';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useToast } from '../ui/toastStore';
import { openExternal } from './actions';
import { allowImage, imageAllowed, resolveImage } from './images';
import type { MdImageProps } from './types';
import { loadForgeVideo, videoFormat } from './videos';

type View =
  | { kind: 'loading' }
  | { kind: 'shown'; url: string; mime: string; codec: string | null }
  | { kind: 'ask'; host: string }
  | { kind: 'broken'; why: string }
  | { kind: 'unplayable'; format: string };

/** MEDIA_ERR_DECODE and MEDIA_ERR_SRC_NOT_SUPPORTED: the bytes are here, the webview can't play them. */
const CANT_PLAY = new Set([3, 4]);
/** The native controls' height along a video's bottom edge (a third of a small one). */
const CONTROLS_PX = 48;
const failed = (why: string): View => ({ kind: 'broken', why: `Couldn't load: ${why}` });

/** A video an image link names (GitLab renders `![clip](/uploads/…/clip.webm)` as one): fetched
 * through the core by an image's rules, played from an object URL with the native controls,
 * never autoplayed. A format the webview can't play (H.264 without the proprietary codecs) says
 * so, with Open in browser and Open with default app. */
export function MdVideo({ ctx, src, alt, width, height }: MdImageProps) {
  const ctxKey = ctx.kind === 'forge' ? ctx.tabId : `${ctx.tabId}\0${ctx.commit}\0${ctx.path}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the context's value
  const source = useMemo(() => resolveImage(ctx, src), [ctxKey, src]);
  const repo = useRuntime((s) => s.tabs[ctx.tabId]?.repo?.id);
  const remoteUrl = source.kind === 'remote' || source.kind === 'forge' ? source.url : null;
  const [consented, setConsented] = useState<string | null>(null);
  const consent = remoteUrl !== null && (consented === remoteUrl || imageAllowed(remoteUrl));
  const [view, setView] = useState<View>({ kind: 'loading' });
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let live = true;
    const set = (v: View) => { if (live) setView(v); };
    if (source.kind === 'remote' && !consent) set({ kind: 'ask', host: source.host });
    else if (source.kind !== 'remote' && source.kind !== 'forge') set({ kind: 'broken', why: "Not loaded: GitBolt plays videos from the forge only" });
    else if (repo === undefined) set(failed('no repository is open'));
    else {
      set({ kind: 'loading' });
      loadForgeVideo(repo, source.url, consent).then((r) => {
        if (r.kind === 'found') set({ kind: 'shown', url: r.url, mime: r.mime, codec: r.codec });
        else if (r.kind === 'ask') set({ kind: 'ask', host: r.host });
        else set(failed(r.kind === 'expired' ? 'its link expired' : r.reason));
      }, (e: unknown) => set(failed(errorMessage(e))));
    }
    return () => { live = false; };
  }, [source, repo, consent]);

  const fileName = (src.split(/[?#]/)[0] ?? '').split('/').pop() || 'Video';
  const name = alt || fileName;
  const box = { width: width ? `${width}px` : undefined, aspectRatio: width && height ? `${width} / ${height}` : undefined };

  if (view.kind === 'shown') {
    const expand = () => {
      videoRef.current?.pause();
      openLightbox({ kind: 'video', url: view.url, alt: name, browserUrl: remoteUrl });
    };
    return (
      <span className="md-video" style={{ width: box.width }}>
        <video
          ref={videoRef}
          className="md-video-el"
          src={view.url}
          controls
          preload="metadata"
          playsInline
          width={width}
          height={height}
          aria-label={name}
          onClick={(e) => {
            // A click on the paused picture (not on its controls, along the bottom) opens the viewer.
            const v = e.currentTarget;
            if (!v.paused || e.clientY - v.getBoundingClientRect().top > v.clientHeight - Math.min(CONTROLS_PX, v.clientHeight / 3)) return;
            e.preventDefault();
            expand();
          }}
          onError={(e) => {
            const code = e.currentTarget.error?.code ?? 0;
            setView(CANT_PLAY.has(code) ? { kind: 'unplayable', format: videoFormat(view.mime, view.codec) } : failed("the video didn't load"));
          }}
        />
        <HoverTooltip content="View full size">
          <button type="button" className="icon-button md-video-expand" aria-label="View full size" onClick={(e) => { e.stopPropagation(); expand(); }}><Maximize2 size={14} /></button>
        </HoverTooltip>
      </span>
    );
  }
  if (view.kind === 'unplayable') {
    const openWithApp = () => {
      if (repo === undefined || remoteUrl === null) return;
      api.forgeOpenVideo(repo, remoteUrl, consent).catch((e: unknown) => useToast.getState().show(errorMessage(e), { error: true }));
    };
    return (
      <span className="md-img-box md-video-box md-video-unplayable" style={box} role="group" aria-label={name}>
        <span className="md-video-why">{`This video's format (${view.format}) can't play here`}</span>
        <span className="md-video-actions">
          {remoteUrl && <button type="button" className="md-img-load" onClick={(e) => { e.stopPropagation(); openExternal(remoteUrl); }}>Open in browser</button>}
          {remoteUrl && <button type="button" className="md-img-load" onClick={(e) => { e.stopPropagation(); openWithApp(); }}>Open with default app</button>}
        </span>
      </span>
    );
  }
  if (view.kind === 'ask') {
    return (
      <span className="md-img-box md-img-ask" style={box}>
        <span className="md-img-alt">{name}</span>
        <button type="button" className="md-img-load" onClick={(e) => { e.stopPropagation(); if (remoteUrl) { allowImage(remoteUrl); setConsented(remoteUrl); } }}>Load video from {view.host}</button>
      </span>
    );
  }
  if (view.kind === 'broken') return <span className="md-img-box md-img-broken" style={box} role="img" aria-label={name} title={view.why}><ImageOff size={14} aria-hidden /><span className="md-img-alt">{name}</span></span>;
  // Loading: a neutral box with ▶ and the file name, the size the video will take.
  return <span className="md-img-box md-video-box md-img-loading" style={box} role="img" aria-label={name} aria-busy="true"><Play size={14} aria-hidden /><span className="md-img-alt">{fileName}</span></span>;
}
