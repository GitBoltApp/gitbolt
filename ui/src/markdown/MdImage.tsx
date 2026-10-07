import { ImageOff } from 'lucide-react';
import { useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { errorMessage } from '../api/client';
import { useRuntime } from '../app/runtime';
import { openLightbox } from '../lightbox/store';
import { openExternal } from './actions';
import { InLink } from './inLink';
import { MdVideo } from './MdVideo';
import { isVideoSrc } from './videos';
import { allowImage, imageAllowed, imageIdentity, loadForgeImage, refreshSignedImages, rememberShown, resolveImage, shownBefore } from './images';
import type { FileMarkdownContext, MdImageProps } from './types';

/** 5B's loader for relative images in File View: `path` is repo-root-relative; it answers an
 * object URL, or null. */
export type RepoImageLoader = (ctx: FileMarkdownContext, path: string, commit: string | 'worktree') => Promise<string | null>;
let repoLoader: RepoImageLoader | null = null;
/** Each URL the loader answered goes back once its `<img>` is gone (or arrived too late for one). */
let repoRelease: ((url: string) => void) | null = null;

/** 5B registers its loader (the 5A/5B contract puts this here), and how to give back a URL it
 * answered once no image shows it. Returns its removal. */
export function registerRepoImageLoader(fn: RepoImageLoader, release?: (url: string) => void): () => void {
  repoLoader = fn;
  repoRelease = release ?? null;
  return () => {
    if (repoLoader !== fn) return;
    repoLoader = null;
    repoRelease = null;
  };
}

/** `shown.id`: the image's identity (`imageIdentity`), so a re-signed URL keeps showing it.
 * `broken.why`: the placeholder's tooltip, so one failure can be told from another. */
type View = { kind: 'loading' } | { kind: 'shown'; url: string; id: string } | { kind: 'ask'; host: string } | { kind: 'broken'; why: string };

const NOT_ALLOWED = "Not loaded: GitBolt doesn't load images from this address";
const failed = (why: string): View => ({ kind: 'broken', why: `Couldn't load: ${why}` });

/** An image (spec §4.2): the forge's own hosts load through the core; another host waits for
 * "Load image from <host>"; a relative one in File View is 5B's. No `<img>` here ever points at
 * the network: only `data:` or 5B's object URLs. The box keeps `width`/`height` reserved. A
 * GitHub attachment whose signed URL changed (a poll) keeps showing until the new one loads. */
export function MdImage(props: MdImageProps) {
  // GitLab renders an image link to a video file as a video.
  return isVideoSrc(props.src) ? <MdVideo {...props} /> : <MdPicture {...props} />;
}

function MdPicture({ ctx, src, alt, width, height }: MdImageProps) {
  const ctxKey = ctx.kind === 'forge' ? ctx.tabId : `${ctx.tabId}\0${ctx.commit}\0${ctx.path}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the context's value
  const source = useMemo(() => resolveImage(ctx, src), [ctxKey, src]);
  const id = useMemo(() => imageIdentity(src), [src]);
  const repo = useRuntime((s) => s.tabs[ctx.tabId]?.repo?.id);
  const consentUrl = source.kind === 'remote' || source.kind === 'forge' ? source.url : null;
  // Consent is per URL for the session (`allowImage`); the state only re-renders after a click.
  const [consented, setConsented] = useState<string | null>(null);
  const consent = consentUrl !== null && (consented === consentUrl || imageAllowed(consentUrl));
  const [view, setView] = useState<View>(() => {
    const before = id !== src ? shownBefore(id) : null;
    return before ? { kind: 'shown', url: before, id } : { kind: 'loading' };
  });
  const current = useRef(view);
  current.current = view;
  useEffect(() => {
    let live = true;
    const set = (v: View) => { if (live) setView(v); };
    // The same image already shows (a re-signed URL): it stays until the new answer is in.
    const showing = () => current.current.kind === 'shown' && (current.current as { id: string }).id === id;
    if (source.kind === 'none') set({ kind: 'broken', why: NOT_ALLOWED });
    else if (source.kind === 'data') set({ kind: 'shown', url: source.url, id });
    else if (source.kind === 'repo') {
      const load = repoLoader;
      const release = repoRelease;
      let got: string | null = null;
      if (!load || ctx.kind !== 'file') set(failed("the repository isn't available here"));
      else {
        load(ctx, source.path, source.commit).then((u) => {
          if (u && !live) { release?.(u); return; }
          got = u;
          set(u ? { kind: 'shown', url: u, id } : failed('not found in the repository'));
        }, (e: unknown) => set(failed(errorMessage(e))));
      }
      return () => {
        live = false;
        if (got) release?.(got);
      };
    } else if (source.kind === 'remote' && !consent) set({ kind: 'ask', host: source.host });
    else if (repo === undefined) set(failed('no repository is open'));
    else {
      if (!showing()) set({ kind: 'loading' });
      loadForgeImage(repo, source.url, consent).then((r) => {
        if (r.kind === 'found') {
          const url = `data:${r.mime};base64,${r.base64}`;
          if (id !== src) rememberShown(id, url);
          set({ kind: 'shown', url, id });
        } else if (r.kind === 'ask') set({ kind: 'ask', host: r.host });
        else if (!showing()) {
          if (r.kind === 'expired') refreshSignedImages(ctx);
          set(failed(r.kind === 'expired' ? 'its link expired' : r.reason));
        }
      }, (e: unknown) => { if (!showing()) set(failed(errorMessage(e))); });
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `ctx` is read through `source`
  }, [source, repo, consent]);
  const inLink = useContext(InLink);
  const browserUrl = source.kind === 'forge' || source.kind === 'remote' ? source.url : null;
  const box = { width: width ? `${width}px` : undefined, aspectRatio: width && height ? `${width} / ${height}` : undefined };
  const name = alt || 'Image';
  if (view.kind === 'shown') {
    const decodeFailed = () => setView(failed("the image didn't decode"));
    // A linked image is the link's: its click (and Ctrl+click) follow the link.
    if (inLink) return <img className="md-img" src={view.url} alt={alt} width={width} height={height} onError={decodeFailed} />;
    const open = (e: MouseEvent | KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) {
        if (browserUrl) openExternal(browserUrl);
        return;
      }
      openLightbox({ kind: 'image', url: view.url, alt, browserUrl });
    };
    return (
      <img
        className="md-img md-img-zoomable"
        src={view.url}
        alt={alt}
        width={width}
        height={height}
        tabIndex={0}
        onError={decodeFailed}
        onClick={open}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') open(e); }}
      />
    );
  }
  if (view.kind === 'ask') {
    return (
      <span className="md-img-box md-img-ask" style={box}>
        {alt && <span className="md-img-alt">{alt}</span>}
        <button type="button" className="md-img-load" onClick={(e) => { e.stopPropagation(); if (consentUrl) { allowImage(consentUrl); setConsented(consentUrl); } }}>Load image from {view.host}</button>
      </span>
    );
  }
  if (view.kind === 'broken') return <span className="md-img-box md-img-broken" style={box} role="img" aria-label={name} title={view.why}><ImageOff size={14} aria-hidden />{alt && <span className="md-img-alt">{alt}</span>}</span>;
  return <span className="md-img-box md-img-loading" style={box} role="img" aria-label={name} aria-busy="true" />;
}
