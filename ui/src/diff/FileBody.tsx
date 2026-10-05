import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRepoContext } from '../app/repoContext';
import { forgeOf } from '../forge/mrStore';
import { Markdown } from '../markdown/lazy';
import type { MarkdownContext } from '../markdown/types';
import type { FileCommit } from '../nav/history';
import { useScrollPlace } from '../nav/scroll';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useDiffPrefs, type MarkdownView } from './diffPrefs';
import { FileView } from './FileView';
import type { MonacoHost } from './monaco/host';
import { markSlow, PARSE_BUDGET_MS, PRECHECK_BYTES, renderKey, TOO_LARGE_TO_RENDER, useTooLargeToRender } from './markdownFiles';
import { loadedHost } from './TextDiff';
// --- 5B T6: relative links and images in File View's Markdown (registered with the renderer) ---
import '../markdown/fileLinks';
import { clearMarkdownOverride, markdownViewOf, useMarkdownOverride, useMarkdownView } from './markdownOverride';
// --- end 5B T6 ---

type ViewState = ReturnType<MonacoHost['fileViewState']>;

/** Spec #5 §3.3: `Source | Rendered`, in the diff toolbar for a Markdown file in File View. The
 * pick is the app-wide `markdownView` (a just-created file shows Source on its own until this is
 * used: `markdownOverride.ts`). `forced`: why Rendered can't be picked (§3.1). */
export function MarkdownViewToggle({ path = null, forced = null }: { path?: string | null; forced?: string | null }) {
  const view = useMarkdownView(path);
  const set = useDiffPrefs((s) => s.set);
  const source = view === 'source' || forced !== null;
  const pick = (v: MarkdownView) => { clearMarkdownOverride(); set({ markdownView: v }); };
  return (
    <div className="segmented" role="group" aria-label="Markdown view">
      <button type="button" aria-pressed={source} onClick={() => pick('source')}>Source</button>
      {/* `aria-disabled`, so the tooltip still shows on hover. */}
      <HoverTooltip content={forced ?? ''} disabled={forced === null}>
        <button type="button" aria-pressed={!source} aria-disabled={forced !== null ? 'true' : undefined} onClick={() => { if (forced === null) pick('rendered'); }}>Rendered</button>
      </HoverTooltip>
    </div>
  );
}

/**
 * File View's text body: the shared editor (`FileView`), and for a Markdown file with a commit
 * to resolve its links against (`markdown`), the rendered view in its place while
 * `markdownView` is Rendered (spec #5 §3.3). The editor's box keeps its place in the tree, so
 * moving between a Markdown file and another never re-attaches the editor. Under Rendered it
 * stays attached, hidden: the working copy's unsaved edits stay in it (Ctrl+S saves them), and
 * Source comes back at the cursor and scroll it had. Rendered shows that buffer, unsaved edits
 * included; editing happens in Source only.
 */
export function FileBody({ identity, path, text, language, onShown, editable = false, onEdit, navKey, markdown }: {
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
}) {
  const { tabId } = useRepoContext();
  const picked = useMarkdownView(path);
  // Another file shown ends a just-created file's Source (markdownOverride.ts).
  useEffect(() => { const over = useMarkdownOverride.getState().path; if (over !== null && over !== path) clearMarkdownOverride(); }, [path]);
  const pane = useRef<HTMLDivElement>(null);
  // The editor as Rendered was picked: its cursor and scroll, and the working copy's buffer.
  const kept = useRef<{ identity: string; view: ViewState; buffer: string | null } | null>(null);
  const shownText = kept.current?.identity === identity && kept.current.buffer !== null ? kept.current.buffer : text;
  const flavor = forgeOf(tabId).kind === 'gitlab' ? 'gitlab' : 'github';
  // §3.1: over 5 MB, or a parse over 2 s, File View shows Source with "Too large to render".
  const wantsRendered = markdown !== null && picked === 'rendered';
  const tooLarge = useTooLargeToRender(navKey, shownText);
  const rendered = wantsRendered && !tooLarge;
  // A long file is parsed once, off the main thread (5A's `chunkStream`), timed from the post to
  // the last chunk, before it renders. The renderer asks `chunkStream` for the same text, so it
  // reuses these chunks (no second parse). One not done within the budget goes on the slow list
  // at the budget (a timer races the stream), as does one too large for the main thread (the
  // worker died); a result that arrives after the file changed is dropped.
  const key = renderKey(navKey, shownText);
  const needsCheck = rendered && shownText.length > PRECHECK_BYTES;
  const [checked, setChecked] = useState<string | null>(null);
  useEffect(() => {
    if (!needsCheck || checked === key) return;
    let live = true;
    let unsub = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    void import('../markdown/parseAsync').then(({ chunkStream }) => {
      if (!live) return;
      const t0 = performance.now();
      const stream = chunkStream(shownText, flavor);
      const finish = (late: boolean) => {
        unsub(); // a stream left with no subscriber mid-parse is abandoned: its worker stops (parseAsync)
        clearTimeout(timer);
        if (!live) return;
        if (late || stream.tooLarge || (!stream.failed && performance.now() - t0 > PARSE_BUDGET_MS)) markSlow(key);
        setChecked(key);
      };
      if (stream.done) finish(false);
      else {
        unsub = stream.subscribe(() => { if (stream.done) finish(false); });
        // Still parsing at the budget: Source now, not when the parse ends (a 1 MB file with
        // thousands of lists parses for many seconds).
        timer = setTimeout(() => finish(true), PARSE_BUDGET_MS);
      }
    });
    return () => { live = false; unsub(); clearTimeout(timer); };
  }, [needsCheck, checked, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = needsCheck && checked !== key;
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
    if (rendered) return;
    const k = kept.current;
    kept.current = null;
    const h = loadedHost();
    if (!h || !k?.view || k.identity !== identity) return;
    h.layout();
    h.restoreFileViewState(k.view);
  }, [rendered]); // eslint-disable-line react-hooks/exhaustive-deps
  useScrollPlace({ tabId, kind: 'file', key: navKey, el: () => pane.current, active: rendered, ready: rendered && !waiting, view: 'rendered', blocks: true });
  const commit = markdown?.commit ?? null;
  const context = useMemo<MarkdownContext | null>(() => (commit === null ? null : { kind: 'file', tabId, commit, path }), [tabId, commit, path]);
  return (
    <>
      {wantsRendered && tooLarge && <div role="note" className="diff-banner">{TOO_LARGE_TO_RENDER}</div>}
      <div className="file-source" hidden={rendered}>
        <FileView identity={identity} path={path} text={text} language={language} onShown={onShown} editable={editable} onEdit={onEdit} navKey={navKey} />
      </div>
      {markdown && (
        <div ref={pane} className="md-rendered" hidden={!rendered} data-testid="markdown-file" tabIndex={-1}>
          {rendered && context && (waiting
            ? <div className="diff-message" aria-busy="true">Rendering…</div>
            : (
              <Suspense fallback={<div className="diff-message" aria-busy="true">Loading…</div>}>
                <Markdown text={shownText} flavor={flavor} context={context} />
              </Suspense>
            ))}
        </div>
      )}
    </>
  );
}
