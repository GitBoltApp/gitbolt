import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTheme } from '../theme/store';
import { THEMES } from '../theme/themes';
import { markRects, RULER_WIDTH, rulerColors, sliderOf, type RulerMark } from './mdRuler';
import { bindRulerPointer } from './rulerPointer';

const MEASURE_GAP_MS = 100;

/**
 * A diff view's scroll pane (`pane`, the box's first child) with an overview ruler at its right
 * edge in place of its vertical scrollbar, as the Source diff's Monaco overview: the changes'
 * marks (`marks`, in the pane's content px) on one canvas, and a viewport slider. A click centres
 * the view there and drags on, as does dragging the slider; the wheel over it scrolls the pane.
 * It shows while the pane scrolls or has a change to mark, and the pane's own vertical scrollbar
 * hides then (`ruler-ruled`; each pane's CSS leaves the strip its room). The strip spans the pane
 * alone (`ruler-box`), above a horizontal scrollbar: what comes `after` it is outside.
 *
 * Positions are measured once per change (a resize of the pane or of its top-level content, new
 * `marks`, the theme, and with `watchContent` any change inside the pane: a streamed chunk, an
 * image loading), batched in a frame; a scroll only moves the slider.
 */
export function RulerFrame({ pane, active = true, split = false, marks, watchContent = false, className, children, after }: {
  pane: RefObject<HTMLElement | null>;
  active?: boolean;
  split?: boolean;
  marks?: (pane: HTMLElement) => RulerMark[];
  watchContent?: boolean;
  className?: string;
  children: ReactNode;
  after?: ReactNode;
}) {
  const [ruled, setRuled] = useState(false);
  const strip = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const slider = useRef<HTMLDivElement>(null);
  const marksOf = useRef(marks);
  marksOf.current = marks;
  const remeasure = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const el = pane.current;
    const box = strip.current;
    const cv = canvas.current;
    const sl = slider.current;
    if (!active || !el || !box || !cv || !sl) return;
    let list: RulerMark[] = [];
    let visible = 0;
    let content = 0;
    // The pane's metrics now, not the last measure's: content laid out under a press moves the
    // slider at once, as the view follows the pointer (`follow`).
    const place = () => {
      const h = el.clientHeight;
      const s = sliderOf(h, el.scrollHeight, el.scrollTop, h);
      sl.hidden = !s.needed;
      sl.style.height = `${s.height}px`;
      sl.style.transform = `translateY(${s.top}px)`;
    };
    const draw = () => {
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(RULER_WIDTH * dpr);
      cv.height = Math.round(visible * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, RULER_WIDTH, visible);
      const colors = rulerColors(THEMES[useTheme.getState().id]);
      const rects = markRects(list, content, visible, split);
      for (const kind of ['changed', 'removed', 'added'] as const) {
        ctx.fillStyle = colors[kind];
        for (const r of rects) if (r.kind === kind) ctx.fillRect(r.x, r.y, r.w, r.h);
      }
    };
    const measure = () => {
      list = marksOf.current?.(el) ?? [];
      visible = el.clientHeight;
      content = el.scrollHeight;
      box.dataset.marks = String(list.length);
      // Above a horizontal scrollbar, if the pane has one.
      box.style.bottom = `${Math.max(0, el.offsetHeight - el.clientHeight)}px`;
      setRuled(list.length > 0 || content > visible + 1);
      draw();
      place();
    };
    // At most one measure a frame, and while the content keeps changing (chunks streaming in,
    // code blocks highlighting as they near the viewport) one per MEASURE_GAP_MS.
    let frame = 0;
    let timer = 0;
    let last = -Infinity;
    let scrollFrame = 0;
    const schedule = () => {
      if (frame || timer) return;
      const run = () => { frame = requestAnimationFrame(() => { frame = 0; last = performance.now(); measure(); }); };
      const wait = last + MEASURE_GAP_MS - performance.now();
      if (wait > 0) timer = window.setTimeout(() => { timer = 0; run(); }, wait);
      else run();
    };
    remeasure.current = schedule;
    const onScroll = () => { if (!scrollFrame) scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; place(); }); };
    const pointer = bindRulerPointer(box, sl, {
      visible: () => el.clientHeight,
      content: () => el.scrollHeight,
      top: () => el.scrollTop,
      setTop: (t) => { el.scrollTop = t; },
    }, () => el.focus({ preventScroll: true }));
    const { release } = pointer;
    const changed = () => { pointer.follow(); schedule(); };
    // Resizes of the pane and of its top-level content (a chunk growing, a diagram drawn, a
    // virtual list's height).
    const ro = new ResizeObserver(changed);
    const observeKids = () => { ro.disconnect(); ro.observe(el); for (const k of el.children) ro.observe(k); };
    observeKids();
    const mo = new MutationObserver(() => { observeKids(); changed(); });
    mo.observe(el, { childList: true, subtree: watchContent });
    const offTheme = useTheme.subscribe(schedule);
    el.addEventListener('scroll', onScroll, { passive: true });
    // An image's load doesn't bubble: caught on its way down.
    el.addEventListener('load', changed, true);

    for (const type of ['wheel', 'keydown', 'pointerdown'] as const) el.addEventListener(type, release, { passive: true });
    schedule();
    return () => {
      remeasure.current = null;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      cancelAnimationFrame(scrollFrame);
      ro.disconnect();
      mo.disconnect();
      offTheme();
      pointer.dispose();
      for (const type of ['wheel', 'keydown', 'pointerdown'] as const) el.removeEventListener(type, release);
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('load', changed, true);
      setRuled(false);
    };
  }, [pane, active, split, watchContent]);
  // New marks (a table diff's rows): measured again, with the same listeners.
  useEffect(() => { remeasure.current?.(); }, [marks]);
  return (
    <div className={`ruler-frame${active && ruled ? ' ruler-ruled' : ''}${className ? ` ${className}` : ''}`} hidden={!active}>
      <div className="ruler-box">
        {children}
        {active && (
          <div ref={strip} className="ruler-strip" aria-hidden="true" hidden={!ruled}>
            <canvas ref={canvas} />
            <div ref={slider} className="ruler-slider" hidden />
          </div>
        )}
      </div>
      {after}
    </div>
  );
}
