import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRepoContext } from '../app/repoContext';
import { forgeOf } from '../forge/mrStore';
import { MarkdownDiff } from '../markdown/lazy';
import type { FileMarkdownContext } from '../markdown/types';
import { setChangeStepper, stepChange } from './changeStepper';
import { useDiffPrefs } from './diffPrefs';
import type { DiffSides } from './markdownDiffSides';
import { HtmlDiff } from './HtmlPage';
import { markSlow, PRECHECK_BYTES, renderedKindOf, TOO_LARGE_TO_RENDER, useDiffTooLarge } from './markdownFiles';
import { MdDiffFrame } from './MdDiffRuler';
import { holdFirstChange, holdLine } from './mdOpen';
import { useNarrowPane } from './narrowPane';
import { MdFontPx } from '../markdown/fontPx';
import { editorFontVar, useEditorFontPx } from './fontZoom';
import { clearMarkdownOverride, markdownViewOf, showSourceFor, useMarkdownOverride, useMarkdownView } from './markdownOverride';
import type { DiffLine, HunkZoneRequest } from './monaco/host';
import { useParseBudget } from './parseBudget';
import { RenderedReview, RenderedReviewNote } from './review/RenderedReview';
import { loadedHost, TextDiff } from './TextDiff';
import { CsvTableDiff } from '../table/CsvTable';
import { useForgetTables, type Delimiter } from '../table/csv';
import { tableDiffOf } from '../table/rowDiff';
import { usePublishTableStatus } from '../table/tableStatus';
import type { DiffTarget } from '../repo/store';

/**
 * Diff View's text body (5C). Every text diff sits in the same box (`.file-source`, as File View's
 * `FileBody`), so moving between a Markdown file and another never re-attaches the editor. For a
 * Markdown file (`markdown`: its sides' commits), the app-wide `markdownView` (R2) shows the
 * rendered diff in the editor's place while Rendered. The editor stays attached, hidden (R8): a
 * WIP file's unsaved edits stay in it (Ctrl+S saves them) and Rendered shows them; editing
 * happens in Source only. `after`: what follows the editor in Source only (a WIP diff's hunk
 * actions). Over 5 MB a side, a diff over 2 s, or one that gave up (its alignment ran out of time,
 * at any size), it's Source with "Too large to render" (R14), and the file stays in Source.
 * An HTML file (`markdown` holds its sides' commits too) shows its old and new pages side by side
 * (`HtmlDiff`), static and sandboxed; `target`: the diff shown, for which sides it has and its
 * Open in browser. A CSV or TSV file (`table`) shows its table diff the same way, lined up by row;
 * over 50,000 rows a side it's Source with a note.
 */
export function DiffTextBody({ identity, path, oldPath, original, modified, language, line, onShown, editable = false, onEdit, hunkZones, after, markdown, target = null, table = null }: {
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
  target?: DiffTarget | null;
  /** A CSV or TSV diff's delimiter: while Rendered (Table), the table diff in the editor's place,
   * or Source with a note when it's too large to line up (`tableDiffOf`). */
  table?: Delimiter | null;
}) {
  const { tabId } = useRepoContext();
  const isMd = markdown !== null;
  // A rename between a Markdown and an HTML name renders as its new name says.
  const html = isMd && renderedKindOf({ path, oldPath }) === 'html';
  const renders = isMd || table !== null;
  const picked = useMarkdownView(renders ? path : null);
  // Another file shown ends a just-created file's Source, as in File View (markdownOverride.ts).
  useEffect(() => { const over = useMarkdownOverride.getState().path; if (over !== null && over !== path) clearMarkdownOverride(); }, [path]);
  // Lines asked for show in Source: a table diff has no lines (a review badge, a note's file:line).
  useLayoutEffect(() => { if (table !== null && line) showSourceFor(path); }, [line]); // eslint-disable-line react-hooks/exhaustive-deps
  // The editable side as Rendered was picked, when it held unsaved edits.
  const kept = useRef<{ identity: string; buffer: string } | null>(null);
  const shownNew = kept.current?.identity === identity ? kept.current.buffer : modified;
  const { tooLarge, key: renderKey } = useDiffTooLarge(identity, isMd ? original : '', isMd ? shownNew : '');
  const rendered = isMd && picked === 'rendered' && !tooLarge;
  const flavor = forgeOf(tabId).kind === 'gitlab' ? 'gitlab' : 'github';
  const onTooLarge = useCallback(() => markSlow(renderKey), [renderKey]);
  const waiting = useParseBudget(
    renderKey,
    rendered && !html && original.length + shownNew.length > PRECHECK_BYTES,
    () => import('../markdown/parseAsync').then((m) => () => m.diffChunkStream(original, shownNew, flavor)),
  );
  const loaded = useRef(modified);
  loaded.current = modified;
  useEffect(() => {
    if (!renders) return;
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
  }, [renders, editable, identity, path]);
  const tableDiff = useMemo(() => (table !== null && picked === 'rendered' ? tableDiffOf(original, shownNew, table) : null), [table, picked, original, shownNew]);
  const tabled = tableDiff?.diff != null;
  useForgetTables(table !== null ? original : '', table !== null ? shownNew : '');
  // The toolbar goes by this one result (the text shown, unsaved edits included).
  usePublishTableStatus(identity, tableDiff ? tableDiff.note : undefined);
  const away = rendered || tabled;
  // Back to Source: the editor lays out in its box again; a later Rendered snapshots afresh.
  useLayoutEffect(() => {
    if (away) return;
    kept.current = null;
    loadedHost()?.layout();
  }, [away]);
  const pane = useRef<HTMLDivElement>(null);
  // The pane as state too: `RenderedReview` inside it reads it in its own effects, which run
  // before a parent's ref is set (review comments, spec 2026-10-08 §3).
  const [paneEl, setPaneEl] = useState<HTMLDivElement | null>(null);
  const paneRef = useCallback((el: HTMLDivElement | null) => { pane.current = el; setPaneEl(el); }, []);
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
  // asked for (a note's `file:line`) opens at its block instead (`holdLine`), each time one is.
  // "Each time" is by reference: `line` is the diff target's own (`DiffTarget.line`), the same
  // object across re-renders and refreshes, and a new one only when a line is asked for again.
  const opened = useRef<DiffLine | string | null>(null);
  useLayoutEffect(() => {
    if (!rendered || html) { opened.current = null; return; }
    const want = line ?? identity;
    if (opened.current === want) return;
    opened.current = want;
    if (!pane.current) return;
    return line ? holdLine(pane.current, line) : holdFirstChange(pane.current);
  }, [rendered, html, identity, line]);
  // R3: Previous/Next change (and F7) step through the rendered changes.
  useEffect(() => (rendered && !html ? setChangeStepper((dir) => { if (pane.current) stepChange(pane.current, dir); }) : undefined), [rendered, html]);
  // The diff mode applies (5C): Split shows it side by side, unless the pane is too narrow.
  const splitPicked = useDiffPrefs((s) => s.prefs.mode === 'split');
  const fontPx = useEditorFontPx();
  const narrow = useNarrowPane(pane, rendered && !html && splitPicked);
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
      {tableDiff?.note && <div role="note" className="diff-banner">{tableDiff.note}</div>}
      <div className="file-source" hidden={away} data-font-zoom="">
        <TextDiff identity={identity} path={path} original={original} modified={modified} language={language} line={line} onShown={onShown} editable={editable} onEdit={onEdit} hunkZones={hunkZones} />
      </div>
      {!away && after}
      {tableDiff?.diff && <CsvTableDiff key={identity} diff={tableDiff.diff} fontPx={fontPx} />}
      {html && (
        <div className="html-rendered" hidden={!rendered} data-testid="html-diff" tabIndex={-1}>
          {rendered && (
            <HtmlDiff
              old={target?.old.kind === 'absent' ? null : original} neu={target?.new.kind === 'absent' ? null : shownNew}
              oldSource={ctx?.old ?? null} newSource={ctx?.new ?? null}
              target={target} path={path} oldPath={oldPath}
            />
          )}
        </div>
      )}
      {isMd && !html && (
        <MdDiffFrame pane={pane} active={rendered} split={splitPicked && !narrow} after={rendered && <RenderedReviewNote tabId={tabId} path={path} />}>
          <div ref={paneRef} className="md-rendered md-diff-pane" hidden={!rendered} data-testid="markdown-diff" tabIndex={-1} data-font-zoom="" style={editorFontVar(fontPx)}>
            {rendered && ctx && (waiting
              ? <div className="diff-message" aria-busy="true">Rendering…</div>
              : (
                <Suspense fallback={<div className="diff-message" aria-busy="true">Loading…</div>}>
                  <MdFontPx value={fontPx}>
                    <RenderedReview tabId={tabId} path={path} pane={paneEl} modified={shownNew}>
                      <MarkdownDiff old={original} new={shownNew} flavor={flavor} context={ctx.new} oldContext={ctx.old} split={splitPicked && !narrow} onTooLarge={onTooLarge} />
                    </RenderedReview>
                  </MdFontPx>
                </Suspense>
              ))}
          </div>
        </MdDiffFrame>
      )}
    </>
  );
}
