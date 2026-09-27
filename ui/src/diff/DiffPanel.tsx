// Reached only through RepoView's React.lazy import: this module pulls in Shiki's language
// registry (language.ts) and the Monaco loader, which stay out of the startup chunk (spec §10.3).
import { X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { errorMessage } from '../api/client';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import { ImageDiff } from '../image/ImageDiff';
import { useImageSources } from '../image/sources';
import { useFocusZone } from '../repo/focus';
import { contentKey, type RepoServices } from '../repo/services';
import { contentsRequest, useRepoView, type DiffTarget, type Loadable } from '../repo/store';
import { DiffToolbar, goToChange } from './DiffToolbar';
import { FileView } from './FileView';
import { eolLabel, formatBytes } from './format';
import { highlightLanguage } from './language';
import { loadMonacoHost } from './monaco/load';
import { TextDiff } from './TextDiff';
import './diff.css';

/** The target's contents. A cached (e.g. prefetched) file is ready on the first render, so
 * Up/Down through prefetched files never shows a loading frame. */
export function useContents(services: RepoServices, target: DiffTarget, force: boolean): Loadable<DiffContentsPayload> {
  const key = contentKey(contentsRequest(target, force));
  const [state, setState] = useState<{ key: string; value: Loadable<DiffContentsPayload> }>({ key: '', value: { status: 'idle' } });
  useEffect(() => {
    let live = true;
    const hit = services.contents.peek(key);
    if (hit) {
      setState({ key, value: { status: 'ready', data: hit } });
      return;
    }
    setState({ key, value: { status: 'loading' } });
    services.contents.get(key).then(
      (data) => { if (live) setState({ key, value: { status: 'ready', data } }); },
      (e: unknown) => { if (live) setState({ key, value: { status: 'error', message: errorMessage(e) } }); },
    );
    return () => { live = false; };
  }, [services, key]);
  if (state.key === key) return state.value;
  const hit = services.contents.peek(key);
  return hit ? { status: 'ready', data: hit } : { status: 'loading' };
}

export function DiffHeader({ target, encoding, onClose }: { target: DiffTarget; encoding: string; onClose: () => void }) {
  const parts = target.path.split('/');
  const file = parts.pop()!;
  return (
    <header className="diff-header">
      <span className="diff-path" data-testid="diff-path" title={target.path}>
        {parts.map((p, i) => <span key={i} className="crumb">{p}/</span>)}
        <strong>{file}</strong>
        {target.oldPath && <span className="dim"> (renamed from {target.oldPath})</span>}
      </span>
      {encoding && <span className="diff-encoding" data-testid="diff-encoding">{encoding}</span>}
      <button type="button" className="icon-button" aria-label="Close diff" title="Close (Esc)" onClick={onClose}><X size={14} /></button>
    </header>
  );
}

/** The backend's ceiling for a forced load (`MAX_FORCED_BYTES`, diff.rs): a side over it stays
 * `tooLarge` even with `force`. */
const FORCED_CEILING_LABEL = '64 MB';

/** A raster image (the backend's `image` flag) or a text SVG: `Body` shows the image diff. A
 * binary side of an SVG carries no bytes (base64 is for raster images only), so that one keeps the
 * binary summary. */
const isImage = (target: DiffTarget, c: DiffContentsPayload) =>
  c.image || (target.path.toLowerCase().endsWith('.svg') && !c.old?.binary && !c.new?.binary);

/** Whether the body shows a text diff, which is what F7 and Previous/Next change step through.
 * Mirrors `Body`: an image diff (even an SVG's Source view) isn't one. */
function showsTextDiff(target: DiffTarget, contents: Loadable<DiffContentsPayload>): boolean {
  if (target.view !== 'diff' || contents.status !== 'ready') return false;
  const c = contents.data;
  return !c.tooLarge && !isImage(target, c) && !c.old?.binary && !c.new?.binary;
}

/**
 * The image diff (spec §10.4). `contents` is the loader's cached object, so its identity holds
 * across re-renders and `useImageSources` builds the object URLs once per file.
 * File View shows the image at that revision only: the new side, or the old one if it was deleted.
 * An SVG's Source toggle shows its text: the diff, or the file in File View.
 */
function ImageBody({ target, contents: c }: { target: DiffTarget; contents: DiffContentsPayload }) {
  const sources = useImageSources(c, target.path);
  if (!sources) return <div className="diff-message" aria-busy="true">Loading…</div>;
  const fileView = target.view === 'file';
  const original = c.old?.text ?? '';
  const modified = c.new?.text ?? '';
  const svg = target.path.toLowerCase().endsWith('.svg');
  const language = svg ? highlightLanguage(target.path, modified || original) : '';
  const source = !svg ? undefined : fileView
    ? <FileView path={target.path} text={c.new ? modified : original} language={language} />
    : <TextDiff path={target.path} original={original} modified={modified} language={language} />;
  const old = fileView && c.new ? null : sources.old;
  const neu = fileView && !c.new ? null : sources.new;
  return <ImageDiff old={old} new={neu} source={source} />;
}

function Body({ target, contents, forced, onLoadAnyway }: { target: DiffTarget; contents: Loadable<DiffContentsPayload>; forced: boolean; onLoadAnyway: () => void }) {
  if (contents.status === 'error') return <div role="alert" className="diff-message">{contents.message}</div>;
  if (contents.status !== 'ready') return <div className="diff-message" aria-busy="true">Loading…</div>;
  const c = contents.data;
  if (c.tooLarge && forced) {
    return (
      <div className="diff-message">
        <p>Too large to show — over {FORCED_CEILING_LABEL} per side</p>
        <p className="dim">{formatBytes(c.old?.size)} → {formatBytes(c.new?.size)}</p>
      </div>
    );
  }
  if (c.tooLarge) {
    return (
      <div className="diff-message">
        <p>Large file — load anyway?</p>
        <p className="dim">{formatBytes(c.old?.size)} → {formatBytes(c.new?.size)}</p>
        <button type="button" className="text-button" onClick={onLoadAnyway}>Load anyway</button>
      </div>
    );
  }
  if (isImage(target, c)) return <ImageBody target={target} contents={c} />;
  if (c.old?.binary || c.new?.binary) {
    return <div className="diff-message" data-testid="binary-summary">Binary file · {formatBytes(c.old?.size)} → {formatBytes(c.new?.size)}</div>;
  }
  const original = c.old?.text ?? '';
  const modified = c.new?.text ?? '';
  const language = highlightLanguage(target.path, modified || original);
  // The banner's slot stays in place while it's absent, so moving between files never remounts
  // (detaches and re-attaches) the editor.
  return (
    <>
      {c.eolOnly && <div role="note" className="diff-banner">Only line endings changed ({eolLabel(c.old?.eol)} → {eolLabel(c.new?.eol)})</div>}
      {target.view === 'file'
        ? <FileView path={target.path} text={c.new ? modified : original} language={language} />
        : <TextDiff path={target.path} original={original} modified={modified} language={language} />}
    </>
  );
}

/** Targets inside the zone that use ← themselves. */
const OWNS_ARROWS = '.monaco-host, input, textarea, select, [role="slider"]';
/** Targets a click leaves alone: controls, and the editor (Monaco focuses itself). */
const OWNS_CLICKS = 'button, a, input, select, textarea, [role="toolbar"], [role="slider"], .monaco-host';

/**
 * The center-panel takeover (spec §10.1). The graph stays mounted, hidden, underneath.
 * `target` comes from the parent's `diff` selector, so it's never null while this renders.
 *
 * F7 / Shift+F7 are captured here, before Monaco sees them: Monaco binds F7 to its accessible
 * diff viewer, which stays reachable from its F1 palette (plan 1B deviation 7).
 */
export function DiffPanel({ target }: { target: DiffTarget }) {
  const services = useRepoView((s) => s.services);
  const closeDiff = useRepoView((s) => s.closeDiff);
  const setFocus = useRepoView((s) => s.setFocus);
  const ref = useRef<HTMLElement>(null);
  const zone = useFocusZone('diff', ref);
  // "Load anyway" holds for the file it was pressed on; another file asks again.
  const [forcedKey, setForcedKey] = useState<string | null>(null);
  const forced = forcedKey === target.key;
  const contents = useContents(services, target, forced);
  const textDiff = showsTextDiff(target, contents);
  const encoding = contents.status === 'ready' ? (contents.data.new?.encoding || contents.data.old?.encoding || '') : '';
  // An unchanged file from "View all files" has nothing to diff against.
  const canDiff = !(target.status === '' && target.old.kind === 'absent');
  const onKeyDownCapture = (e: KeyboardEvent) => {
    if (e.key !== 'F7' || e.ctrlKey || e.altKey || e.metaKey || !textDiff) return;
    e.preventDefault();
    e.stopPropagation();
    goToChange(e.shiftKey ? 'previous' : 'next');
  };
  // ← goes back to the file list (the mirror of → there), unless the editor or a control in the
  // zone uses the key.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (e.target instanceof Element && e.target.closest(OWNS_ARROWS)) return;
    e.preventDefault();
    setFocus('files');
  };
  // A click in the zone outside the editor and its controls puts the keyboard in the editor
  // (scrolling, selection, Monaco's own keys). Not while selecting text, such as the path.
  const onClick = (e: MouseEvent) => {
    const el = ref.current;
    if (!el || !(e.target instanceof Element) || e.target.closest(OWNS_CLICKS)) return;
    if (!el.querySelector('.monaco-host') || window.getSelection()?.isCollapsed === false) return;
    void loadMonacoHost().then((h) => h.focus());
  };
  return (
    <section ref={ref} className="diff-panel" role="region" aria-label="Diff" tabIndex={-1} onKeyDownCapture={onKeyDownCapture} onKeyDown={onKeyDown} onClick={onClick} {...zone}>
      <DiffHeader target={target} encoding={encoding} onClose={closeDiff} />
      <DiffToolbar target={target} canDiff={canDiff} canStep={textDiff} />
      <div className="diff-body">
        <Body target={target} contents={contents} forced={forced} onLoadAnyway={() => setForcedKey(target.key)} />
      </div>
    </section>
  );
}
