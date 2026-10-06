// Reached only through RepoView's React.lazy import: this module pulls in Shiki's language
// registry (language.ts) and the Monaco loader, which stay out of the startup chunk (spec §10.3).
import { X } from 'lucide-react';
import { BUSY_DELAY_MS, useLateFlag } from '../util/lateFlag';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { useRepoContext } from '../app/repoContext';
import { WipStagingUndo } from '../stage/UndoButtons';
import { isWipKey, wipKey } from '../repo/wipLists';
import { comboOf } from '../app/shortcuts';
import { registerKeys } from '../ui/keyRouter';
import { errorMessage } from '../api/client';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import { renameParts } from '../files/renameParts';
import { RenamePaths } from '../files/RenamePaths';
import { StatusIcon } from '../files/StatusIcon';
import { ImageDiff } from '../image/ImageDiff';
import { useImageSources } from '../image/sources';
import { useEscapeOwner } from '../repo/escape';
import { useFocusZone } from '../repo/focus';
import { HoverTooltip } from '../ui/HoverTooltip';
import { HistoryButtons } from '../history/HistoryButtons';
import { OpenInButton } from '../openIn/OpenInMenu';
import { contentKey, type RepoServices } from '../repo/services';
import { contentsRequest, useRepoView, useRepoViewStore, type DiffTarget, type Loadable, type Selection } from '../repo/store';
import { useChangeKeys } from './changeKeys';
import { DiffToolbar } from './DiffToolbar';
import type { FileCommit } from '../nav/history';
import { fileCommitOf, filePlaceKey } from '../nav/repoPlaces';
import { FileBody, MarkdownViewToggle } from './FileBody';
import { FileView } from './FileView';
import { isMarkdownPath, TOO_LARGE_TO_RENDER, useDiffTooLarge, useTooLargeToRender } from './markdownFiles';
import { DiffTextBody } from './DiffTextBody';
import { oldCommitOf } from './markdownDiffSides';
import { useMarkdownView } from './markdownOverride';
import { firstChangedLine } from './firstChange';
import { eolLabel, formatBytes } from './format';
import { BinaryNote, fileSideOf, HexBody, HexView } from './hex';
import { hexOf } from './hexContents';
import type { HexDumpPayload } from '../api/gen/HexDumpPayload';
import { highlightLanguage } from './language';
import { loadMonacoHost } from './monaco/load';
import { loadedHost, TextDiff } from './TextDiff';
import { HunkActions, wipSideOf } from './hunkActions';
import { wipHunkZones } from './wipHunks';
import { installLeaveGuard, installWindowCloseGuard, isEditableTarget, markDirty, saveWorkingCopy, suspendCopy, trackCopy, useWorkingCopy, worktreeFileTarget } from './workingCopy';
import './diff.css';
import { ArrowGlyph } from '../ui/ArrowGlyph';

/** The target's contents. A cached (e.g. prefetched) file is ready on the first render, so
 * Up/Down through prefetched files never shows a loading frame. */
export function useContents(services: RepoServices, target: DiffTarget, force: boolean, epoch: number | string = 0): Loadable<DiffContentsPayload> {
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
  }, [services, key, epoch]);
  if (state.key === key) return state.value;
  const hit = services.contents.peek(key);
  return hit ? { status: 'ready', data: hit } : { status: 'loading' };
}

/** How long switching files keeps the previous file on screen while the next one loads, before
 * the panel says "Loading…". Long enough to cover a normal load, so the switch is one render. */
export const STALE_MS = 300;

/** What the panel presents, in which `session` (J16: one per open of the kept panel). */
export interface Presented { target: DiffTarget; contents: Loadable<DiffContentsPayload>; session: number }

/**
 * What the panel presents: `target` and its contents once they're ready and, while they load,
 * the last ready file, for up to `STALE_MS` (F24). Header, toolbar and body all follow it, so a
 * switch replaces the whole panel in one render instead of flashing "Loading…" (which also
 * detached the editor). Errors and ready contents present at once. Only a file of the same
 * `session` stays: one from before a close is never presented after the reopen (J16, H6).
 */
export function usePresented(target: DiffTarget, contents: Loadable<DiffContentsPayload>, session = 0): Presented {
  const last = useRef<Presented | null>(null);
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
  if (!loading) return (last.current = { target, contents, session });
  if (last.current && last.current.session === session && expired !== target.key) return last.current;
  return { target, contents, session };
}

export { BUSY_DELAY_MS };

/** The path: its directories dim and the file name highlighted. A rename (H21):
 * the directories both paths share, then `old ⇒ new` with only the new file name highlighted;
 * its tooltip is the file list's (`RenamePaths`: old path, ↓, new path). */
function DiffPath({ target }: { target: DiffTarget }) {
  if (target.oldPath && target.oldPath !== target.path) {
    const r = renameParts(target.oldPath, target.path);
    return (
      <HoverTooltip content={<RenamePaths oldPath={target.oldPath} path={target.path} />}>
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

/** The path, its change kind and encoding, and ×. "Open in…" is on the toolbar below (J1). */
export function DiffHeader({ target, encoding, note, onClose, busy = false, dirty = false, onSave }: { target: DiffTarget; encoding: string; note?: ReactNode; onClose: () => void; busy?: boolean; dirty?: boolean; onSave?: () => void }) {
  return (
    // `.panel-bar` (tokens.css): the details header's bar box, so their dividers line up (K5).
    <header className="diff-header panel-bar">
      {/* F21: the change-kind icon, before the path. Empty for an unchanged File View file
          (fileViewTarget's status is ''), which has nothing to show an icon for: a same-width
          spacer (FileList.tsx's pattern) keeps the path from shifting as files are stepped
          through. */}
      {target.status
        ? <StatusIcon status={target.status} size={14} />
        : <span className="status-spacer" style={{ width: 14 }} aria-hidden="true" />}
      {dirty && <span className="diff-dirty" aria-label="Unsaved changes">●</span>}
      <DiffPath target={target} />
      {encoding && <span className="diff-encoding" data-testid="diff-encoding">{encoding}</span>}
      {note}
      {onSave && <HoverTooltip content="Save (Ctrl+S)"><button type="button" className="text-button diff-save" disabled={!dirty} onClick={onSave}>Save</button></HoverTooltip>}
      <HoverTooltip content="Close (Esc)"><button type="button" className="icon-button" aria-label="Close diff" onClick={onClose}><X size={14} /></button></HoverTooltip>
      {busy && <div className="diff-progress" role="progressbar" aria-label="Loading diff" />}
    </header>
  );
}

/** Where "Open in…" puts the cursor: the diff's first change (a plain line compare), when the
 * new side is text. */
function openInLine(c: DiffContentsPayload | null): number | null {
  if (!c || c.tooLarge) return null;
  const neu = c.new?.text;
  return neu == null ? null : firstChangedLine(c.old?.text ?? '', neu);
}

/** The backend's ceiling for a forced load (`MAX_FORCED_BYTES`, diff.rs): a side over it stays
 * `tooLarge` even with `force`. */
const FORCED_CEILING_LABEL = '64 MB';

/** A raster image (the backend's `image` flag) or a text SVG: `Body` shows the image diff. A
 * binary side of an SVG carries no bytes (base64 is for raster images only), so that one shows as
 * hex, as any other binary. */
const isImage = (target: DiffTarget, c: DiffContentsPayload) =>
  c.image || (target.path.toLowerCase().endsWith('.svg') && !c.old?.binary && !c.new?.binary);

/** Whether the body shows the shared editor (a text diff, or File View's text): it's on screen
 * only once the host has shown it, which the header and toolbar wait for. A binary's hex view
 * isn't it: it's painted in the commit that renders it (`HexView`), so nothing waits. */
function showsEditor(target: DiffTarget, contents: Loadable<DiffContentsPayload>): boolean {
  if (contents.status !== 'ready') return false;
  const c = contents.data;
  return !c.tooLarge && !isImage(target, c) && !isHex(target, c);
}

/** Whether the body shows a text diff, which is what F7 and Previous/Next change step through.
 * Mirrors `Body`: an image diff (even an SVG's Source view) isn't one. */
function showsTextDiff(target: DiffTarget, contents: Loadable<DiffContentsPayload>): boolean {
  if (target.view !== 'diff' || contents.status !== 'ready') return false;
  const c = contents.data;
  // A binary's hex diff steps through its changed rows too.
  return !c.tooLarge && !isImage(target, c);
}

/** A binary that isn't shown as an image: its hex dump (hex.tsx), with its sizes in the file bar. */
/** A Markdown file in File View, with the commit its relative links resolve against; `null`
 * for any other file, or a Markdown file with no commit (a deletion: Source only). */
const markdownOf = (selection: Selection, t: DiffTarget): { commit: FileCommit } | null => {
  const commit = isMarkdownPath(t.path) ? fileCommitOf({ selection }, t) : null;
  return commit === null ? null : { commit };
};
const isHex = (target: DiffTarget, c: DiffContentsPayload) => !c.tooLarge && !isImage(target, c) && !!(c.old?.binary || c.new?.binary);

/**
 * The image diff (spec §10.4). `contents` is the loader's cached object, so its identity holds
 * across re-renders and `useImageSources` builds the object URLs once per file.
 * File View shows the image at that revision only: the new side, or the old one if it was deleted.
 * An SVG's Source toggle shows its text: the diff, or the file in File View. A raster image's
 * Hex toggle shows its hex dump, as a binary file's (hex.tsx).
 */
function ImageBody({ target, contents: c, onSourceChange, onHex }: { target: DiffTarget; contents: DiffContentsPayload; onSourceChange?: (on: boolean) => void; onHex?: (key: string, hex: HexDumpPayload) => void }) {
  const sources = useImageSources(c, target.path);
  if (!sources) return <div className="diff-message" aria-busy="true">Loading…</div>;
  const fileView = target.view === 'file';
  const original = c.old?.text ?? '';
  const modified = c.new?.text ?? '';
  const svg = target.path.toLowerCase().endsWith('.svg');
  const language = svg ? highlightLanguage(target.path, modified || original) : '';
  const source = !svg ? <HexBody target={target} contents={c} onLoaded={(h) => onHex?.(target.key, h)} /> : fileView
    ? <FileView path={target.path} text={c.new ? modified : original} language={language} />
    : <TextDiff path={target.path} original={original} modified={modified} language={language} />;
  const old = fileView && c.new ? null : sources.old;
  const neu = fileView && !c.new ? null : sources.new;
  // One ImageDiff per file: every file opens at its own defaults (mode, zoom, Source off).
  const single = fileView ? null : !c.old ? 'added' : !c.new ? 'deleted' : null;
  return <ImageDiff key={target.key} old={old} new={neu} source={source} sourceLabel={svg ? 'Source' : 'Hex'} onSourceChange={onSourceChange} single={single} />;
}

/** `banner`: whether the line-endings banner may show. Not while the header (and so the editor)
 * still shows the previous file: it's this file's (K7). */
function Body({ target, contents, forced, banner, onLoadAnyway, onShown, onSourceChange, onHex, editable = false, onEdit, draft }: { target: DiffTarget; contents: Loadable<DiffContentsPayload>; forced: boolean; banner: boolean; onLoadAnyway: () => void; onShown: () => void; onSourceChange?: (on: boolean) => void; onHex?: (key: string, hex: HexDumpPayload) => void; editable?: boolean; onEdit?: () => void; draft?: string }) {
  const { repoId } = useRepoContext();
  const selection = useRepoView((s) => s.selection);
  // 5C: a Markdown file's diff, and the commit its old side's links and images resolve against (R9).
  const mdDiff = target.view === 'diff' && isMarkdownPath(target.path);
  const oldSide = useRepoView((s) => (mdDiff ? oldCommitOf(s, target) : null));
  if (contents.status === 'error') return <div role="alert" className="diff-message">{contents.message}</div>;
  if (contents.status !== 'ready') return <div className="diff-message" aria-busy="true">Loading…</div>;
  const c = contents.data;
  if (c.tooLarge && forced) {
    return (
      <div className="diff-message">
        <p>Too large to show — over {FORCED_CEILING_LABEL} per side</p>
        <p className="dim">{formatBytes(c.old?.size)} <ArrowGlyph /> {formatBytes(c.new?.size)}</p>
      </div>
    );
  }
  if (c.tooLarge) {
    return (
      <div className="diff-message">
        <p>Large file — load anyway?</p>
        <p className="dim">{formatBytes(c.old?.size)} <ArrowGlyph /> {formatBytes(c.new?.size)}</p>
        <button type="button" className="text-button" onClick={onLoadAnyway}>Load anyway</button>
      </div>
    );
  }
  if (isImage(target, c)) return <ImageBody target={target} contents={c} onSourceChange={onSourceChange} onHex={onHex} />;
  // A binary: its hex view. The dumps load with the contents (hexContents.ts), so it shows in the
  // render that presents the file; contents without them load them here.
  if (isHex(target, c)) {
    const hex = hexOf(c);
    if (!hex) return <HexBody target={target} contents={c} onShown={onShown} onLoaded={(h) => onHex?.(target.key, h)} />;
    const file = target.view === 'file';
    return <HexView path={target.path} hex={hex} file={file} side={file ? fileSideOf(c, hex) : undefined} onShown={onShown} />;
  }
  const original = c.old?.text ?? '';
  // Unsaved edits kept while the tab was hidden show again instead of the disk text.
  const modified = draft ?? c.new?.text ?? '';
  const language = highlightLanguage(target.path, modified || original);
  const wip = wipSideOf(target);
  // The banner's slot stays in place while it's absent, so moving between files never remounts
  // (detaches and re-attaches) the editor.
  return (
    <>
      {c.eolOnly && banner && <div role="note" className="diff-banner">Only line endings changed ({eolLabel(c.old?.eol)} <ArrowGlyph /> {eolLabel(c.new?.eol)})</div>}
      {target.view === 'file'
        ? <FileBody identity={target.key} path={target.path} text={c.new ? modified : original} language={language} onShown={onShown} editable={editable} onEdit={onEdit} navKey={filePlaceKey({ selection }, target)} markdown={markdownOf(selection, target)} />
        : (
          <DiffTextBody
            identity={target.key} path={target.path} oldPath={target.oldPath} original={original} modified={modified} language={language}
            onShown={onShown} editable={editable} onEdit={onEdit} hunkZones={wip ? () => wipHunkZones(repoId, target) : undefined}
            // Spec #2 §7.3: hunk and line buttons on a WIP text diff (in Source only, R8).
            after={wip ? <HunkActions target={target} /> : null}
            markdown={mdDiff ? { old: oldSide, new: fileCommitOf({ selection }, target) } : null}
          />
        )}
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
/** An overlay's own area, wherever it's mounted (a context view on <body>, a shadow root's host). */
export const ESCAPE_OWNER_AREAS = `${ESCAPE_OWNERS}, .shadow-root-host`;
/** Whether one of `ESCAPE_OWNERS` is on screen. The whole document, not just the panel, and
 * inside Monaco's shadow roots: its context view renders in an open shadow root
 * (`.shadow-root-host`, `useShadowDOM` is on by default), in the editor's container or on
 * `<body>` depending on the host. */
export const editorOwnsEscape = () =>
  [document, ...[...document.querySelectorAll('.shadow-root-host')].flatMap((h) => (h.shadowRoot ? [h.shadowRoot] : []))]
    .some((root) => [...root.querySelectorAll<HTMLElement>(ESCAPE_OWNERS)].some(isShown));

/** Targets inside the zone that use ← themselves. */
const OWNS_ARROWS = '.monaco-host, .hex-view, input, textarea, select, [role="slider"]';
/** Targets a click leaves alone: controls, and the editor (Monaco focuses itself). */
const OWNS_CLICKS = 'button, a, input, select, textarea, [role="toolbar"], [role="slider"], .monaco-host, .hex-view, .md-rendered';

/**
 * The center-panel takeover (spec §10.1). The graph stays mounted, hidden, underneath.
 * `target` comes from the parent's `diff` selector, so it's never null while this renders.
 *
 * F7 / Shift+F7 and Shift+↑/↓ step the changes app-wide while a text diff is shown
 * (`useChangeKeys`, J14), before Monaco sees them: Monaco binds F7 to its accessible diff viewer,
 * which stays reachable from its F1 palette (plan 1B deviation 7). Esc closes the file from
 * anywhere, the editor included (F26, J4), through the app's handler on window (`useAppEscape`),
 * which sees it before Monaco would spend it on cancelling a selection; the panel only registers
 * Monaco's overlays (find, the command palette, the context menu, hovers, …) as owners that close
 * on Esc first (`editorOwnsEscape`). Ctrl+W always closes the file (the app's shortcut,
 * `app/coreActions.ts`).
 */
export function DiffPanel({ target, session = 0 }: { target: DiffTarget; session?: number }) {
  const services = useRepoView((s) => s.services);
  const closeDiff = useRepoView((s) => s.closeDiff);
  const setFocus = useRepoView((s) => s.setFocus);
  const ref = useRef<HTMLElement>(null);
  const zone = useFocusZone('diff', ref);
  // "Load anyway" holds for the file it was pressed on, until it's closed; another file asks again.
  const [forcedKey, setForcedKey] = useState<string | null>(null);
  const forcedFor = (t: DiffTarget) => forcedKey === `${session}|${t.key}`;
  const { tabId, repoId } = useRepoContext();
  const store = useRepoViewStore();
  const epoch = useWorkingCopy((s) => s.epoch[tabId] ?? 0);
  // G.2: File View of a staged WIP file loads (and edits) its working-tree file.
  const loadTarget = useMemo(() => worktreeFileTarget(target), [target]);
  // A WIP file's sides are read again when its list moves (a stage, a discard, the watcher): a
  // discard changes the working-tree side, whose source (and so key) stays the same. A working-
  // tree file follows the unstaged list, which is the one that moves when it changes.
  const wipSide = wipSideOf(target);
  const wipList = wipSide ? wipKey(wipSide.worktree, wipSide.staged && loadTarget.new.kind !== 'worktree') : null;
  const wipVersion = useRepoView((s) => (wipList ? s.services.wip.peek(wipList)?.version ?? null : null));
  // Data safety (G.2): while the working copy has unsaved edits, nothing reloads the file under
  // them (a watcher refresh would show the disk text and drop them). A save or Reload clears the
  // dirty flag first; a change on disk meanwhile is the save's Stale [Reload] [Overwrite].
  const dirtyNow = useWorkingCopy((s) => !!s.copies[tabId]?.dirty);
  const reloadKey = `${epoch}|${wipVersion ?? ''}`;
  const heldReload = useRef(reloadKey);
  if (!dirtyNow) heldReload.current = reloadKey;
  const live = useContents(services, loadTarget, forcedFor(target), heldReload.current);
  // The body renders the presented file: the target, or the previous one while it loads.
  const body = usePresented(loadTarget, live, session);
  const forced = forcedFor(body.target);
  const bodyCopy = useWorkingCopy((s) => (s.copies[tabId]?.key === body.target.key ? s.copies[tabId] : undefined));
  // Spec #2 §7.5: the working-tree side of a WIP file is editable; tracked per presented file and
  // reload (a save or Reload gives a new payload, and so a new base).
  const bodyData = body.contents.status === 'ready' ? body.contents.data : null;
  const editable = isEditableTarget(body.target, bodyData);
  useEffect(() => {
    if (!editable || !bodyData) return;
    trackCopy(tabId, repoId, body.target, bodyData);
    // Out of view (a hidden tab) or replaced: unsaved edits are kept as a draft, else dropped.
    return () => suspendCopy(tabId, loadedHost());
  }, [tabId, repoId, editable, body.target.key, body.target.view, bodyData]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => installWindowCloseGuard(), []);
  const onEdit = useCallback(() => markDirty(tabId), [tabId]);
  useEffect(() => installLeaveGuard(tabId, store), [tabId, store]);
  useEffect(() => registerKeys('app', (e) => {
    if (comboOf(e) !== 'Ctrl+S' || !useWorkingCopy.getState().copies[tabId]) return;
    e.preventDefault();
    void saveWorkingCopy(tabId);
    return 'handled';
  }), [tabId]);
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
  // A reopen (another session, J16) starts over: the closed file's header is never shown.
  // And it waits only while the same editor still shows the header's file (K7): from a message
  // (a large file, a binary, an image, a failed load) or across Diff/File View, the body has
  // already moved on, so the header goes with it rather than naming a file no longer shown.
  const header = useRef(body);
  const held = header.current;
  const waits = showsEditor(body.target, body.contents) && editorShown !== bodyId && held.target.key !== body.target.key && held.session === session
    && showsEditor(held.target, held.contents) && held.target.view === body.target.view;
  if (!waits) header.current = body;
  const { target: shown, contents } = header.current;
  const copy = useWorkingCopy((s) => s.copies[tabId]);
  const shownCopy = copy?.key === shown.key ? copy : undefined;
  // Splits both full texts, so it is worked out once per loaded payload (the loader's cached
  // object), not on each of a file switch's several renders (review M1).
  const loaded = contents.status === 'ready' ? contents.data : null;
  const selection = useRepoView((s) => s.selection);
  // Spec #5 §3.3: the toggle for a Markdown file's text in File View (not a large-file prompt, a
  // hex view or an image); §3.1: it says why Rendered can't be picked for a file too large.
  const tooLarge = useTooLargeToRender(filePlaceKey({ selection }, shown), loaded?.new?.text ?? loaded?.old?.text ?? '');
  const textBody = !!loaded && !loaded.tooLarge && !isImage(shown, loaded) && !isHex(shown, loaded);
  // 5C: the same toggle for a Markdown file's text diff (R2); while Rendered, the toolbar's text-diff
  // tools say why they're off (R3).
  const mdDiff = shown.view === 'diff' && textBody && isMarkdownPath(shown.path);
  const diffTooLarge = useDiffTooLarge(shown.key, mdDiff ? loaded?.old?.text ?? '' : '', mdDiff ? loaded?.new?.text ?? '' : '').tooLarge;
  const mdPicked = useMarkdownView(mdDiff ? shown.path : null);
  const renderedDiff = mdDiff && mdPicked === 'rendered' && !diffTooLarge;
  const markdownToggle = shown.view === 'file' && textBody && markdownOf(selection, shown)
    ? <MarkdownViewToggle path={shown.path} forced={tooLarge ? TOO_LARGE_TO_RENDER : null} />
    : mdDiff ? <MarkdownViewToggle path={shown.path} forced={diffTooLarge ? TOO_LARGE_TO_RENDER : null} /> : null;
  const openLine = useMemo(() => openInLine(loaded), [loaded]);
  // An SVG's Source toggle, per file: its text diff gets the text-diff controls (H26).
  const [sourceOf, setSourceOf] = useState<string | null>(null);
  const imageDiff = contents.status === 'ready' && isImage(shown, contents.data) && !contents.data.tooLarge;
  const svgSource = imageDiff && sourceOf === shown.key;
  const textDiff = showsTextDiff(shown, contents) || (svgSource && shown.view === 'diff');
  // A binary's sizes (and the hex cap) in the file bar; an image's Hex view, the cap only.
  const hexImage = svgSource && !shown.path.toLowerCase().endsWith('.svg');
  // The dumps: loaded with the contents, or by the body itself (an image's Hex view).
  const [bodyHex, setBodyHex] = useState<{ key: string; hex: HexDumpPayload } | null>(null);
  const dumps = (loaded && hexOf(loaded)) ?? (bodyHex?.key === shown.key ? bodyHex.hex : null);
  const note = loaded && (isHex(shown, loaded) || hexImage) ? <BinaryNote target={shown} contents={loaded} hex={dumps} summary={!hexImage} /> : null;
  useChangeKeys(textDiff);
  const encoding = contents.status === 'ready' ? (contents.data.new?.encoding || contents.data.old?.encoding || '') : '';
  // An unchanged file from "View all files" has nothing to diff against.
  const canDiff = !(shown.status === '' && shown.old.kind === 'absent');
  // Esc is the app's (`useAppEscape`, on window, ahead of Monaco); an open editor overlay claims
  // it first, but only for a key pressed in the panel or in the overlay itself (feedback J4).
  useEscapeOwner(useCallback((e: globalThis.KeyboardEvent) => e.composedPath().some((n) => n === ref.current || (n instanceof Element && n.matches(ESCAPE_OWNER_AREAS))) && editorOwnsEscape(), []));
  // Ctrl+W (I1) always closes, editor overlay or not: it's the app's shortcut, in the key
  // router's `app` layer, which runs ahead of this component's own handlers and stops the event.
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
    if (!el.querySelector('.monaco-host, .hex-view, .md-rendered') || window.getSelection()?.isCollapsed === false) return;
    void loadMonacoHost().then((h) => h.focus());
  };
  return (
    <section ref={ref} className="diff-panel" role="region" aria-label="Diff" tabIndex={-1} onKeyDown={onKeyDown} onClick={onClick} {...zone}>
      <DiffHeader target={shown} encoding={encoding} note={note} onClose={closeDiff} busy={busy} dirty={!!shownCopy?.dirty} onSave={shownCopy ? () => void saveWorkingCopy(tabId) : undefined} />
      <DiffToolbar
        target={shown}
        canDiff={canDiff}
        canStep={textDiff}
        textTools={!imageDiff || svgSource}
        binary={!!loaded && (isHex(shown, loaded) || hexImage)}
        rendered={renderedDiff}
        leading={<OpenInButton target={shown} line={openLine} />}
        staging={isWipKey(shown.key) ? <WipStagingUndo /> : null}
        history={<HistoryButtons target={shown} binary={!!loaded && !!(loaded.old?.binary || loaded.new?.binary)} />}
        markdown={markdownToggle}
      />
      <div className="diff-body">
        <Body target={body.target} contents={body.contents} forced={forced} banner={shown.key === body.target.key} onLoadAnyway={() => setForcedKey(`${session}|${body.target.key}`)} onShown={onShown} onSourceChange={(on) => setSourceOf(on ? body.target.key : null)} onHex={(key, hex) => setBodyHex({ key, hex })} editable={editable} onEdit={onEdit} draft={bodyCopy?.draft} />
      </div>
    </section>
  );
}
