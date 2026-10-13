import { afterEach, describe, expect, it } from 'vitest';
import { bindRulerPointer } from './rulerPointer';

// A 100 px view on 1000 px of content: its slider is MIN_SLIDER_PX (20) tall, and moves
// (100 - 20) / (1000 - 100) px per scrolled px.
const VISIBLE = 100;
const CONTENT = 1000;

function setup() {
  const box = document.createElement('div');
  const slider = document.createElement('div');
  box.appendChild(slider);
  document.body.appendChild(box);
  box.getBoundingClientRect = () => ({ top: 50 }) as DOMRect;
  const view = { top: 0 };
  const bound = bindRulerPointer(box, slider, {
    visible: () => VISIBLE,
    content: () => CONTENT,
    top: () => view.top,
    setTop: (t) => { view.top = Math.min(Math.max(0, t), CONTENT - VISIBLE); },
  });
  const press = (target: HTMLElement, y: number) => target.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientY: y, bubbles: true, cancelable: true }));
  const move = (y: number) => window.dispatchEvent(new PointerEvent('pointermove', { clientY: y }));
  const up = () => window.dispatchEvent(new PointerEvent('pointerup'));
  return { box, slider, view, bound, press, move, up };
}

describe('bindRulerPointer', () => {
  let bound: ReturnType<typeof bindRulerPointer> | undefined;
  afterEach(() => { bound?.dispose(); document.body.replaceChildren(); });

  it('a press on the track centres the view there, and the drag follows', () => {
    const t = setup();
    bound = t.bound;
    // Strip y 50 centres the 20 px slider: its top at 40.
    t.press(t.box, 100);
    expect(t.view.top).toBeCloseTo((50 - 10) / (80 / 900), 5);
    expect(t.slider.classList.contains('ruler-active')).toBe(true);
    t.move(130);
    expect(t.view.top).toBeCloseTo((80 - 10) / (80 / 900), 5);
    t.up();
    expect(t.slider.classList.contains('ruler-active')).toBe(false);
    t.move(60);
    expect(t.view.top).toBeCloseTo((80 - 10) / (80 / 900), 5);
  });

  it('a press on the slider holds the grabbed point', () => {
    const t = setup();
    bound = t.bound;
    t.view.top = 450;
    // Slider top = 450 * 80/900 = 40, height 20: grab it at its 3/4 (strip y 55).
    t.press(t.slider, 50 + 55);
    expect(t.view.top).toBeCloseTo(450, 5);
    t.move(50 + 65);
    expect(t.view.top).toBeCloseTo(450 + 10 / (80 / 900), 5);
    t.up();
  });

  it('the wheel scrolls', () => {
    const t = setup();
    bound = t.bound;
    const e = new WheelEvent('wheel', { deltaY: 120, cancelable: true, bubbles: true });
    t.box.dispatchEvent(e);
    expect(t.view.top).toBe(120);
    expect(e.defaultPrevented).toBe(true);
  });
});
