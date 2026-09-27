import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { formatBytes } from '../diff/format';
import { drawDifference } from './difference';
import type { ImageSource } from './sources';
import { centered, fitScale, nextStepIndex, pixelated, stepLabel, ZOOM_STEPS, zoomAround, type View } from './zoom';
import './image.css';

export type ImageMode = 'side' | 'swipe' | 'onion' | 'difference';
interface Dim { w: number; h: number }
interface Decoded { dim: Dim | null; failed: boolean }

const MODES: [ImageMode, string][] = [['side', 'Side-by-side'], ['swipe', 'Swipe'], ['onion', 'Onion skin'], ['difference', 'Difference']];
/** Wheel travel (px) per zoom step: a mouse notch (~100 px) is one step, a trackpad pinch accumulates. */
const WHEEL_STEP_PX = 50;
const WHEEL_UNIT_PX = [1, 20, 400]; // by WheelEvent.deltaMode: pixel, line, page

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
    img.onload = () => setState({ dim: { w: img.naturalWidth, h: img.naturalHeight }, failed: false });
    img.onerror = () => setState({ dim: null, failed: true });
    img.src = src.url;
    // A superseded source must not report after the new one.
    return () => { img.onload = null; img.onerror = null; };
  }, [src]);
  return state;
}

const dims = (d: Decoded, present: boolean) => (!present ? '—' : d.dim ? `${d.dim.w}×${d.dim.h}` : d.failed ? '?' : '…');
const broken = <div className="image-error">Image couldn&apos;t be decoded</div>;

export function ImageDiff({ old, new: neu, source }: { old: ImageSource | null; new: ImageSource | null; source?: ReactNode }) {
  const both = old !== null && neu !== null;
  const [mode, setMode] = useState<ImageMode>('side');
  const [showSource, setShowSource] = useState(false);
  const [step, setStep] = useState(0);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [swipe, setSwipe] = useState(50);
  const [opacity, setOpacity] = useState(50);
  const oldImg = useDecoded(old);
  const newImg = useDecoded(neu);
  const stageRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const stepRef = useRef(0);
  const viewRef = useRef(view);
  const lastBox = useRef<{ w: number; h: number } | null>(null);
  const wheelAcc = useRef(0);
  const activeMode: ImageMode = both ? mode : 'side';
  const contentW = Math.max(oldImg.dim?.w ?? 0, newImg.dim?.w ?? 0);
  const contentH = Math.max(oldImg.dim?.h ?? 0, newImg.dim?.h ?? 0);

  const applyStep = (i: number, around?: { x: number; y: number }) => {
    setStep(i);
    stepRef.current = i;
    const box = boxRef.current;
    if (!box || contentW === 0) return;
    const bw = box.clientWidth;
    const bh = box.clientHeight;
    lastBox.current = { w: bw, h: bh };
    const s = ZOOM_STEPS[i];
    if (s === 'fit') setView(centered(fitScale(contentW, contentH, bw, bh), contentW, contentH, bw, bh));
    else setView((v) => zoomAround(v, s, around?.x ?? bw / 2, around?.y ?? bh / 2));
  };

  /** After a mode switch or a resize: refit while on Fit, otherwise keep the view and its centre. */
  const syncBox = () => {
    const box = boxRef.current;
    if (!box) return;
    if (stepRef.current === 0) {
      applyStep(0);
      return;
    }
    const w = box.clientWidth;
    const h = box.clientHeight;
    const prev = lastBox.current;
    lastBox.current = { w, h };
    if (prev && (prev.w !== w || prev.h !== h)) setView((v) => ({ ...v, x: v.x + (w - prev.w) / 2, y: v.y + (h - prev.h) / 2 }));
  };

  // Native listeners and the ResizeObserver live across renders: they call the latest closures.
  const latest = useRef({ applyStep, syncBox });
  useLayoutEffect(() => {
    latest.current = { applyStep, syncBox };
    viewRef.current = view;
  });

  // New or newly decoded images start at Fit.
  useLayoutEffect(() => {
    applyStep(0);
  }, [contentW, contentH]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const dy = e.deltaY * (WHEEL_UNIT_PX[e.deltaMode] ?? 1);
      if (dy === 0) return;
      if (Math.sign(dy) !== Math.sign(wheelAcc.current)) wheelAcc.current = 0;
      wheelAcc.current += dy;
      if (Math.abs(wheelAcc.current) < WHEEL_STEP_PX) return;
      wheelAcc.current = 0;
      const vp = (e.target as HTMLElement).closest<HTMLElement>('.image-viewport') ?? stage;
      const r = vp.getBoundingClientRect();
      latest.current.applyStep(nextStepIndex(viewRef.current.scale, dy < 0 ? 1 : -1), { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      stage.removeEventListener('wheel', onWheel);
    };
  }, [showSource]);

  useEffect(() => {
    if (activeMode !== 'difference' || !canvasRef.current || !old || !neu || contentW === 0) return;
    const canvas = canvasRef.current;
    let live = true;
    void Promise.all([loadImage(old.url), loadImage(neu.url)]).then(([a, b]) => { if (live) drawDifference(canvas, a, b, contentW, contentH); });
    return () => { live = false; };
  }, [activeMode, old, neu, contentW, contentH]);

  const layer: CSSProperties = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, imageRendering: pixelated(view.scale) ? 'pixelated' : 'auto' };
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
      setView((v) => ({ ...v, x: v.x + e.clientX - d.x, y: v.y + e.clientY - d.y }));
      drag.current = { x: e.clientX, y: e.clientY };
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onLostPointerCapture: endDrag,
  };
  const img = (src: ImageSource, decoded: Decoded, label: string, style?: CSSProperties) =>
    decoded.failed ? broken : <img className="image-layer" src={src.url} alt={label} draggable={false} style={{ ...layer, ...style }} />;

  return (
    <div className="image-diff">
      <div className="image-toolbar" role="toolbar" aria-label="Image diff options">
        <div className="segmented" role="group" aria-label="Image mode">
          {MODES.map(([m, label]) => (
            <button key={m} type="button" aria-pressed={activeMode === m && !showSource} disabled={!both && m !== 'side'} onClick={() => { setMode(m); setShowSource(false); }}>{label}</button>
          ))}
        </div>
        {source && <button type="button" className="toggle" aria-pressed={showSource} onClick={() => setShowSource(!showSource)}>Source</button>}
        <label className="image-zoom">
          <input type="range" min={0} max={ZOOM_STEPS.length - 1} step={1} value={step} aria-label="Zoom" aria-valuetext={stepLabel(ZOOM_STEPS[step])} onChange={(e) => applyStep(Number(e.target.value))} />
          <span data-testid="zoom-label">{stepLabel(ZOOM_STEPS[step])}</span>
        </label>
        <span className="dim" data-testid="image-dims">{dims(oldImg, old !== null)} → {dims(newImg, neu !== null)}</span>
        <span className="dim" data-testid="image-size">{formatBytes(old?.size)} → {formatBytes(neu?.size)}</span>
      </div>
      {showSource && source ? (
        <div className="image-source">{source}</div>
      ) : (
        // No native context menu: WebKit's "Open Image in New Window" would load an SVG blob as a
        // document (defence in depth; 1C adds our own menu).
        <div ref={stageRef} className={`image-stage mode-${activeMode}`} onContextMenu={(e) => e.preventDefault()}>
          {activeMode === 'side' && (
            <>
              {old && <div ref={boxRef} className="image-viewport checkerboard" {...pan}>{img(old, oldImg, 'before')}</div>}
              {neu && <div ref={old ? undefined : boxRef} className="image-viewport checkerboard" {...pan}>{img(neu, newImg, 'after')}</div>}
            </>
          )}
          {activeMode === 'swipe' && old && neu && (
            <div ref={boxRef} className="image-viewport checkerboard" {...pan}>
              {img(old, oldImg, 'before')}
              <div className="swipe-clip" style={{ clipPath: `inset(0 0 0 ${swipe}%)` }}>{img(neu, newImg, 'after')}</div>
              <div
                role="slider"
                aria-label="Swipe position"
                aria-valuenow={swipe}
                aria-valuemin={0}
                aria-valuemax={100}
                tabIndex={0}
                className="swipe-divider"
                style={{ left: `${swipe}%` }}
                onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); }}
                onPointerMove={(e) => {
                  if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                  const r = e.currentTarget.parentElement!.getBoundingClientRect();
                  setSwipe(Math.round(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100))));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') setSwipe((s) => Math.max(0, s - 5));
                  else if (e.key === 'ArrowRight') setSwipe((s) => Math.min(100, s + 5));
                  else return;
                  e.preventDefault();
                }}
              />
            </div>
          )}
          {activeMode === 'onion' && old && neu && (
            <div ref={boxRef} className="image-viewport checkerboard" {...pan}>
              {img(old, oldImg, 'before')}
              {img(neu, newImg, 'after', { opacity: opacity / 100 })}
              <input className="onion-opacity" type="range" min={0} max={100} value={opacity} aria-label="Opacity" onPointerDown={(e) => e.stopPropagation()} onChange={(e) => setOpacity(Number(e.target.value))} />
            </div>
          )}
          {activeMode === 'difference' && old && neu && (
            <div ref={boxRef} className="image-viewport" {...pan}>
              {(oldImg.failed || newImg.failed) && broken}
              <canvas ref={canvasRef} className="image-layer" data-testid="image-difference" style={layer} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
