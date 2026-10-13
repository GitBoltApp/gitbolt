import { useEffect, useMemo, useRef } from 'react';
import { api, errorMessage } from '../api/client';
import { listWorktree, openVersion, useOpeners, worktreeOf, type OpenInTarget } from '../openIn/openers';
import { openWorktree, useRepoView, type DiffTarget } from '../repo/store';
import { disarm } from '../ui/arm/store';
import { useToast } from '../ui/toastStore';
import { usePageAssets, type PageSource } from './htmlAssets';
import { pageNote, pageSrcdoc, readPage, type InlinedAssets, type Page, type PageExternals } from './pageDoc';

/**
 * "Open in browser" for a page (its new side, or the old one): the system's Open With chooser,
 * where a browser is picked, on the file itself in a worktree list, else a read-only copy of the
 * version shown (as Open in… does). `null` where this OS has no chooser: the header's Open in…
 * stays. It isn't remembered as the Open in… default.
 */
export function useOpenPage(target: DiffTarget | null, side: 'old' | 'new'): (() => void) | null {
  const repo = useRepoView((s) => s.repo);
  const openTree = useRepoView(openWorktree);
  const chooser = useOpeners()?.find((o) => o.kind === 'chooser') ?? null;
  const toast = useToast((s) => s.show);
  if (!target || !chooser) return null;
  const worktree = listWorktree(target.key) ?? worktreeOf(target);
  const version = side === 'old' ? { source: target.old, fallback: null } : openVersion(target, worktree);
  const t: OpenInTarget = { worktree: worktree ?? openTree, path: side === 'old' ? target.oldPath ?? target.path : target.path, line: null, ...version };
  return () => {
    api.openIn(repo, { worktree: t.worktree, path: t.path, line: null, opener: chooser.id, source: t.source, fallback: t.fallback }).catch((e: unknown) => toast(errorMessage(e)));
  };
}

/** The bar above a page that uses what doesn't show here (external files, scripts, its own
 * files left out). */
export function PageBar({ ext, omitted = 0, onOpen }: { ext: PageExternals; omitted?: number; onOpen: (() => void) | null }) {
  const note = pageNote(ext, omitted);
  if (note === null) return null;
  return (
    <div role="note" className="diff-banner html-page-bar">
      <span>{note}</span>
      {onOpen && <button type="button" className="text-button" onClick={onOpen}>Open in browser</button>}
    </div>
  );
}

/**
 * The page in a sandboxed frame (`pageDoc.ts`): no scripts, no same origin, no forms, popups or
 * navigation of the app, its content through `srcdoc`, with `assets` inlined ("Loading…" while
 * they're `null`).
 */
export function PageFrame({ page, assets, title }: { page: Page; assets: InlinedAssets | null; title: string }) {
  const srcdoc = useMemo(() => (assets ? pageSrcdoc(page, assets) : null), [page, assets]);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => (srcdoc === null ? undefined : giveFocusBack(() => frame.current)), [srcdoc]);
  if (srcdoc === null) return <div className="diff-message" aria-busy="true">Loading…</div>;
  return <iframe ref={frame} className="html-frame" title={title} sandbox="" referrerPolicy="no-referrer" tabIndex={-1} srcDoc={srcdoc} />;
}

/**
 * A click in the page puts the keyboard in the frame, where the app's keys (Esc, Ctrl+W, the
 * shortcuts) never arrive: no script runs there to pass them on. So when the frame takes focus
 * (the window blurs with it the active element), an armed control disarms, as a click elsewhere
 * does, and focus goes back to the rendered pane (`.html-rendered`, `tabIndex=-1`) on the next
 * task: Chromium ignores a focus moved during the blur itself. The wheel still scrolls the page;
 * keyboard scrolling and copying inside it don't (the toggle's tooltip says so).
 */
export function giveFocusBack(frame: () => HTMLIFrameElement | null): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onBlur = () => {
    const el = frame();
    if (!el || document.activeElement !== el) return;
    disarm();
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (document.activeElement !== el) return;
      const pane = el.closest<HTMLElement>('.html-rendered');
      if (pane) pane.focus({ preventScroll: true });
      else el.blur();
    }, 0);
  };
  window.addEventListener('blur', onBlur);
  return () => { clearTimeout(timer); window.removeEventListener('blur', onBlur); };
}

/** File View's rendered HTML file: the page, parsed once per text, its relative files read from
 * `source`'s commit, and the bar (shown with the page, once those are in). */
export function HtmlPage({ text, source, target, path }: { text: string; source: PageSource | null; target: DiffTarget | null; path: string }) {
  const page = useMemo(() => readPage(text), [text]);
  const assets = usePageAssets(page, source);
  const open = useOpenPage(target, 'new');
  return (
    <>
      {assets && <PageBar ext={page.externals} omitted={assets.omitted} onOpen={open} />}
      <PageFrame page={page} assets={assets} title={path} />
    </>
  );
}

/** Both sides' externals in one bar: every host once, in order. */
export function mergeExternals(a: PageExternals, b: PageExternals): PageExternals {
  return { hosts: [...new Set([...a.hosts, ...b.hosts])], scripts: a.scripts || b.scripts };
}

const NO_EXTERNALS: PageExternals = { hosts: [], scripts: false };

/**
 * Diff View's rendered HTML diff: the old and new pages side by side, one bar above both
 * (opening the new side, or the old one when the file was deleted). A side the change doesn't
 * have (an added or a deleted file) says so in its column.
 */
export function HtmlDiff({ old, neu, oldSource, newSource, target, path, oldPath }: {
  old: string | null;
  neu: string | null;
  oldSource: PageSource | null;
  newSource: PageSource | null;
  target: DiffTarget | null;
  path: string;
  oldPath: string | null;
}) {
  const oldPage = useMemo(() => (old === null ? null : readPage(old)), [old]);
  const newPage = useMemo(() => (neu === null ? null : readPage(neu)), [neu]);
  const oldAssets = usePageAssets(oldPage, oldSource);
  const newAssets = usePageAssets(newPage, newSource);
  const ext = useMemo(() => mergeExternals(oldPage?.externals ?? NO_EXTERNALS, newPage?.externals ?? NO_EXTERNALS), [oldPage, newPage]);
  const open = useOpenPage(target, neu === null ? 'old' : 'new');
  return (
    <>
      {oldAssets && newAssets && <PageBar ext={ext} omitted={(oldAssets.omitted ?? 0) + (newAssets.omitted ?? 0)} onOpen={open} />}
      <div className="html-diff">
        <div className="html-diff-side" data-side="old">
          {oldPage === null ? <div className="diff-message dim">No old version</div> : <PageFrame page={oldPage} assets={oldAssets} title={`${oldPath ?? path} (old)`} />}
        </div>
        <div className="html-diff-side" data-side="new">
          {newPage === null ? <div className="diff-message dim">No new version</div> : <PageFrame page={newPage} assets={newAssets} title={`${path} (new)`} />}
        </div>
      </div>
    </>
  );
}
