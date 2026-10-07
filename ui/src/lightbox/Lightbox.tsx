import { Copy, ExternalLink, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { errorMessage } from '../api/client';
import { useModalKeys } from '../app/modalKeys';
import { copyImage } from '../image/copyImage';
import { centered, clampView, fitScale, nextStepIndex, pixelated, wheelAccumulator, ZOOM_STEPS, zoomAround, type View } from '../image/zoom';
import { openExternal } from '../markdown/actions';
import { registerKeyHints } from '../shortcuts/hints';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useToast } from '../ui/toastStore';
import { useLightbox, type LightboxItem } from './store';
import './lightbox.css';

/** How far an arrow key pans, in screen px. */
const PAN_STEP_PX = 50;

const plain = (e: KeyboardEvent) => !e.ctrlKey && !e.metaKey && !e.altKey;
const box = () => ({ w: window.innerWidth, h: window.innerHeight });

/** The image viewer (one for the app, over everything but tooltips, confirms and toasts): what
 * `openLightbox` was given, until it's closed. */
export function Lightbox() {
  const item = useLightbox((s) => s.item);
  return item ? <LightboxView key={item.url} item={item} /> : null;
}

function LightboxView({ item }: { item: LightboxItem }) {
  const close = useLightbox((s) => s.close);
  const video = item.kind === 'video';
  const [dim, setDim] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const dimRef = useRef(dim);
  dimRef.current = dim;
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const downOnBackdrop = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Closing stops the video (a removed element would pause too; this doesn't wait for that).
  useEffect(() => {
    const v = videoRef.current;
    return () => v?.pause();
  }, []);

  const clamp = (v: View): View => {
    const d = dimRef.current;
    const b = box();
    return d ? clampView(v, d.w, d.h, b.w, b.h) : v;
  };
  const fit = () => {
    const d = dimRef.current;
    if (!d) return;
    const b = box();
    setView(centered(fitScale(d.w, d.h, b.w, b.h), d.w, d.h, b.w, b.h));
  };
  /** `scale` around the screen point `at` (the window's centre by default). */
  const zoomTo = (scale: number, at?: { x: number; y: number }) => {
    const b = box();
    setView((v) => clamp(zoomAround(v, scale, at?.x ?? b.w / 2, at?.y ?? b.h / 2)));
  };
  const step = (dir: 1 | -1, at?: { x: number; y: number }) => zoomTo(ZOOM_STEPS[nextStepIndex(viewRef.current.scale, dir)], at);
  const panBy = (dx: number, dy: number) => setView((v) => clamp({ ...v, x: v.x + dx, y: v.y + dy }));

  // A video only shows at 100% or fitted: no zoom steps, no pan.
  const onKey = (e: KeyboardEvent): boolean => {
    if (!plain(e)) return false;
    if (e.key === '0') fit();
    else if (e.key === '1') zoomTo(1);
    else if (video) return false;
    else if (e.key === '+' || e.key === '=') step(1);
    else if (e.key === '-' || e.key === '_') step(-1);
    else if (e.key === 'ArrowLeft') panBy(PAN_STEP_PX, 0);
    else if (e.key === 'ArrowRight') panBy(-PAN_STEP_PX, 0);
    else if (e.key === 'ArrowUp') panBy(0, PAN_STEP_PX);
    else if (e.key === 'ArrowDown') panBy(0, -PAN_STEP_PX);
    else return false;
    return true;
  };
  const ref = useModalKeys<HTMLDivElement>(true, close, undefined, onKey);
  // The dialog itself takes the focus (not its first button): Tab then reaches the toolbar.
  useLayoutEffect(() => ref.current?.focus({ preventScroll: true }), [ref]);

  // Opens at 100%, or fitted when that's smaller (the image is larger than the window).
  useLayoutEffect(() => {
    if (!dim) return;
    const b = box();
    setView(centered(Math.min(1, fitScale(dim.w, dim.h, b.w, b.h)), dim.w, dim.h, b.w, b.h));
  }, [dim]);

  // The window resized: the same zoom, kept centred and in bounds.
  useEffect(() => {
    let last = box();
    const onResize = () => {
      const b = box();
      setView((v) => clamp({ ...v, x: v.x + (b.w - last.w) / 2, y: v.y + (b.h - last.h) / 2 }));
      last = b;
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `clamp` reads the latest size through refs
  }, []);

  // The wheel zooms around the pointer; non-passive, or Ctrl+wheel zooms the whole webview.
  const latestStep = useRef(step);
  latestStep.current = step;
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || video) return;
    const wheel = wheelAccumulator();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dir = wheel(e);
      if (dir !== 0) latestStep.current(dir, { x: e.clientX, y: e.clientY });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [video]);

  const b = box();
  const pannable = !video && dim !== null && (dim.w * view.scale > b.w + 0.5 || dim.h * view.scale > b.h + 0.5);
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !pannable) return;
    e.preventDefault();
    drag.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    panBy(e.clientX - d.x, e.clientY - d.y);
    drag.current = { x: e.clientX, y: e.clientY };
  };
  const endDrag = () => { drag.current = null; };

  const placed = {
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
    imageRendering: pixelated(view.scale) ? 'pixelated' : 'auto',
    visibility: dim ? undefined : 'hidden',
  } as const;
  // A video is sized instead of scaled, so its controls keep their size.
  const sized = { transform: `translate(${view.x}px, ${view.y}px)`, width: dim ? dim.w * view.scale : undefined, height: dim ? dim.h * view.scale : undefined, visibility: dim ? undefined : 'hidden' } as const;
  const toast = useToast.getState().show;
  const copy = () => { copyImage({ url: item.url, size: 0 }).then(() => toast('Image copied'), (e: unknown) => toast(errorMessage(e), { error: true })); };
  const name = item.alt || (video ? 'Video' : 'Image');

  return (
    <div ref={ref} className="lightbox" role="dialog" aria-modal="true" aria-label={`${video ? 'Video' : 'Image'} viewer: ${name}`} tabIndex={-1}>
      <div
        ref={stageRef}
        className="lightbox-stage"
        data-testid="lightbox-stage"
        onPointerDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
        onClick={(e) => {
          e.stopPropagation();
          if (e.target === e.currentTarget && downOnBackdrop.current) close();
          downOnBackdrop.current = false;
        }}
      >
        {video ? (
          <video
            className="lightbox-media"
            src={item.url}
            controls
            autoPlay
            aria-label={name}
            ref={videoRef}
            style={sized}
            onLoadedMetadata={(e) => setDim({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })}
          />
        ) : (
          <img
            className={pannable ? 'lightbox-media lightbox-pannable' : 'lightbox-media'}
            src={item.url}
            alt={item.alt}
            draggable={false}
            style={placed}
            onLoad={(e) => setDim({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
        )}
      </div>
      <div className="lightbox-toolbar" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox-zoom" data-testid="lightbox-zoom">{`${Math.round(view.scale * 100)}%`}</span>
        <HoverTooltip content="Fit to the window (0)"><button type="button" className="lightbox-button" onClick={fit}>Fit</button></HoverTooltip>
        <HoverTooltip content="Actual size (1)"><button type="button" className="lightbox-button" onClick={() => zoomTo(1)}>100%</button></HoverTooltip>
        {!video && <HoverTooltip content="Copy the image to the clipboard as a PNG"><button type="button" className="icon-button" aria-label="Copy image" onClick={copy}><Copy size={14} /></button></HoverTooltip>}
        {item.browserUrl && <HoverTooltip content="Open in browser"><button type="button" className="icon-button" aria-label="Open in browser" onClick={() => openExternal(item.browserUrl!)}><ExternalLink size={14} /></button></HoverTooltip>}
        <HoverTooltip content="Close (Esc)"><button type="button" className="icon-button" aria-label="Close" onClick={close}><X size={14} /></button></HoverTooltip>
      </div>
    </div>
  );
}

registerKeyHints([
  { id: 'lightbox.zoom', section: 'Image viewer', label: 'Zoom in / out', keys: ['+', '-'], context: '(or the mouse wheel)', source: 'lightbox/Lightbox.tsx' },
  { id: 'lightbox.fit', section: 'Image viewer', label: 'Fit to the window', keys: ['0'], source: 'lightbox/Lightbox.tsx' },
  { id: 'lightbox.actual', section: 'Image viewer', label: 'Actual size (100%)', keys: ['1'], source: 'lightbox/Lightbox.tsx' },
  { id: 'lightbox.pan', section: 'Image viewer', label: 'Pan a zoomed image', keys: ['Left', 'Right', 'Up', 'Down'], context: '(or drag it)', source: 'lightbox/Lightbox.tsx' },
  { id: 'lightbox.close', section: 'Image viewer', label: 'Close', keys: ['Esc'], source: 'lightbox/Lightbox.tsx' },
  { id: 'lightbox.open', section: 'Image viewer', label: 'View an image full size', keys: ['Enter'], context: '(when an image in a comment has focus; or click it)', source: 'markdown/MdImage.tsx' },
]);
