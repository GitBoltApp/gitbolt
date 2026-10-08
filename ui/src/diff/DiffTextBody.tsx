import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { useRepoContext } from '../app/repoContext';
import { forgeOf } from '../forge/mrStore';
import { MarkdownDiff } from '../markdown/lazy';
import type { FileMarkdownContext } from '../markdown/types';
import { setChangeStepper, stepChange } from './changeStepper';
import { useDiffPrefs } from './diffPrefs';
import type { DiffSides } from './markdownDiffSides';
import { markSlow, PRECHECK_BYTES, TOO_LARGE_TO_RENDER, useDiffTooLarge } from './markdownFiles';
import { MdDiffFrame } from './MdDiffRuler';
import { holdFirstChange } from './mdOpen';
import { useNarrowPane } from './narrowPane';
import { MdFontPx } from '../markdown/fontPx';
import { editorFontVar, useEditorFontPx } from './fontZoom';
import { clearMarkdownOverride, markdownViewOf, useMarkdownOverride, useMarkdownView } from './markdownOverride';
import type { DiffLine, HunkZoneRequest } from './monaco/host';
import { useParseBudget } from './parseBudget';
import { loadedHost, TextDiff } from './TextDiff';

/**
 * Diff View's text body (5C). Every text diff sits in the same box (`.file-source`, as File View's
 * `FileBody`), so moving between a Markdown file and another never re-attaches the editor. For a
 * Markdown file (`markdown`: its sides' commits), the app-wide `markdownView` (R2) shows the
 * rendered diff in the editor's place while Rendered. The editor stays attached, hidden (R8): a
 * WIP file's unsaved edits stay in it (Ctrl+S saves them) and Rendered shows them; editing
 * happens in Source only. `after`: what follows the editor in Source only (a WIP diff's hunk
 * actions). Over 5 MB a side, a diff over 2 s, or one that gave up (its alignment ran out of time,
 * at any size), it's Source with "Too large to render" (R14), and the file stays in Source.
 */
export function DiffTextBody({ identity, path, oldPath, original, modified, language, line, onShown, editable = false, onEdit, hunkZones, after, markdown }: {
  identity: string;
  path: string;
  oldPath: string | null;
  original: string;
  modified: string;
  language: string;
  line?: DiffLine;
  onShown?: () => void;
  editable?: boolean;
  onEdit?: () => void;
  hunkZones?: () => HunkZoneRequest | undefined;
  after?: ReactNode;
  markdown: DiffSides | null;
}) {
  const { tabId } = useRepoContext();
  const isMd = markdown !== null;
  const picked = useMarkdownView(isMd ? path : null);
  // Another file shown ends a just-created file's Source, as in File View (markdownOverride.ts).
  useEffect(() => { const over = useMarkdownOverride.getState().path; if (over !== null && over !== path) clearMarkdownOverride(); }, [path]);
  // The editable side as Rendered was picked, when it held unsaved edits.
  const kept = useRef<{ identity: string; buffer: string } | null>(null);
  const shownNew = kept.current?.identity === identity ? kept.current.buffer : modified;
  const { tooLarge, key: renderKey } = useDiffTooLarge(identity, isMd ? original : '', isMd ? shownNew : '');
  const rendered = isMd && picked === 'rendered' && !tooLarge;
  const flavor = forgeOf(tabId).kind === 'gitlab' ? 'gitlab' : 'github';
  const onTooLarge = useCallback(() => markSlow(renderKey), [renderKey]);
  const waiting = useParseBudget(
    renderKey,
    rendered && original.length + shownNew.length > PRECHECK_BYTES,
    () => import('../markdown/parseAsync').then((m) => () => m.diffChunkStream(original, shownNew, flavor)),
  );
  const loaded = useRef(modified);
  loaded.current = modified;
  useEffect(() => {
    if (!isMd) return;
    // Source → Rendered for this file: the app-wide pick, or the end of its just-created Source.
    const was = { view: markdownViewOf(path) };
    const check = () => {
      const now = markdownViewOf(path);
      if (was.view === 'source' && now === 'rendered') {
        const buffer = editable ? loadedHost()?.modifiedText(identity) ?? null : null;
        kept.current = buffer !== null && buffer !== loaded.current ? { identity, buffer } : null;
      }
      was.view = now;
    };
    const offPrefs = useDiffPrefs.subscribe(check);
    const offOver = useMarkdownOverride.subscribe(check);
    return () => { offPrefs(); offOver(); };
  }, [isMd, editable, identity, path]);
  // Back to Source: the editor lays out in its box again; a later Rendered snapshots afresh.
  useLayoutEffect(() => {
    if (rendered) return;
    kept.current = null;
    loadedHost()?.layout();
  }, [rendered]);
  const pane = useRef<HTMLDivElement>(null);
  // Another file's diff starts at its top: the pane stays mounted from file to file. The rendered
  // diff isn't a navigation place (R15), so no back/forward scroll restore relies on it; the same
  // file shown again (a refresh, an edit) keeps its place.
  const paneFile = useRef(identity);
  useLayoutEffect(() => {
    if (paneFile.current === identity) return;
    paneFile.current = identity;
    if (pane.current) pane.current.scrollTop = 0;
  }, [identity]);
  // A file's rendered diff opens at its first change, as the source diff does (`holdFirstChange`):
  // once per file shown (or per switch to Rendered), never on a refresh or an edit of it. A line
  // asked for (a note's `file:line`) wins: the open leaves the pane where it is.
  const opened = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!rendered) { opened.current = null; return; }
    if (opened.current === identity) return;
    opened.current = identity;
    if (line || !pane.current) return;
    return holdFirstChange(pane.current);
  }, [rendered, identity, line]);
  // R3: Previous/Next change (and F7) step through the rendered changes.
  useEffect(() => (rendered ? setChangeStepper((dir) => { if (pane.current) stepChange(pane.current, dir); }) : undefined), [rendered]);
  // The diff mode applies (5C): Split shows it side by side, unless the pane is too narrow.
  const splitPicked = useDiffPrefs((s) => s.prefs.mode === 'split');
  const fontPx = useEditorFontPx();
  const narrow = useNarrowPane(pane, rendered && splitPicked);
  const oldSide = markdown?.old ?? null;
  const newSide = markdown?.new ?? null;
  const ctx = useMemo<{ new: FileMarkdownContext; old: FileMarkdownContext } | null>(() => (isMd
    ? {
      new: { kind: 'file', tabId, commit: newSide ?? oldSide ?? 'worktree', path },
      old: { kind: 'file', tabId, commit: oldSide ?? newSide ?? 'worktree', path: oldPath ?? path },
    }
    : null), [isMd, tabId, oldSide, newSide, path, oldPath]);
  return (
    <>
      {isMd && picked === 'rendered' && tooLarge && <div role="note" className="diff-banner">{TOO_LARGE_TO_RENDER}</div>}
      <div className="file-source" hidden={rendered} data-font-zoom="">
        <TextDiff identity={identity} path={path} original={original} modified={modified} language={language} line={line} onShown={onShown} editable={editable} onEdit={onEdit} hunkZones={hunkZones} />
      </div>
      {!rendered && after}
      {isMd && (
        <MdDiffFrame pane={pane} active={rendered} split={splitPicked && !narrow}>
          <div ref={pane} className="md-rendered md-diff-pane" hidden={!rendered} data-testid="markdown-diff" tabIndex={-1} data-font-zoom="" style={editorFontVar(fontPx)}>
            {rendered && ctx && (waiting
              ? <div className="diff-message" aria-busy="true">Rendering…</div>
              : (
                <Suspense fallback={<div className="diff-message" aria-busy="true">Loading…</div>}>
                  <MdFontPx value={fontPx}><MarkdownDiff old={original} new={shownNew} flavor={flavor} context={ctx.new} oldContext={ctx.old} split={splitPicked && !narrow} onTooLarge={onTooLarge} /></MdFontPx>
                </Suspense>
              ))}
          </div>
        </MdDiffFrame>
      )}
    </>
  );
}
