import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { formatBytes } from '../diff/format';
import { ArrowGlyph } from '../ui/ArrowGlyph';
import { HoverTooltip } from '../ui/HoverTooltip';
import { nearestStepIndex, nextStepIndex, wheelAccumulator, ZOOM_STEPS } from '../image/zoom';
import { columnHeight, currentPage, fitWidthScale, PAGE_GAP, pageTops, syncedScrollTop, visiblePages, type PageSize } from './layout';
import { openPdf, PdfOpenError, type PdfDoc, type PdfPage, type PdfRender } from './pdfjs';
import { RulerFrame } from '../diff/RulerFrame';
import '../image/image.css';
import './pdf.css';

/** One side's PDF: its bytes (base64, as the backend sends them) and its size on disk. */
export interface PdfSource { base64: string; size: number }

type Loaded = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; doc: PdfDoc; sizes: PageSize[] };

/** How many pages' sizes are read at a time, after the first page's. */
const SIZE_BATCH = 64;

/** The bytes of a side's base64: natively (`Uint8Array.fromBase64`, in Chromium since 140)
 * where the engine has it, else through `atob`. Run in the open's effect, never during a render.
 * Exported for tests. */
export function decode(base64: string): Uint8Array {
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
  if (native) return native(base64);
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Opens `src`. The column has its full height at once: every page takes the first page's size
 * until its own is read, in batches (one render each), behind the first page's. */
function usePdf(src: PdfSource | null): Loaded | null {
  const [state, setState] = useState<Loaded | null>(null);
  useEffect(() => {
    if (!src) {
      setState(null);
      return;
    }
    setState({ status: 'loading' });
    let live = true;
    let opened: PdfDoc | null = null;
    // A slow open (a large PDF's parse) is stopped when the view moves on.
    const stop = new AbortController();
    openPdf(decode(src.base64), stop.signal)
      .then(async (doc) => {
        opened = doc;
        if (!live) return doc.destroy();
        const first = (await doc.page(1)).size;
        let sizes = Array.from({ length: doc.pages }, () => first);
        if (!live) return;
        setState({ status: 'ready', doc, sizes });
        for (let from = 2; from <= doc.pages && live; from += SIZE_BATCH) {
          const batch = await Promise.all(Array.from({ length: Math.min(SIZE_BATCH, doc.pages - from + 1) }, (_, i) => doc.page(from + i)));
          if (!live) return;
          sizes = sizes.slice();
          batch.forEach((p, i) => { sizes[from - 1 + i] = p.size; });
          setState({ status: 'ready', doc, sizes });
        }
      })
      .catch((e: unknown) => {
        if (live) setState({ status: 'error', message: e instanceof PdfOpenError ? e.message : "This PDF couldn't be opened" });
      });
    return () => {
      live = false;
      stop.abort();
      opened?.destroy();
    };
  }, [src]);
  return state;
}

/** One page near the view, drawn with its text; mounted only while it's near (the column keeps
 * every page's height), so a long PDF keeps a few canvases only. */
const Page = memo(function Page({ doc, n, size, scale, top }: { doc: PdfDoc; n: number; size: PageSize; scale: number; top: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const c = canvas.current;
    const t = text.current;
    if (!c || !t) return;
    let live = true;
    // The drawing, then the text: either one cancelled when the page goes or its zoom changes,
    // so a text layer never finishes into the next one's container.
    let running: PdfRender | null = null;
    void doc.page(n).then((page: PdfPage) => {
      if (!live) return;
      running = page.render(c, scale);
      return running.promise.then(() => {
        if (!live) return;
        running = page.text(t, scale);
        return running.promise;
      });
    }).catch(() => {});
    return () => {
      live = false;
      running?.cancel();
      t.replaceChildren();
    };
  }, [doc, n, scale]);
  const w = Math.round(size.w * scale);
  const h = Math.round(size.h * scale);
  return (
    <div className="pdf-page" style={{ top, width: w, height: h }}>
      <canvas ref={canvas} className="pdf-canvas" style={{ width: w, height: h }} aria-hidden="true" />
      <div ref={text} className="textLayer" />
    </div>
  );
});

/** The pane's right padding (pdf.css): with its scrollbar's gutter, the overview ruler's room. */
const PANE_PAD_PX = 20;

const sameRange = (a: number[], b: number[]) => a.length === b.length && a[0] === b[0];

/** A side's column of pages, scrolled on its own (and kept in step with the other side's). */
function Pane({ loaded, scale, label, paneRef, onScroll }: { loaded: Loaded; scale: number; label: string | null; paneRef: RefObject<HTMLDivElement | null>; onScroll: () => void }) {
  const sizes = useMemo(() => (loaded.status === 'ready' ? loaded.sizes : []), [loaded]);
  const tops = useMemo(() => pageTops(sizes, scale), [sizes, scale]);
  // The pages near the view: a new state only when that range changes, not on every scroll.
  const [drawn, setDrawn] = useState<number[]>([]);
  const measure = () => {
    const el = paneRef.current;
    if (!el) return;
    const next = visiblePages(sizes, scale, el.scrollTop, el.clientHeight);
    setDrawn((prev) => (sameRange(prev, next) ? prev : next));
  };
  useLayoutEffect(measure, [sizes, scale]); // eslint-disable-line react-hooks/exhaustive-deps
  // The observer outlives renders, so it calls the latest measure: WebKit delivers its first
  // callback after the pages' sizes arrive, and a stale one would draw none.
  const latest = useRef(measure);
  latest.current = measure;
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => latest.current());
    ro.observe(el);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const widest = Math.max(0, ...sizes.map((s) => s.w));
  return (
    <div className="pdf-side">
      <RulerFrame pane={paneRef}>
      <div
        ref={paneRef}
        className="pdf-pane"
        tabIndex={0}
        role="document"
        aria-label={label ? `${label} PDF` : 'PDF'}
        aria-busy={loaded.status === 'loading' || undefined}
        onScroll={() => { measure(); onScroll(); }}
      >
        {loaded.status === 'ready' && (
          <div className="pdf-column" style={{ height: columnHeight(sizes, scale), width: Math.round(widest * scale) + 2 * PAGE_GAP }}>
            {drawn.map((i) => <Page key={i} doc={loaded.doc} n={i + 1} size={sizes[i]} scale={scale} top={tops[i]} />)}
          </div>
        )}
        {loaded.status === 'loading' && <div className="pdf-message">Loading…</div>}
        {loaded.status === 'error' && <div className="pdf-message" role="alert">{loaded.message}</div>}
      </div>
      </RulerFrame>
      {label && <span className="image-label pdf-label">{label}</span>}
    </div>
  );
}

const pageCount = (l: Loaded | null) => (l?.status === 'ready' ? l.sizes.length : null);
const pagesText = (n: number | null) => (n === null ? '?' : `${n} ${n === 1 ? 'page' : 'pages'}`);

/**
 * A PDF's pages (File View), or its two versions side by side (Diff View), each side scrolled in
 * step with the other: page n beside page n. Both sides share one zoom: Fit width (the default,
 * kept on a resize), or a step of the image zoom's ladder (the slider, Ctrl+wheel). `single`: an
 * added or deleted PDF, its one side labelled. `source` (its hex dump) shows instead while its
 * toggle is on.
 */
export function PdfView({ old, new: neu, single = null, source, onSourceChange }: { old: PdfSource | null; new: PdfSource | null; single?: 'added' | 'deleted' | null; source?: ReactNode; onSourceChange?: (on: boolean) => void }) {
  const both = old !== null && neu !== null;
  const oldDoc = usePdf(old);
  const newDoc = usePdf(neu);
  const [showSource, setSource] = useState(false);
  const setShowSource = (on: boolean) => {
    setSource(on);
    onSourceChange?.(on);
  };
  const reportSource = useRef(onSourceChange);
  reportSource.current = onSourceChange;
  useEffect(() => () => reportSource.current?.(false), []);
  // null: Fit width.
  const [fixed, setFixed] = useState<number | null>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  const [page, setPage] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const oldPane = useRef<HTMLDivElement>(null);
  const newPane = useRef<HTMLDivElement>(null);
  const sizesOf = (l: Loaded | null): PageSize[] => (l?.status === 'ready' ? l.sizes : []);
  const oldSizes = useMemo(() => sizesOf(oldDoc), [oldDoc]);
  const newSizes = useMemo(() => sizesOf(newDoc), [newDoc]);
  const allSizes = useMemo(() => [...oldSizes, ...newSizes], [oldSizes, newSizes]);
  const scale = fixed ?? fitWidthScale(allSizes, paneWidth);

  // Scrolls we cause (the follower's, a zoom's), by pane: the scroll event each one fires is
  // ours, not the user's, and leads nothing. The value kept is the one the pane took, after the
  // browser clamped it to its own end; a scroll that changed nothing fires no event, so none is kept.
  const caused = useRef(new Map<HTMLDivElement, number>());
  const scrollPane = (pane: HTMLDivElement, top: number, left?: number) => {
    const before = pane.scrollTop;
    pane.scrollTop = top;
    if (left !== undefined) pane.scrollLeft = left;
    if (pane.scrollTop !== before) caused.current.set(pane, pane.scrollTop);
    else caused.current.delete(pane);
  };

  // A zoom keeps the page being read where it is (the same point down the same page).
  const lastScale = useRef(scale);
  useLayoutEffect(() => {
    const prev = lastScale.current;
    lastScale.current = scale;
    if (prev === scale) return;
    for (const [pane, sizes] of [[oldPane.current, oldSizes], [newPane.current, newSizes]] as const) {
      if (pane) scrollPane(pane, syncedScrollTop({ sizes, scale: prev }, { sizes, scale }, pane.scrollTop));
    }
  }, [scale, oldSizes, newSizes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each pane is half the stage (side by side) or all of it, less the ruler's room (pdf.css).
  const panes = !!oldDoc || !!newDoc;
  useEffect(() => {
    const pane = oldPane.current ?? newPane.current;
    if (!pane) return;
    const measure = () => setPaneWidth(pane.clientWidth - PANE_PAD_PX);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(pane);
    return () => ro.disconnect();
  }, [showSource, both, panes]);

  // Scroll sync: the pane the user scrolls leads; the other follows. The longer side scrolls on
  // past the shorter one's end, which stays at its end.
  const onScroll = (fromRef: RefObject<HTMLDivElement | null>, toRef: RefObject<HTMLDivElement | null>, fromSizes: PageSize[], toSizes: PageSize[]) => () => {
    const from = fromRef.current;
    const to = toRef.current;
    if (!from) return;
    const ours = caused.current.get(from);
    if (ours !== undefined) {
      caused.current.delete(from);
      if (Math.abs(from.scrollTop - ours) < 1) return;
    }
    setPage(currentPage(pageTops(fromSizes, scale), from.scrollTop, from.clientHeight));
    if (!to) return;
    const top = syncedScrollTop({ sizes: fromSizes, scale }, { sizes: toSizes, scale }, from.scrollTop);
    if (Math.abs(to.scrollTop - top) < 1 && to.scrollLeft === from.scrollLeft) return;
    scrollPane(to, top, from.scrollLeft);
  };

  // Ctrl+wheel steps the zoom (non-passive, or Chromium zooms the whole webview).
  const wheelStep = useMemo(wheelAccumulator, []);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: globalThis.WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const dir = wheelStep(e);
      if (dir !== 0) setFixed(ZOOM_STEPS[nextStepIndex(scaleRef.current, dir)]);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [showSource, wheelStep]);

  const counts = both ? <>{pagesText(pageCount(oldDoc))} <ArrowGlyph /> {pagesText(pageCount(newDoc))}</> : pagesText(pageCount(oldDoc ?? newDoc));
  const sizes = both ? <>{formatBytes(old.size)} <ArrowGlyph /> {formatBytes(neu.size)}</> : formatBytes((old ?? neu)?.size);
  const shown = pageCount(newDoc ?? oldDoc);
  const longest = Math.max(pageCount(oldDoc) ?? 0, pageCount(newDoc) ?? 0) || null;
  const metaText = `${shown ? `Page ${page + 1} · ` : ''}${both ? `${pagesText(pageCount(oldDoc))} → ${pagesText(pageCount(newDoc))} · ${formatBytes(old.size)} → ${formatBytes(neu.size)}` : `${pagesText(pageCount(oldDoc ?? newDoc))} · ${formatBytes((old ?? neu)?.size)}`}${single ? ` (${single})` : ''}`;
  const pct = Math.round(scale * 100);

  return (
    <div className="image-diff pdf-view">
      <div className="image-toolbar" role="toolbar" aria-label="PDF options">
        {source && <button type="button" className="toggle" aria-pressed={showSource} onClick={() => setShowSource(!showSource)}>Hex</button>}
        <div className="image-zoom">
          <button type="button" className="zoom-fit" aria-pressed={fixed === null} onClick={() => setFixed(null)}>Fit width</button>
          <input
            type="range"
            min={0}
            max={ZOOM_STEPS.length - 1}
            step={1}
            value={nearestStepIndex(scale)}
            aria-label="Zoom"
            aria-valuetext={`${pct}%`}
            disabled={showSource}
            onChange={(e) => setFixed(ZOOM_STEPS[Number(e.target.value)])}
            onDoubleClick={() => setFixed(1)}
          />
          <span className="zoom-value" data-testid="pdf-zoom">{pct}%</span>
        </div>
        <HoverTooltip content={metaText}>
          <span className="dim image-meta" data-testid="pdf-meta">
            {/* Its room is kept while the PDF opens, and holds the longest page number, so
                neither opening nor scrolling moves what follows. */}
            <span className="pdf-page-no" style={{ visibility: shown === null ? 'hidden' : undefined, minWidth: `${'Page '.length + String(longest ?? 1).length}ch` }}>
              <span data-testid="pdf-page">Page {page + 1}</span> <span className="meta-sep">·</span>{' '}
            </span>
            <span data-testid="pdf-pages">{counts}</span> <span className="meta-sep">·</span> <span>{sizes}</span>
            {single && <> ({single})</>}
          </span>
        </HoverTooltip>
      </div>
      {showSource && source ? (
        <div className="image-source">{source}</div>
      ) : (
        <div ref={stageRef} className="pdf-stage">
          {oldDoc && <Pane loaded={oldDoc} scale={scale} label={both ? 'Old' : null} paneRef={oldPane} onScroll={onScroll(oldPane, newPane, oldSizes, newSizes)} />}
          {both && <div className="side-divider" aria-hidden="true" />}
          {newDoc && <Pane loaded={newDoc} scale={scale} label={both ? 'New' : null} paneRef={newPane} onScroll={onScroll(newPane, oldPane, newSizes, oldSizes)} />}
        </div>
      )}
    </div>
  );
}
