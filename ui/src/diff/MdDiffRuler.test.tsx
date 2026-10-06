import { act, render, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTheme } from '../theme/store';
import { THEMES } from '../theme/themes';
import { rulerColors } from './mdRuler';
import { MdDiffFrame } from './MdDiffRuler';

// jsdom does no layout: each element's box comes from its data-top / data-h, and the pane's
// scroll metrics from `metrics` (clientHeight is 600 everywhere, test-setup.ts).
const metrics = { scrollHeight: 2400 };
let fills: { style: string; rect: number[] }[] = [];

beforeEach(() => {
  fills = [];
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const el = this as HTMLElement;
    const top = Number(el.dataset?.top ?? 0) - (el.dataset?.top !== undefined ? scrolled(el) : 0);
    const height = Number(el.dataset?.h ?? 0);
    return { top, bottom: top + height, height, left: 0, right: 30, width: 30, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
  const ctx = {
    fillStyle: '',
    clearRect: vi.fn(),
    setTransform: vi.fn(),
    fillRect(x: number, y: number, w: number, h: number) { fills.push({ style: String(this.fillStyle), rect: [x, y, w, h] }); },
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => useTheme.getState().set('default-dark', {}));
});

/** The pane's scrollTop, for a mark's viewport position. */
const scrolled = (el: HTMLElement) => (el.closest('[data-testid="pane"]') as HTMLElement | null)?.scrollTop ?? 0;

type M = { top: number; h: number; mark: string };
function Harness({ marks, active = true, split = false }: { marks: M[]; active?: boolean; split?: boolean }) {
  const pane = useRef<HTMLDivElement>(null);
  return (
    <MdDiffFrame pane={pane} active={active} split={split}>
      <div
        ref={(el) => {
          pane.current = el;
          if (el && !Object.hasOwn(el, 'scrollHeight')) {
            let top = 0;
            Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => metrics.scrollHeight });
            Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v; } });
          }
        }}
        className="md-rendered md-diff-pane"
        data-testid="pane"
      >
        {marks.map((m, i) => <div key={i} data-diff-mark={m.mark} data-top={m.top} data-h={m.h}>change {i}</div>)}
        <p>unchanged</p>
      </div>
    </MdDiffFrame>
  );
}

const MARKS: M[] = [{ top: 0, h: 40, mark: 'removed' }, { top: 800, h: 80, mark: 'added' }, { top: 2000, h: 40, mark: 'changed' }];
const ruler = (c: HTMLElement) => c.querySelector<HTMLElement>('.md-diff-ruler');
const slider = (c: HTMLElement) => c.querySelector<HTMLElement>('.md-diff-ruler-slider')!;
const pane = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-testid="pane"]')!;

describe('the rendered Markdown diff overview ruler', () => {
  it('draws one mark per change the stepper counts, on a canvas, aria-hidden', async () => {
    const { container } = render(<Harness marks={[...MARKS, { top: 1200, h: 40, mark: 'pair' }]} />);
    await waitFor(() => expect(ruler(container)).toHaveAttribute('data-marks', '4'));
    expect(ruler(container)).toHaveAttribute('aria-hidden', 'true');
    expect(ruler(container)!.querySelectorAll('canvas')).toHaveLength(1);
    const c = rulerColors(THEMES['default-dark']);
    // 2400 px of content on a 600 px strip: a quarter. Inline: full width.
    expect(fills).toContainEqual({ style: c.added, rect: [0, 200, 30, 20] });
    expect(fills).toContainEqual({ style: c.removed, rect: [0, 0, 30, 10] });
    expect(fills).toContainEqual({ style: c.changed, rect: [0, 500, 30, 10] });
    expect(fills).toContainEqual({ style: c.changed, rect: [0, 300, 30, 10] });
    // The native scrollbar gives way to the ruler.
    expect(container.querySelector('.md-diff-frame')).toHaveClass('md-diff-ruled');
  });

  it('Split: removed on the left lane, added on the right', async () => {
    const { container } = render(<Harness marks={MARKS} split />);
    await waitFor(() => expect(ruler(container)).toHaveAttribute('data-marks', '3'));
    const c = rulerColors(THEMES['default-dark']);
    expect(fills).toContainEqual({ style: c.removed, rect: [0, 0, 15, 10] });
    expect(fills).toContainEqual({ style: c.added, rect: [15, 200, 15, 20] });
    expect(fills).toContainEqual({ style: c.changed, rect: [0, 500, 30, 10] });
  });

  it('no changes: no strip, and the native scrollbar stays', async () => {
    const { container } = render(<Harness marks={[]} />);
    await act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    expect(ruler(container)).not.toBeVisible();
    expect(container.querySelector('.md-diff-frame')).not.toHaveClass('md-diff-ruled');
  });

  it('not shown (Source): no strip', () => {
    const { container } = render(<Harness marks={MARKS} active={false} />);
    expect(ruler(container)).toBeNull();
  });

  it('the slider shows the visible part and follows the scroll, without re-measuring', async () => {
    const { container } = render(<Harness marks={MARKS} />);
    await waitFor(() => expect(ruler(container)).toHaveAttribute('data-marks', '3'));
    expect(slider(container).style.height).toBe('150px');
    const reads = vi.mocked(Element.prototype.getBoundingClientRect).mock.calls.length;
    act(() => { pane(container).scrollTop = 900; pane(container).dispatchEvent(new Event('scroll')); });
    await waitFor(() => expect(slider(container).style.transform).toBe('translateY(225px)'));
    expect(vi.mocked(Element.prototype.getBoundingClientRect).mock.calls.length).toBe(reads);
  });

  it('a click on the strip centres the view there; dragging the slider scrolls', async () => {
    const { container } = render(<Harness marks={MARKS} />);
    await waitFor(() => expect(ruler(container)).toHaveAttribute('data-marks', '3'));
    act(() => { ruler(container)!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientY: 300 })); });
    expect(pane(container).scrollTop).toBe(900);
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientY: 310 })); });
    expect(pane(container).scrollTop).toBe(940);
    act(() => { window.dispatchEvent(new MouseEvent('pointerup', { clientY: 310 })); });
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientY: 400 })); });
    expect(pane(container).scrollTop).toBe(940);
  });

  it('a click is the strip\'s own: it does not reach the panel (which would focus the editor)', async () => {
    const onClick = vi.fn();
    const { container } = render(<div onClick={onClick}><Harness marks={MARKS} /></div>);
    await waitFor(() => expect(ruler(container)).toHaveAttribute('data-marks', '3'));
    act(() => { ruler(container)!.click(); });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('the wheel over the strip scrolls the pane', async () => {
    const { container } = render(<Harness marks={MARKS} />);
    await waitFor(() => expect(ruler(container)).toHaveAttribute('data-marks', '3'));
    act(() => { ruler(container)!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 })); });
    expect(pane(container).scrollTop).toBe(120);
  });

  it('streamed chunks: a change added to the pane is drawn', async () => {
    const { container } = render(<Harness marks={MARKS} />);
    await waitFor(() => expect(ruler(container)).toHaveAttribute('data-marks', '3'));
    act(() => {
      const el = document.createElement('div');
      el.dataset.diffMark = 'added';
      el.dataset.top = '1600';
      el.dataset.h = '40';
      pane(container).append(el);
    });
    await waitFor(() => expect(ruler(container)).toHaveAttribute('data-marks', '4'));
  });

  it('follows the theme', async () => {
    const { container } = render(<Harness marks={MARKS} />);
    await waitFor(() => expect(ruler(container)).toHaveAttribute('data-marks', '3'));
    fills = [];
    act(() => useTheme.getState().set('light', {}));
    const c = rulerColors(THEMES.light);
    await waitFor(() => expect(fills).toContainEqual({ style: c.added, rect: [0, 200, 30, 20] }));
  });
});
