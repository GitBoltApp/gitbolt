import { Suspense, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useRepoContext } from '../app/repoContext';
import { forgeOf } from '../forge/mrStore';
import { Markdown } from '../markdown/lazy';
import type { MarkdownContext } from '../markdown/types';
import type { FileCommit } from '../nav/history';
import { useScrollPlace } from '../nav/scroll';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useDiffPrefs, type MarkdownView } from './diffPrefs';
import { FileView } from './FileView';
import type { DiffLine, MonacoHost } from './monaco/host';
import { isHtmlPath, PRECHECK_BYTES, type ViewKind, renderKey, TOO_LARGE_TO_RENDER, useTooLargeToRender } from './markdownFiles';
import { HtmlPage } from './HtmlPage';
import type { DiffTarget } from '../repo/store';
import { useParseBudget } from './parseBudget';
import { loadedHost } from './TextDiff';
// --- 5B T6: relative links and images in File View's Markdown (registered with the renderer) ---
import '../markdown/fileLinks';
import { MdFontPx } from '../markdown/fontPx';
import { editorFontVar, useEditorFontPx } from './fontZoom';
import { clearMarkdownOverride, markdownViewOf, pickViewFor, showSourceFor, useMarkdownOverride, useMarkdownView } from './markdownOverride';
import { CsvTable } from '../table/CsvTable';
import type { Delimiter } from '../table/csv';
import { usePublishTableStatus } from '../table/tableStatus';
import { fileTableOf } from '../table/limits';
// --- end 5B T6 ---

type ViewState = ReturnType<MonacoHost['fileViewState']>;

/** Rendered's tooltip for an HTML file: a static preview, and the keyboard stays with the app. */
export const HTML_RENDERED_TIP = "A static preview: scripts don't run, and the keyboard stays with GitVolt (scroll the page with the mouse wheel)";

const VIEW_LABELS: Record<ViewKind, string> = { markdown: 'Markdown view', html: 'HTML view', table: 'Table view' };

/** Spec #5 §3.3: `Source | Rendered`, in the diff toolbar for a Markdown (or HTML) file. The
 * pick is the app-wide `markdownView` (`htmlView` for an HTML file; a just-created file shows Source on its own until this is
 * used: `markdownOverride.ts`). `forced`: why Rendered can't be picked (§3.1). `kind`: an HTML
 * page's Rendered says what its static preview leaves out (`giveFocusBack`). A CSV or TSV file's
 * (`kind` table) is `Source | Table`, on its own app-wide pick (`tableView`). */
export function MarkdownViewToggle({ path = null, forced = null, kind = 'markdown' }: { path?: string | null; forced?: string | null; kind?: ViewKind }) {
  const view = useMarkdownView(path);
  const source = view === 'source' || forced !== null;
  const pick = (v: MarkdownView) => pickViewFor(path, v);
  const tip = forced ?? (kind === 'html' ? HTML_RENDERED_TIP : null);
  return (
    <div className="segmented" role="group" aria-label={VIEW_LABELS[kind]}>
      <button type="button" aria-pressed={source} onClick={() => pick('source')}>Source</button>
      {/* `aria-disabled`, so the tooltip still shows on hover. */}
      <HoverTooltip content={tip ?? ''} disabled={tip === null}>
        <button type="button" aria-pressed={!source} aria-disabled={forced !== null ? 'true' : undefined} onClick={() => { if (forced === null) pick('rendered'); }}>{kind === 'table' ? 'Table' : 'Rendered'}</button>
      </HoverTooltip>
    </div>
  );
}

/**
 * File View's text body: the shared editor (`FileView`), and for a Markdown file with a commit
 * to resolve its links against (`markdown`), the rendered view in its place while
 * `markdownView` is Rendered (spec #5 §3.3); for a CSV or TSV file (`table`), its table. The
 * editor's box keeps its place in the tree, so
 * moving between a Markdown file and another never re-attaches the editor. Under Rendered it
 * stays attached, hidden: the working copy's unsaved edits stay in it (Ctrl+S saves them), and
 * Source comes back at the cursor and scroll it had. Rendered shows that buffer, unsaved edits
 * included; editing happens in Source only. An HTML file's rendered view is its page
 * (`HtmlPage`), static and sandboxed; `target`: the file shown, which its Open in browser opens.
 */
export function FileBody({ identity, path, text, language, onShown, editable = false, onEdit, navKey, markdown, table = null, line, target = null }: {
  identity: string;
  path: string;
  text: string;
  language: string;
  onShown?: () => void;
  editable?: boolean;
  onEdit?: () => void;
  /** The navigation place shown (`filePlaceKey`), for its scroll. */
  navKey: string | null;
  markdown: { commit: FileCommit } | null;
  /** A CSV or TSV file's delimiter: its table shows in the editor's place while Rendered (Table). */
  table?: Delimiter | null;
  /** Lines asked for (`DiffTarget.line`), shown in Source. */
  line?: DiffLine;
  target?: DiffTarget | null;
}) {
  const { tabId } = useRepoContext();
  const picked = useMarkdownView(path);
  // Another file shown ends a just-created file's Source (markdownOverride.ts).
  useEffect(() => { const over = useMarkdownOverride.getState().path; if (over !== null && over !== path) clearMarkdownOverride(); }, [path]);
  // Lines asked for show in Source: a table has no lines (from anywhere: a review badge, a link).
  useLayoutEffect(() => { if (table !== null && line) showSourceFor(path); }, [line]); // eslint-disable-line react-hooks/exhaustive-deps
  const pane = useRef<HTMLDivElement>(null);
  // The editor as Rendered was picked: its cursor and scroll, and the working copy's buffer.
  const kept = useRef<{ identity: string; view: ViewState; buffer: string | null } | null>(null);
  const shownText = kept.current?.identity === identity && kept.current.buffer !== null ? kept.current.buffer : text;
  const flavor = forgeOf(tabId).kind === 'gitlab' ? 'gitlab' : 'github';
  // §3.1: over 5 MB, or a parse over 2 s, File View shows Source with "Too large to render".
  const wantsRendered = markdown !== null && picked === 'rendered';
  const tooLarge = useTooLargeToRender(navKey, shownText);
  const rendered = wantsRendered && !tooLarge;
  // A table too large for the main thread, or too tall for a grid, shows Source with a note.
  const fontPx = useEditorFontPx();
  const fileTable = useMemo(() => (table !== null && picked === 'rendered' ? fileTableOf(shownText, table, fontPx) : null), [table, picked, shownText, fontPx]);
  usePublishTableStatus(identity, fileTable ? fileTable.note : undefined);
  const away = rendered || !!fileTable?.table;
  // §3.1: a long file is parsed once, off the main thread, timed once (`useParseBudget`).
  const key = renderKey(navKey, shownText);
  const html = isHtmlPath(path);
  const needsCheck = rendered && !html && shownText.length > PRECHECK_BYTES;
  const waiting = useParseBudget(key, needsCheck, () => import('../markdown/parseAsync').then((m) => () => m.chunkStream(shownText, flavor, true)));
  const fileText = useRef(text);
  fileText.current = text;
  useEffect(() => {
    // Source → Rendered for this file: the app-wide pick, or the end of its just-created Source.
    const was = { view: markdownViewOf(path) };
    const check = () => {
      const now = markdownViewOf(path);
      const flipped = was.view === 'source' && now === 'rendered';
      was.view = now;
      if (flipped) keep();
    };
    const offPrefs = useDiffPrefs.subscribe(check);
    const offOver = useMarkdownOverride.subscribe(check);
    return () => { offPrefs(); offOver(); };
  }, [editable, identity, path]); // eslint-disable-line react-hooks/exhaustive-deps
  function keep() {
    const h = loadedHost();
    // The buffer only when it holds unsaved edits: otherwise Rendered follows the file on disk.
    const buffer = editable ? h?.fileText(identity) ?? null : null;
    kept.current = { identity, view: h?.fileViewState() ?? null, buffer: buffer !== fileText.current ? buffer : null };
  }
  // Back to Source: the cursor and scroll as they were.
  useLayoutEffect(() => {
    if (away) return;
    const k = kept.current;
    kept.current = null;
    const h = loadedHost();
    if (!h || !k?.view || k.identity !== identity) return;
    h.layout();
    h.restoreFileViewState(k.view);
  }, [away]); // eslint-disable-line react-hooks/exhaustive-deps
  useScrollPlace({ tabId, kind: 'file', key: navKey, el: () => pane.current, active: rendered && !html, ready: rendered && !waiting, view: 'rendered', blocks: true });
  const commit = markdown?.commit ?? null;
  const context = useMemo<MarkdownContext | null>(() => (commit === null ? null : { kind: 'file', tabId, commit, path }), [tabId, commit, path]);
  return (
    <>
      {wantsRendered && tooLarge && <div role="note" className="diff-banner">{TOO_LARGE_TO_RENDER}</div>}
      <div className="file-source" hidden={away} data-font-zoom="">
        <FileView identity={identity} path={path} text={text} language={language} onShown={onShown} editable={editable} onEdit={onEdit} navKey={navKey} line={line} />
      </div>
      {fileTable?.note && <div role="note" className="diff-banner">{fileTable.note}</div>}
      {fileTable?.table && <CsvTable key={identity} text={shownText} table={fileTable.table} fontPx={fontPx} />}
      {markdown && html && (
        <div className="html-rendered" hidden={!rendered} data-testid="html-file" tabIndex={-1}>
          {rendered && <HtmlPage text={shownText} source={{ tabId, commit: markdown.commit, path }} target={target} path={path} />}
        </div>
      )}
      {markdown && !html && (
        <div ref={pane} className="md-rendered" hidden={!rendered} data-testid="markdown-file" tabIndex={-1} data-font-zoom="" style={editorFontVar(fontPx)}>
          {rendered && context && (waiting
            ? <div className="diff-message" aria-busy="true">Rendering…</div>
            : (
              <Suspense fallback={<div className="diff-message" aria-busy="true">Loading…</div>}>
                <MdFontPx value={fontPx}><Markdown text={shownText} flavor={flavor} context={context} /></MdFontPx>
              </Suspense>
            ))}
        </div>
      )}
    </>
  );
}
