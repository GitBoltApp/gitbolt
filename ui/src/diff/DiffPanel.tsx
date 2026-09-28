// Reached only through RepoView's React.lazy import: this module pulls in Shiki's language
// registry (language.ts) and the Monaco loader, which stay out of the startup chunk (spec §10.3).
import { X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { errorMessage } from '../api/client';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import { StatusIcon } from '../files/StatusIcon';
import { ImageDiff } from '../image/ImageDiff';
import { useImageSources } from '../image/sources';
import { useFocusZone } from '../repo/focus';
import { HoverTooltip } from '../ui/HoverTooltip';
import { isCloseFileKey, markEditorKey } from '../ui/keys';
import { contentKey, type RepoServices } from '../repo/services';
import { contentsRequest, useRepoView, type DiffTarget, type Loadable } from '../repo/store';
import { DiffToolbar, goToChange } from './DiffToolbar';
import { FileView } from './FileView';
import { eolLabel, formatBytes } from './format';
import { highlightLanguage } from './language';
import { loadMonacoHost } from './monaco/load';
import { renameParts } from './renamePath';
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

/** How long switching files keeps the previous file on screen while the next one loads, before
 * the panel says "Loading…". Long enough to cover a normal load, so the switch is one render. */
export const STALE_MS = 300;

/**
 * What the panel presents: `target` and its contents once they're ready and, while they load,
 * the last ready file, for up to `STALE_MS` (F24). Header, toolbar and body all follow it, so a
 * switch replaces the whole panel in one render instead of flashing "Loading…" (which also
 * detached the editor). Errors and ready contents present at once.
 */
export function usePresented(target: DiffTarget, contents: Loadable<DiffContentsPayload>): { target: DiffTarget; contents: Loadable<DiffContentsPayload> } {
  const last = useRef<{ target: DiffTarget; contents: Loadable<DiffContentsPayload> } | null>(null);
  const [expired, setExpired] = useState<string | null>(null);
  const loading = contents.status === 'loading' || contents.status === 'idle';
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => setExpired(target.key), STALE_MS);
    return () => {
      clearTimeout(timer);
      setExpired(null);
    };
  }, [loading, target.key]);
  if (!loading) return (last.current = { target, contents });
  if (last.current && expired !== target.key) return last.current;
  return { target, contents };
}

/** How long a diff may take to load or compute before the header's progress line shows. */
export const BUSY_DELAY_MS = 150;

/** True once `on` has held for `ms` for the same `key`; false again as soon as it drops. */
function useLateFlag(on: boolean, ms: number, key: string): boolean {
  const [late, setLate] = useState<string | null>(null);
  useEffect(() => {
    if (!on) return;
    const timer = setTimeout(() => setLate(key), ms);
    return () => clearTimeout(timer);
  }, [on, ms, key]);
  return on && late === key;
}

/** A rename's tooltip (H21): the old full path, a centred ↓, the new full path, left-aligned.
 * Lane P builds the shared `RenamePaths` for the file list (H22); the controller dedupes the two at
 * merge. */
export function RenameTooltip({ oldPath, path }: { oldPath: string; path: string }) {
  return (
    <div className="rename-paths">
      <span>{oldPath}</span>
      <span className="rename-arrow" aria-label="renamed to">↓</span>
      <span>{path}</span>
    </div>
  );
}

/** The path: its directories dim and the file name highlighted. A rename (H21):
 * the directories both paths share, then `old ⇒ new` with only the new file name highlighted. */
function DiffPath({ target }: { target: DiffTarget }) {
  if (target.oldPath && target.oldPath !== target.path) {
    const r = renameParts(target.oldPath, target.path);
    return (
      <HoverTooltip content={<RenameTooltip oldPath={target.oldPath} path={target.path} />}>
        <span className="diff-path" data-testid="diff-path">
          {r.common && <span className="crumb">{r.common}</span>}
          <span className="crumb">{r.old}</span>
          <span className="crumb rename-sep"> ⇒ </span>
          {r.newDir && <span className="crumb">{r.newDir}</span>}
          <strong>{r.newName}</strong>
        </span>
      </HoverTooltip>
    );
  }
  const parts = target.path.split('/');
  const file = parts.pop()!;
  return (
    <HoverTooltip content={target.path}>
      <span className="diff-path" data-testid="diff-path">
        {parts.map((p, i) => <span key={i} className="crumb">{p}/</span>)}
        <strong>{file}</strong>
      </span>
    </HoverTooltip>
  );
}

/** `leading` (H9): the slot at the header's far left, for the controller's "Open in…" button
 * (lane P's `OpenInButton`). */
export function DiffHeader({ target, encoding, onClose, busy = false, leading }: { target: DiffTarget; encoding: string; onClose: () => void; busy?: boolean; leading?: ReactNode }) {
  return (
    <header className="diff-header">
      {leading && <div className="diff-header-leading">{leading}</div>}
      {/* F21: the change-kind icon, before the path. Empty for an unchanged File View file
          (fileViewTarget's status is ''), which has nothing to show an icon for: a same-width
          spacer (FileList.tsx's pattern) keeps the path from shifting as files are stepped
          through. */}
      {target.status
        ? <StatusIcon status={target.status} size={14} />
        : <span className="status-spacer" style={{ width: 14 }} aria-hidden="true" />}
      <DiffPath target={target} />
      {encoding && <span className="diff-encoding" data-testid="diff-encoding">{encoding}</span>}
      <button type="button" className="icon-button" aria-label="Close diff" title="Close (Esc)" onClick={onClose}><X size={14} /></button>
      {busy && <div className="diff-progress" role="progressbar" aria-label="Loading diff" />}
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

/** Whether the body shows an editor (a text diff, or File View's text): it's on screen only once
 * the host has shown it, which the header and toolbar wait for. */
function showsEditor(target: DiffTarget, contents: Loadable<DiffContentsPayload>): boolean {
  if (contents.status !== 'ready') return false;
  const c = contents.data;
  return !c.tooLarge && !isImage(target, c) && !c.old?.binary && !c.new?.binary;
}

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
function ImageBody({ target, contents: c, onSourceChange }: { target: DiffTarget; contents: DiffContentsPayload; onSourceChange?: (on: boolean) => void }) {
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
  // One ImageDiff per file: every file opens at its own defaults (mode, zoom, Source off).
  const single = fileView ? null : !c.old ? 'added' : !c.new ? 'deleted' : null;
  return <ImageDiff key={target.key} old={old} new={neu} source={source} onSourceChange={onSourceChange} single={single} />;
}

function Body({ target, contents, forced, onLoadAnyway, onShown, onSourceChange }: { target: DiffTarget; contents: Loadable<DiffContentsPayload>; forced: boolean; onLoadAnyway: () => void; onShown: () => void; onSourceChange?: (on: boolean) => void }) {
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
  if (isImage(target, c)) return <ImageBody target={target} contents={c} onSourceChange={onSourceChange} />;
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
        ? <FileView path={target.path} text={c.new ? modified : original} language={language} onShown={onShown} />
        : <TextDiff path={target.path} original={original} modified={modified} language={language} onShown={onShown} />}
    </>
  );
}

/** Monaco's own overlays that Esc closes, while one is open: the find widget, the F1 command
 * palette, the accessible diff viewer, the context menu (on in 1B), a hover, the suggest and
 * parameter-hint widgets. */
const ESCAPE_OWNERS = [
  '.find-widget.visible',
  '.quick-input-widget',
  '.diff-review',
  '.context-view',
  '.monaco-menu-container',
  '.monaco-hover:not(.hidden)',
  '.suggest-widget.visible',
  '.parameter-hints-widget.visible',
].join(', ');
const isShown = (el: HTMLElement) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
/** Whether one of `ESCAPE_OWNERS` is on screen. The whole document, not just the panel, and
 * inside Monaco's shadow roots: its context view renders in an open shadow root
 * (`.shadow-root-host`, `useShadowDOM` is on by default), in the editor's container or on
 * `<body>` depending on the host. */
const editorOwnsEscape = () =>
  [document, ...[...document.querySelectorAll('.shadow-root-host')].flatMap((h) => (h.shadowRoot ? [h.shadowRoot] : []))]
    .some((root) => [...root.querySelectorAll<HTMLElement>(ESCAPE_OWNERS)].some(isShown));

/** Targets inside the zone that use ← themselves. */
const OWNS_ARROWS = '.monaco-host, input, textarea, select, [role="slider"]';
/** Targets a click leaves alone: controls, and the editor (Monaco focuses itself). */
const OWNS_CLICKS = 'button, a, input, select, textarea, [role="toolbar"], [role="slider"], .monaco-host';

/**
 * The center-panel takeover (spec §10.1). The graph stays mounted, hidden, underneath.
 * `target` comes from the parent's `diff` selector, so it's never null while this renders.
 *
 * F7 / Shift+F7 are captured here, before Monaco sees them: Monaco binds F7 to its accessible
 * diff viewer, which stays reachable from its F1 palette (plan 1B deviation 7). So is Esc, which
 * closes the file from anywhere in the panel, the editor included (F26): Monaco would otherwise
 * spend it on cancelling a selection. Its own overlays (find, the command palette, the context
 * menu, hovers, …) still close on Esc first (`editorOwnsEscape`). Ctrl+W always closes the file.
 */
export function DiffPanel({ target }: { target: DiffTarget }) {
  const services = useRepoView((s) => s.services);
  const closeDiff = useRepoView((s) => s.closeDiff);
  const setFocus = useRepoView((s) => s.setFocus);
  const ref = useRef<HTMLElement>(null);
  const zone = useFocusZone('diff', ref);
  // "Load anyway" holds for the file it was pressed on; another file asks again.
  const [forcedKey, setForcedKey] = useState<string | null>(null);
  const live = useContents(services, target, forcedKey === target.key);
  // The body renders the presented file: the target, or the previous one while it loads.
  const body = usePresented(target, live);
  const forced = forcedKey === body.target.key;
  // The header and toolbar follow the body, but an editor body only once the host has shown it:
  // the diff (or file) computes off-screen, and all of it switches in the same frame (F24).
  // `flushSync`, so that render commits in the task that swapped the editor, before a paint.
  const bodyId = `${body.target.key}|${body.target.view}`;
  const [editorShown, setEditorShown] = useState<string | null>(null);
  const onShown = () => flushSync(() => setEditorShown(bodyId));
  // Still on its way: the target's contents are loading, or its editor hasn't shown it yet (a cold
  // first load, a slow diff). The progress line shows only if that lasts.
  const pending = live.status === 'loading' || live.status === 'idle' || (showsEditor(body.target, body.contents) && editorShown !== bodyId);
  const busy = useLateFlag(pending, BUSY_DELAY_MS, `${target.key}|${bodyId}`);
  // Only a switch to another file waits: the same file (its first load, File/Diff View, "Load
  // anyway") has nothing else on screen to be out of step with.
  const header = useRef(body);
  if (!showsEditor(body.target, body.contents) || editorShown === bodyId || header.current.target.key === body.target.key) header.current = body;
  const { target: shown, contents } = header.current;
  // An SVG's Source toggle, per file: its text diff gets the text-diff controls (H26).
  const [sourceOf, setSourceOf] = useState<string | null>(null);
  const imageDiff = contents.status === 'ready' && isImage(shown, contents.data) && !contents.data.tooLarge;
  const svgSource = imageDiff && sourceOf === shown.key;
  const textDiff = showsTextDiff(shown, contents) || (svgSource && shown.view === 'diff');
  const encoding = contents.status === 'ready' ? (contents.data.new?.encoding || contents.data.old?.encoding || '') : '';
  // An unchanged file from "View all files" has nothing to diff against.
  const canDiff = !(shown.status === '' && shown.old.kind === 'absent');
  const onKeyDownCapture = (e: KeyboardEvent) => {
    const esc = e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
    if (esc || isCloseFileKey(e)) {
      // Esc belongs to an open editor overlay; mark it so the view's own Esc (RepoView) skips it
      // too, since Monaco closes some (a hover) without stopping the event. Ctrl+W always closes.
      if (esc && editorOwnsEscape()) {
        markEditorKey(e.nativeEvent);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      closeDiff();
      return;
    }
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
      <DiffHeader target={shown} encoding={encoding} onClose={closeDiff} busy={busy} />
      <DiffToolbar target={shown} canDiff={canDiff} canStep={textDiff} textTools={!imageDiff || svgSource} />
      <div className="diff-body">
        <Body target={body.target} contents={body.contents} forced={forced} onLoadAnyway={() => setForcedKey(body.target.key)} onShown={onShown} onSourceChange={(on) => setSourceOf(on ? body.target.key : null)} />
      </div>
    </section>
  );
}
