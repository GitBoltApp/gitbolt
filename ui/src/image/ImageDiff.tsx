import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { formatBytes } from '../diff/format';
import { HoverTooltip } from '../ui/HoverTooltip';
import { onResetDoubleClick } from '../ui/resetHandle';
import { IMAGE_BACKGROUNDS, useImageBackground } from './background';
import { openContextMenu } from '../menu/menuStore';
import { drawDifference } from './difference';
import { imageMenuRows, type ImageSide } from './imageMenu';
import { defaultMatch, matchedRect, rememberedMatch, rememberMatch, sizesDiffer, type Rect } from './matchSizes';
import type { ImageSource } from './sources';
import { centered, clampSwipe, clampView, DEFAULT_STEP, fitScale, nearestStepIndex, nextStepIndex, pixelated, startView, stepLabel, wheelAccumulator, ZOOM_STEPS, zoomAround, type View } from './zoom';
import { isWindowBlur, refocusWhenWindowReturns } from '../ui/windowBlur';
import './image.css';
import { ArrowGlyph } from '../ui/ArrowGlyph';
import { Scaling } from 'lucide-react';

const MATCH_TIP = "Match sizes: show the old image scaled to the new one's size";

export type ImageMode = 'side' | 'swipe' | 'onion' | 'difference';
interface Dim { w: number; h: number }
interface Decoded { dim: Dim | null; failed: boolean }

const MODES: [ImageMode, string][] = [['side', 'Side-by-side'], ['swipe', 'Swipe'], ['onion', 'Onion skin'], ['difference', 'Difference']];

/** Resolves to the decoded image, or null when it can't be decoded: it never stays pending. */
function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function useDecoded(src: ImageSource | null): Decoded {
  const [state, setState] = useState<Decoded>({ dim: null, failed: false });
  useEffect(() => {
    setState({ dim: null, failed: false });
    if (!src) return;
    const img = new Image();
    img.onload = () => setState({ dim: src.intrinsic ?? { w: img.naturalWidth, h: img.naturalHeight }, failed: false });
    img.onerror = () => setState({ dim: null, failed: true });
    img.src = src.url;
    // A superseded source must not report after the new one.
    return () => { img.onload = null; img.onerror = null; };
  }, [src]);
  return state;
}

const dims = (d: Decoded) => (d.dim ? `${d.dim.w}×${d.dim.h}` : d.failed ? '?' : '…');
/** Where the swipe handle and the onion opacity start, each time their mode is entered (H28, H29). */
const MODE_START_PCT = 50;
/** The swipe handle's keyboard step (percent of the box). */
const SWIPE_KEY_STEP = 5;
/** Difference mode's Amplify slider (K10): 1×–16×, the TRUE multiplier (fix round 1) — 1× is the
 * raw difference; the default, 4×, matches the look of the old fixed ×4 brighten. */
const AMPLIFY_MIN = 1;
const AMPLIFY_MAX = 16;
const AMPLIFY_DEFAULT = 4;
const broken = <div className="image-error">Image couldn&apos;t be decoded</div>;

/** The checkerboard toggle's icon (J12): a 3×3 board of big squares filling the swatch's box, so
 * it reads as a checkerboard at toolbar size. The board is the dark cells; five light ones on it. */
const CHECKER_CELLS = [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]];
function CheckerIcon() {
  return (
    <svg className="bg-swatch checker-icon" viewBox="0 0 12 12" width={12} height={12} aria-hidden="true">
      <rect className="checker-dark" x={0} y={0} width={12} height={12} />
      {CHECKER_CELLS.map(([cx, cy]) => <rect key={`${cx}${cy}`} className="checker-light" x={cx * 4} y={cy * 4} width={4} height={4} />)}
    </svg>
  );
}

/**
 * The image diff (spec §10.4). `single`: an added or deleted image (Diff View), which shows only
 * the side it has, labelled, and no compare modes (H25). File View's one revision passes none.
 * `source` is shown instead of the image while its toggle (`sourceLabel`) is on: an SVG's text,
 * a raster image's hex dump. `fileKey`: the file's identity, under which its "Match sizes" pick is
 * remembered for the session.
 */
export function ImageDiff({ old, new: neu, source, sourceLabel = 'Source', onSourceChange, single = null, fileKey }: { old: ImageSource | null; new: ImageSource | null; source?: ReactNode; sourceLabel?: string; onSourceChange?: (on: boolean) => void; single?: 'added' | 'deleted' | null; fileKey?: string }) {
  const both = old !== null && neu !== null;
  const [mode, setModeState] = useState<ImageMode>('side');
  const background = useImageBackground((s) => s.background);
  const setBackground = useImageBackground((s) => s.set);
  const [showSource, setSource] = useState(false);
  const setShowSource = (on: boolean) => {
    setSource(on);
    onSourceChange?.(on);
  };
  // Gone (another file, File View): its Source is off, so the panel's text tools go too (H26).
  // Hidden with the kept panel and shown again (J16), it says again what it shows.
  const reportSource = useRef(onSourceChange);
  reportSource.current = onSourceChange;
  const sourceNow = useRef(showSource);
  sourceNow.current = showSource;
  useEffect(() => {
    if (sourceNow.current) reportSource.current?.(true);
    return () => reportSource.current?.(false);
  }, []);
  const [step, setStep] = useState(DEFAULT_STEP);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  // The displayed zoom % (K13's editable label): set alongside `step`/`view` by every zoom action,
  // not read back from `view.scale` — the box may not be measurable yet (no layout, or the image
  // hasn't decoded), same as `step` itself always tracks the target rung regardless.
  const [zoomPct, setZoomPct] = useState(Math.round(ZOOM_STEPS[DEFAULT_STEP] * 100));
  // K12: Fit is a button, not a rung — this tracks whether it's the active target, so a resize
  // (syncBox) keeps refitting instead of keeping the last rung's view.
  const [fitMode, setFitMode] = useState(false);
  const [amplify, setAmplify] = useState(AMPLIFY_DEFAULT);
  const [editingZoom, setEditingZoom] = useState(false);
  const [zoomDraft, setZoomDraft] = useState('');
  const [swipe, setSwipe] = useState(MODE_START_PCT);
  const [opacity, setOpacity] = useState(MODE_START_PCT);
  const [boxW, setBoxW] = useState(0);
  const setMode = (m: ImageMode) => {
    if (m !== mode && m === 'swipe') setSwipe(MODE_START_PCT);
    if (m !== mode && m === 'onion') setOpacity(MODE_START_PCT);
    setModeState(m);
  };
  const oldImg = useDecoded(old);
  const newImg = useDecoded(neu);
  const stageRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const swipeDragging = useRef(false);
  const stepRef = useRef(DEFAULT_STEP);
  const fitModeRef = useRef(false);
  const amplifyRef = useRef(AMPLIFY_DEFAULT);
  const viewRef = useRef(view);
  const lastBox = useRef<{ w: number; h: number } | null>(null);
  const wheelStep = useMemo(wheelAccumulator, []);
  const zoomInputRef = useRef<HTMLInputElement>(null);
  // The Difference canvas's two loaded images (K10): kept so the Amplify slider can repaint
  // without reloading them on every tick.
  const diffImgs = useRef<{ a: HTMLImageElement | null; b: HTMLImageElement | null } | null>(null);
  const activeMode: ImageMode = both ? mode : 'side';
  // "Match sizes": two decoded sides of different sizes can have the old one drawn at the new one's
  // size (or fitted inside it, centred, when the aspect ratios differ). On by default for a pure
  // resize; the user's pick is remembered per file for the session.
  const [matchPick, setMatchPick] = useState<boolean | undefined>(() => rememberedMatch(fileKey));
  const canMatch = both && sizesDiffer(oldImg.dim, newImg.dim);
  const matched = canMatch && (matchPick ?? defaultMatch(oldImg.dim, newImg.dim));
  const setMatched = (on: boolean) => {
    setMatchPick(on);
    rememberMatch(fileKey, on);
  };
  /** Where the old image is drawn while matched, in the new image's pixels; null: its own size at 0,0. */
  const oldRect = useMemo<Rect | null>(() => (matched && oldImg.dim && newImg.dim ? matchedRect(oldImg.dim, newImg.dim) : null), [matched, oldImg.dim, newImg.dim]);
  const rawW = Math.max(oldImg.dim?.w ?? 0, newImg.dim?.w ?? 0);
  const rawH = Math.max(oldImg.dim?.h ?? 0, newImg.dim?.h ?? 0);
  // The common size every mode, and zoom and pan, work in: the new image's while matched.
  const contentW = matched && newImg.dim ? newImg.dim.w : rawW;
  const contentH = matched && newImg.dim ? newImg.dim.h : rawH;

  /** `start`: a new image, opened at the step's start view (100%: top left where it overflows). */
  const applyStep = (i: number, around?: { x: number; y: number }, start = false) => {
    setStep(i);
    stepRef.current = i;
    setZoomPct(Math.round(ZOOM_STEPS[i] * 100));
    setFitMode(false);
    fitModeRef.current = false;
    const box = boxRef.current;
    if (!box || contentW === 0) return;
    const bw = box.clientWidth;
    const bh = box.clientHeight;
    lastBox.current = { w: bw, h: bh };
    setBoxW(bw);
    const s = ZOOM_STEPS[i];
    if (start) setView(startView(s, contentW, contentH, bw, bh));
    else setView((v) => clampView(zoomAround(v, s, around?.x ?? bw / 2, around?.y ?? bh / 2), contentW, contentH, bw, bh));
  };

  /** K12: the Fit button. Sets the exact % that fits the image in the viewport — not necessarily a
   * slider rung — and stays the active target across a resize (`syncBox`) until any other zoom
   * action (a rung, Ctrl+wheel, a typed %, the double-click reset) turns `fitMode` back off. */
  const applyFit = () => {
    const box = boxRef.current;
    if (!box || contentW === 0) return;
    const bw = box.clientWidth;
    const bh = box.clientHeight;
    lastBox.current = { w: bw, h: bh };
    setBoxW(bw);
    const s = fitScale(contentW, contentH, bw, bh);
    setView(centered(s, contentW, contentH, bw, bh));
    setZoomPct(Math.round(s * 100));
    const i = nearestStepIndex(s);
    setStep(i);
    stepRef.current = i;
    setFitMode(true);
    fitModeRef.current = true;
  };

  /** K13: the typed exact zoom %, already clamped to the zoom range. Zooms around the box's
   * centre, like Ctrl+wheel does when there's no cursor position to keep steady. */
  const applyScale = (scale: number) => {
    const box = boxRef.current;
    if (!box || contentW === 0) return;
    const bw = box.clientWidth;
    const bh = box.clientHeight;
    lastBox.current = { w: bw, h: bh };
    setBoxW(bw);
    setView((v) => clampView(zoomAround(v, scale, bw / 2, bh / 2), contentW, contentH, bw, bh));
    setZoomPct(Math.round(scale * 100));
    const i = nearestStepIndex(scale);
    setStep(i);
    stepRef.current = i;
    setFitMode(false);
    fitModeRef.current = false;
  };

  /** Pans by (dx, dy), only where the image is larger than the box (H27). */
  const panBy = (dx: number, dy: number) => {
    const box = boxRef.current;
    if (!box) return;
    setView((v) => clampView({ ...v, x: v.x + dx, y: v.y + dy }, contentW, contentH, box.clientWidth, box.clientHeight));
  };

  /** After a mode switch or a resize: refit while on Fit, otherwise keep the view and its centre. */
  const syncBox = () => {
    const box = boxRef.current;
    if (!box) return;
    if (fitModeRef.current) {
      applyFit();
      return;
    }
    const w = box.clientWidth;
    const h = box.clientHeight;
    const prev = lastBox.current;
    lastBox.current = { w, h };
    setBoxW(w);
    if (prev && (prev.w !== w || prev.h !== h)) setView((v) => clampView({ ...v, x: v.x + (w - prev.w) / 2, y: v.y + (h - prev.h) / 2 }, contentW, contentH, w, h));
  };

  // Native listeners and the ResizeObserver live across renders: they call the latest closures.
  const latest = useRef({ applyStep, syncBox });
  useLayoutEffect(() => {
    latest.current = { applyStep, syncBox };
    viewRef.current = view;
    amplifyRef.current = amplify;
  });

  // New or newly decoded images start at 100% (H23): scrollable where larger than the box.
  // Keyed on the images' own sizes, not the matched size: toggling Match sizes keeps the zoom.
  useLayoutEffect(() => {
    applyStep(DEFAULT_STEP, undefined, true);
  }, [rawW, rawH]); // eslint-disable-line react-hooks/exhaustive-deps

  // Match sizes toggled: the same zoom, the view kept on the (new) common size, or refitted on Fit.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || contentW === 0) return;
    if (fitModeRef.current) return applyFit();
    setView((v) => clampView(v, contentW, contentH, box.clientWidth, box.clientHeight));
  }, [matched]); // eslint-disable-line react-hooks/exhaustive-deps

  // Zoom and pan are shared by every mode (spec §10.4): a mode switch only re-centres.
  useLayoutEffect(() => {
    syncBox();
  }, [activeMode, showSource]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const ro = new ResizeObserver(() => latest.current.syncBox());
    ro.observe(stage);
    // Ctrl+wheel zooms around the cursor. The listener must be non-passive, or the browser zooms
    // the whole webview instead.
    const onWheel = (e: globalThis.WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const dir = wheelStep(e);
      if (dir === 0) return;
      const vp = (e.target as HTMLElement).closest<HTMLElement>('.image-viewport') ?? stage;
      const r = vp.getBoundingClientRect();
      latest.current.applyStep(nextStepIndex(viewRef.current.scale, dir), { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      stage.removeEventListener('wheel', onWheel);
    };
  }, [showSource, wheelStep]);

  useEffect(() => {
    if (editingZoom) { zoomInputRef.current?.focus(); zoomInputRef.current?.select(); }
  }, [editingZoom]);

  useEffect(() => {
    if (activeMode !== 'difference' || !canvasRef.current || !old || !neu || contentW === 0) return;
    const canvas = canvasRef.current;
    let live = true;
    void Promise.all([loadImage(old.url), loadImage(neu.url)]).then(([a, b]) => {
      if (!live) return;
      diffImgs.current = { a, b };
      drawDifference(canvas, a, b, contentW, contentH, amplifyRef.current, oldRect ?? oldImg.dim, newImg.dim);
    });
    return () => { live = false; };
  }, [activeMode, old, neu, contentW, contentH, oldImg.dim, newImg.dim, oldRect]);

  // K10: the Amplify slider repaints from the already-loaded images — no reload, so dragging it
  // stays fast — via the same `drawDifference`, which keeps the canvas's zoom/pan transform and
  // pixelated rendering untouched (only the pixel content changes). Fix round 1 (Medium): a
  // `range` input fires `change` on every tick while dragging, and each one is a full
  // getImageData/putImageData at native resolution — coalesced to at most one repaint per
  // animation frame, so only the latest `amplify` by the time the frame paints is ever drawn.
  useEffect(() => {
    if (activeMode !== 'difference' || !canvasRef.current || !diffImgs.current) return;
    const canvas = canvasRef.current;
    const { a, b } = diffImgs.current;
    const raf = requestAnimationFrame(() => drawDifference(canvas, a, b, contentW, contentH, amplify, oldRect ?? oldImg.dim, newImg.dim));
    return () => cancelAnimationFrame(raf);
  }, [amplify, activeMode, contentW, contentH, oldImg.dim, newImg.dim, oldRect]);

  // J13: until every side has decoded (or failed), there's no size to place the images by, and a
  // later side's size moves the view again: they'd paint at the top left, then jump. Hidden until
  // then; the render that learns the last size places them in a layout effect, before a paint.
  const settled = (src: ImageSource | null, d: Decoded) => !src || d.dim !== null || d.failed;
  const ready = settled(old, oldImg) && settled(neu, newImg);
  const layer: CSSProperties = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, imageRendering: pixelated(view.scale) ? 'pixelated' : 'auto', visibility: ready ? undefined : 'hidden' };
  const endDrag = () => { drag.current = null; };
  const pan = {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { x: e.clientX, y: e.clientY };
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d) return;
      if ((e.buttons & 1) === 0) return endDrag(); // the release happened somewhere we didn't see
      panBy(e.clientX - d.x, e.clientY - d.y);
      drag.current = { x: e.clientX, y: e.clientY };
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onLostPointerCapture: endDrag,
  };
  // The swipe handle, over the whole image (J10), kept inside the viewport. jsdom (no layout) and
  // a not-yet-decoded image have no box to clamp to.
  const swipePct = boxW > 0 && contentW > 0 ? (clampSwipe((swipe / 100) * boxW, view, contentW, boxW) / boxW) * 100 : swipe;
  const moveSwipe = (pct: number) => setSwipe(Math.max(0, Math.min(100, pct)));
  // K8: a mouse-down anywhere on the image in Swipe mode jumps the handle to the pointer and starts
  // dragging it — it replaces `pan` for this mode's box (the divider's own handler stops
  // propagation first, so a press on the 3 px line itself still only drags the handle, unchanged).
  const swipeDrag = {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const r = e.currentTarget.getBoundingClientRect();
      moveSwipe(((e.clientX - r.left) / r.width) * 100);
      e.currentTarget.setPointerCapture?.(e.pointerId);
      swipeDragging.current = true;
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      if (!swipeDragging.current) return;
      if ((e.buttons & 1) === 0) { swipeDragging.current = false; return; }
      const r = e.currentTarget.getBoundingClientRect();
      moveSwipe(((e.clientX - r.left) / r.width) * 100);
    },
    onPointerUp: () => { swipeDragging.current = false; },
    onPointerCancel: () => { swipeDragging.current = false; },
    onLostPointerCapture: () => { swipeDragging.current = false; },
  };
  const bg = `bg-${background}`;
  /** Side-by-side: the pane right-clicked (its viewport is the second one when both are shown). */
  const sideOf = (t: EventTarget): ImageSide => {
    const vp = (t as HTMLElement).closest?.('.image-viewport');
    return both && activeMode === 'side' && vp && vp === stageRef.current?.querySelectorAll('.image-viewport')[1] ? 'new' : 'old';
  };
  // The size is explicit: an SVG with only a viewBox lays out at the viewport's width otherwise,
  // not at the size the frame and the zoom math use. `at`: drawn there instead (Match sizes).
  const img = (src: ImageSource, decoded: Decoded, label: string, style?: CSSProperties, at?: Rect | null) => {
    if (decoded.failed) return broken;
    const placed = at && { transform: `translate(${view.x + at.x * view.scale}px, ${view.y + at.y * view.scale}px) scale(${view.scale})` };
    return <img className="image-layer" src={src.url} alt={label} draggable={false} style={{ ...layer, ...placed, ...style, width: at ? at.w : decoded.dim?.w, height: at ? at.h : decoded.dim?.h }} />;
  };
  /** The size info's full text, for its tooltip when the toolbar truncates it. */
  const metaText = both
    ? `${dims(oldImg)} → ${dims(newImg)} · ${formatBytes(old?.size)} → ${formatBytes(neu?.size)}`
    : `${dims(old ? oldImg : newImg)} · ${formatBytes((old ?? neu)?.size)}${single ? ` (${single})` : ''}`;
  /** The old side's label, noting while matched that it's drawn scaled (its real size is in the toolbar). */
  const oldLabel = <>Old{matched && <span className="match-note" data-testid="match-note">scaled to match</span>}</>;
  /** An image's bounds on screen (J11): the background pick behind it only, and a 1 px border
   * around it, so the viewport's neutral grey shows how much room there is around the image. */
  const frame = (d: Dim | null, cls = bg) =>
    d && ready && <div className={`image-frame ${cls}`} aria-hidden="true" style={{ transform: `translate(${view.x}px, ${view.y}px)`, width: d.w * view.scale, height: d.h * view.scale }} />;
  // Swipe, onion skin and difference overlay both sides: one frame, around both.
  const overlay = contentW > 0 ? { w: contentW, h: contentH } : null;

  // K13: click the zoom % to edit it as a number. `<input type="text">` (not `type="number"`) so
  // the key router's own text-box check (`isTextInput`, repo/escape.ts) recognises it: Esc is then
  // never treated as the app's close-file key while editing, and the input's own handler below
  // owns it instead, as required.
  const startEditZoom = () => {
    setZoomDraft(String(zoomPct));
    setEditingZoom(true);
  };
  const commitZoom = () => {
    const n = Number(zoomDraft);
    if (Number.isFinite(n) && n > 0) applyScale(Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Math.max(ZOOM_STEPS[0], n / 100)));
    setEditingZoom(false);
  };
  const cancelZoom = () => setEditingZoom(false);

  return (
    <div className="image-diff">
      <div className="image-toolbar" role="toolbar" aria-label="Image diff options">
        {/* Nothing to compare for an added or deleted image (H25). */}
        {both && (
          <div className="segmented" role="group" aria-label="Image mode">
            {MODES.map(([m, label]) => (
              <button key={m} type="button" aria-pressed={activeMode === m && !showSource} onClick={() => { setMode(m); setShowSource(false); }}>{label}</button>
            ))}
          </div>
        )}
        {canMatch && (
          <HoverTooltip content={MATCH_TIP}>
            <button type="button" className="icon-button match-sizes" aria-label="Match sizes" aria-pressed={matched} onClick={() => setMatched(!matched)}>
              <Scaling size={14} aria-hidden="true" />
            </button>
          </HoverTooltip>
        )}
        {source && <button type="button" className="toggle" aria-pressed={showSource} onClick={() => setShowSource(!showSource)}>{sourceLabel}</button>}
        <div className="image-zoom">
          {/* K12: Fit is its own button, not the slider's bottom stop — the slider's minimum is
              now a fixed ladder rung. */}
          <button type="button" className="zoom-fit" aria-pressed={fitMode} onClick={applyFit}>Fit</button>
          <input
            type="range"
            min={0}
            max={ZOOM_STEPS.length - 1}
            step={1}
            value={step}
            aria-label="Zoom"
            aria-valuetext={stepLabel(ZOOM_STEPS[step])}
            onChange={(e) => applyStep(Number(e.target.value))}
            onDoubleClick={() => applyStep(DEFAULT_STEP)} // K14: reset to 100%
          />
          {editingZoom ? (
            <input
              ref={zoomInputRef}
              type="text"
              inputMode="numeric"
              className="zoom-input"
              data-testid="zoom-input"
              aria-label="Zoom percentage"
              value={zoomDraft}
              onChange={(e) => setZoomDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitZoom(); }
                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelZoom(); }
              }}
              onBlur={(e) => {
                // The WM's focus bounce on a press inside the field isn't leaving it (K41).
                if (isWindowBlur()) return refocusWhenWindowReturns(e.currentTarget);
                commitZoom();
              }}
            />
          ) : (
            // K13: click to edit an exact %.
            <button type="button" className="zoom-value" data-testid="zoom-label" onClick={startEditZoom}>{zoomPct}%</button>
          )}
        </div>
        {/* Truncated first when the toolbar runs short (it never wraps): the full text is its tooltip. */}
        <HoverTooltip content={metaText}>
          <span className="dim image-meta" data-testid="image-meta">
            {both ? (
              <>
                <span data-testid="image-dims">{dims(oldImg)} <ArrowGlyph /> {dims(newImg)}</span> <span className="meta-sep">·</span> <span data-testid="image-size">{formatBytes(old?.size)} <ArrowGlyph /> {formatBytes(neu?.size)}</span>
              </>
            ) : (
              // Only the side that exists (H25).
              <>
                <span data-testid="image-dims">{dims(old ? oldImg : newImg)}</span> <span className="meta-sep">·</span> <span data-testid="image-size">{formatBytes((old ?? neu)?.size)}</span>
                {single && <> ({single})</>}
              </>
            )}
          </span>
        </HoverTooltip>
        {/* The background behind transparent pixels (H30), at the far right. */}
        <div className="image-backgrounds" role="group" aria-label="Image background">
          {IMAGE_BACKGROUNDS.map((b) => (
            <HoverTooltip key={b.id} content={b.label}>
              <button type="button" className="icon-button" aria-label={b.label} aria-pressed={background === b.id} onClick={() => setBackground(b.id)}>
                {b.id === 'checker' ? <CheckerIcon /> : <span className={`bg-swatch bg-${b.id}`} aria-hidden="true" />}
              </button>
            </HoverTooltip>
          ))}
        </div>
      </div>
      {showSource && source ? (
        <div className="image-source">{source}</div>
      ) : (
        // Our own context menu (K98), never the native one: WebKit's "Open Image in New Window"
        // would load an SVG blob as a document. No native drag either: WebKit starts
        // one from the swipe handle (a selection), which ends the handle's own drag midway (J10).
        <div ref={stageRef} className={`image-stage mode-${activeMode}`} onContextMenu={(e) => openContextMenu(e, () => imageMenuRows({ old, new: neu }, sideOf(e.target)))} onDragStart={(e) => e.preventDefault()}>
          {activeMode === 'side' && (
            <>
              {/* K9: subtle, non-interactive Old/New chips. */}
              {old && <div ref={boxRef} className="image-viewport" {...pan}>{frame(matched ? newImg.dim : oldImg.dim)}{img(old, oldImg, 'before', undefined, oldRect)}{both && <span className="image-label label-bl">{oldLabel}</span>}</div>}
              {/* K21: a 1 px divider between the two halves — out of flow (position: absolute), so
                  it never shifts either viewport's flexed width by even a sub-pixel. */}
              {both && <div className="side-divider" aria-hidden="true" />}
              {neu && <div ref={old ? undefined : boxRef} className="image-viewport" {...pan}>{frame(newImg.dim)}{img(neu, newImg, 'after')}{both && <span className="image-label label-bl">New</span>}</div>}
            </>
          )}
          {activeMode === 'swipe' && old && neu && (
            // K8: a mouse-down anywhere jumps the handle here and drags it (swipeDrag), not a pan.
            <div ref={boxRef} className="image-viewport" {...swipeDrag}>
              {frame(overlay)}
              {img(old, oldImg, 'before', undefined, oldRect)}
              <div className="swipe-clip" style={{ clipPath: `inset(0 0 0 ${swipePct}%)` }}>{img(neu, newImg, 'after')}</div>
              {/* K9: fixed corner chips (not clipped with the image), clear of the handle. */}
              <span className="image-label label-bl">{oldLabel}</span>
              <span className="image-label label-br">New</span>
              <div
                role="slider"
                aria-label="Swipe position"
                aria-valuenow={Math.round(swipePct)}
                aria-valuemin={0}
                aria-valuemax={100}
                tabIndex={0}
                className="swipe-divider"
                {...onResetDoubleClick(() => setSwipe(MODE_START_PCT))}
                style={{ left: `${swipePct}%` }}
                // Never a pan (H27): the handle's own drag, and nothing reaches the viewport.
                onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); }}
                onPointerMove={(e) => {
                  if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                  const r = e.currentTarget.parentElement!.getBoundingClientRect();
                  moveSwipe(((e.clientX - r.left) / r.width) * 100);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setSwipe(MODE_START_PCT);
                  else if (e.key === 'ArrowLeft') moveSwipe(Math.round(swipePct) - SWIPE_KEY_STEP);
                  else if (e.key === 'ArrowRight') moveSwipe(Math.round(swipePct) + SWIPE_KEY_STEP);
                  else return;
                  e.preventDefault();
                }}
              />
            </div>
          )}
          {activeMode === 'onion' && old && neu && (
            <div ref={boxRef} className="image-viewport" {...pan}>
              {frame(overlay)}
              {img(old, oldImg, 'before', undefined, oldRect)}
              {img(neu, newImg, 'after', { opacity: opacity / 100 })}
              {/* K9: Old/New at the two ends of the opacity slider. */}
              <div className="onion-control">
                <span className="image-label onion-label">{oldLabel}</span>
                <input className="onion-opacity" type="range" min={0} max={100} value={opacity} aria-label="Opacity" onPointerDown={(e) => e.stopPropagation()} onChange={(e) => setOpacity(Number(e.target.value))} />
                <span className="image-label onion-label">New</span>
              </div>
            </div>
          )}
          {activeMode === 'difference' && old && neu && (
            // The difference keeps its black canvas, whatever the background pick (H30), framed (J11).
            <div ref={boxRef} className="image-viewport" {...pan}>
              {(oldImg.failed || newImg.failed) && broken}
              {frame(overlay, 'bg-black')}
              <canvas ref={canvasRef} className="image-layer" data-testid="image-difference" style={layer} />
              {/* K10: 1×–16× brighten multiplier — the true multiplier, default 4× (the old fixed ×4's look). */}
              <div className="difference-amplify">
                <span className="image-label onion-label">Amplify</span>
                <input
                  type="range"
                  min={AMPLIFY_MIN}
                  max={AMPLIFY_MAX}
                  step={1}
                  value={amplify}
                  aria-label="Amplify"
                  aria-valuetext={`${amplify}×`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onChange={(e) => setAmplify(Number(e.target.value))}
                />
                <span className="amplify-value" data-testid="amplify-value">{amplify}×</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
