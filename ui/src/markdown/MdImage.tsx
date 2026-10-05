import { ImageOff } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRuntime } from '../app/runtime';
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

/** `shown.id`: the image's identity (`imageIdentity`), so a re-signed URL keeps showing it. */
type View = { kind: 'loading' } | { kind: 'shown'; url: string; id: string } | { kind: 'ask'; host: string } | { kind: 'broken' };

/** An image (spec §4.2): the forge's own hosts load through the core; another host waits for
 * "Load image from <host>"; a relative one in File View is 5B's. No `<img>` here ever points at
 * the network: only `data:` or 5B's object URLs. The box keeps `width`/`height` reserved. A
 * GitHub attachment whose signed URL changed (a poll) keeps showing until the new one loads. */
export function MdImage({ ctx, src, alt, width, height }: MdImageProps) {
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
    if (source.kind === 'none') set({ kind: 'broken' });
    else if (source.kind === 'data') set({ kind: 'shown', url: source.url, id });
    else if (source.kind === 'repo') {
      const load = repoLoader;
      const release = repoRelease;
      let got: string | null = null;
      if (!load || ctx.kind !== 'file') set({ kind: 'broken' });
      else {
        load(ctx, source.path, source.commit).then((u) => {
          if (u && !live) { release?.(u); return; }
          got = u;
          set(u ? { kind: 'shown', url: u, id } : { kind: 'broken' });
        }, () => set({ kind: 'broken' }));
      }
      return () => {
        live = false;
        if (got) release?.(got);
      };
    } else if (source.kind === 'remote' && !consent) set({ kind: 'ask', host: source.host });
    else if (repo === undefined) set({ kind: 'broken' });
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
          set({ kind: 'broken' });
        }
      }, () => { if (!showing()) set({ kind: 'broken' }); });
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `ctx` is read through `source`
  }, [source, repo, consent]);
  const box = { width: width ? `${width}px` : undefined, aspectRatio: width && height ? `${width} / ${height}` : undefined };
  const name = alt || 'Image';
  if (view.kind === 'shown') return <img className="md-img" src={view.url} alt={alt} width={width} height={height} onError={() => setView({ kind: 'broken' })} />;
  if (view.kind === 'ask') {
    return (
      <span className="md-img-box md-img-ask" style={box}>
        {alt && <span className="md-img-alt">{alt}</span>}
        <button type="button" className="md-img-load" onClick={(e) => { e.stopPropagation(); if (consentUrl) { allowImage(consentUrl); setConsented(consentUrl); } }}>Load image from {view.host}</button>
      </span>
    );
  }
  if (view.kind === 'broken') return <span className="md-img-box md-img-broken" style={box} role="img" aria-label={name}><ImageOff size={14} aria-hidden />{alt && <span className="md-img-alt">{alt}</span>}</span>;
  return <span className="md-img-box md-img-loading" style={box} role="img" aria-label={name} aria-busy="true" />;
}
