import { scrollTopAt, sliderPointAt, wheelPixels } from './mdRuler';

/** How long after a release the view still follows the content: a quick click's jump lays out
 * its chunk a frame or two later (measured: under 50 ms). */
export const SETTLE_MS = 250;

/** The scroll view a ruler drives, read fresh each time (its metrics move under a press). */
export interface RulerScroll {
  visible(): number;
  content(): number;
  top(): number;
  setTop(top: number): void;
}

/**
 * The ruler's pointer on `box` (the strip), `slider` its viewport slider: a press on the track
 * centres the view there and drags on, a press on the slider drags holding the point grabbed, and
 * the wheel scrolls. A press holds the grabbed point (`at`, a fraction of the slider's height) on
 * the pointer, with the view's metrics of that moment, not the last measure's: content that lays
 * out under the press (a chunk at its real height) moves the slider at once. Moving the pointer,
 * or `follow` (the content changing), puts it back, and the content changing still does for
 * SETTLE_MS after the release, unless the user moves on (`release`).
 */
export function bindRulerPointer(box: HTMLElement, slider: HTMLElement, view: RulerScroll, onPress?: () => void) {
  let drag: { y: number; at: number } | null = null;
  let settle = 0;
  const release = () => {
    clearTimeout(settle);
    settle = 0;
    drag = null;
  };
  const follow = () => {
    if (!drag) return;
    const h = view.visible();
    view.setTop(scrollTopAt(drag.y - box.getBoundingClientRect().top, h, view.content(), h, drag.at));
  };
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    drag.y = e.clientY;
    follow();
  };
  const onUp = () => {
    if (drag && !settle) settle = window.setTimeout(release, SETTLE_MS);
    slider.classList.remove('ruler-active');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    onPress?.();
    // On the track, the view jumps to centre there; on the slider, the drag holds the point grabbed.
    const h = view.visible();
    release();
    const at = e.target === slider ? sliderPointAt(e.clientY - box.getBoundingClientRect().top, h, view.content(), view.top(), h) : 0.5;
    drag = { y: e.clientY, at };
    follow();
    slider.classList.add('ruler-active');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    release();
    view.setTop(view.top() + wheelPixels(e, view.visible()));
  };
  const onClick = (e: MouseEvent) => e.stopPropagation();
  box.addEventListener('pointerdown', onDown);
  box.addEventListener('wheel', onWheel, { passive: false });
  box.addEventListener('click', onClick);
  return {
    follow,
    release,
    dispose() {
      box.removeEventListener('pointerdown', onDown);
      box.removeEventListener('wheel', onWheel);
      box.removeEventListener('click', onClick);
      onUp();
      release();
    },
  };
}
