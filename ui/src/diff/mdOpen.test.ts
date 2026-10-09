import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STEP_MARGIN } from './changeStepper';
import { firstChangeTop, holdFirstChange, holdLine, OPEN_HOLD_MS } from './mdOpen';

/** A 600 px pane (test-setup's clientHeight) whose blocks sit at the given offsets in its content,
 * `[mark, top, height]`; `at` moves one later (a late relayout). */
function pane(rows: Array<[string | null, number, number]>) {
  const p = document.createElement('div');
  let top = 0;
  Object.defineProperty(p, 'scrollTop', { get: () => top, set: (v: number) => { top = Math.max(0, v); p.dispatchEvent(new Event('scroll')); } });
  p.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
  const els = rows.map(([mark, y, h]) => {
    const el = document.createElement('div');
    if (mark) el.setAttribute('data-diff-mark', mark);
    const box = { y, h };
    el.getBoundingClientRect = () => ({ top: 100 + box.y - top, bottom: 100 + box.y + box.h - top }) as DOMRect;
    p.append(el);
    return box;
  });
  document.body.append(p);
  return { p, at: (i: number, y: number) => { els[i]!.y = y; } };
}

describe('where a rendered diff opens', () => {
  it('at the top when the first change shows there whole', () => {
    expect(firstChangeTop(pane([[null, 0, 40], ['changed', 300, 40], ['added', 2000, 40]]).p)).toBe(0);
  });

  it('with the first change centred when it is further down', () => {
    expect(firstChangeTop(pane([[null, 0, 1500], ['removed', 1500, 40], ['added', 1540, 40]]).p)).toBe(1500 + 20 - 300);
  });

  it('a first change taller than the view starts a margin below the top', () => {
    expect(firstChangeTop(pane([[null, 0, 1500], ['changed', 1500, 2000]]).p)).toBe(1500 - STEP_MARGIN);
  });

  it('nowhere without a change', () => {
    expect(firstChangeTop(pane([[null, 0, 1500]]).p)).toBeNull();
  });
});

describe('holdFirstChange', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

  const relayout = async (p: HTMLElement) => { p.append(document.createElement('span')); await vi.advanceTimersByTimeAsync(20); };

  it('waits for the change to render, then goes to it', async () => {
    const { p } = pane([[null, 0, 1500]]);
    const stop = holdFirstChange(p);
    await vi.advanceTimersByTimeAsync(20);
    expect(p.scrollTop).toBe(0);
    const el = document.createElement('div');
    el.setAttribute('data-diff-mark', 'added');
    el.getBoundingClientRect = () => ({ top: 100 + 1500 - p.scrollTop, bottom: 100 + 1540 - p.scrollTop }) as DOMRect;
    p.append(el);
    await vi.advanceTimersByTimeAsync(20);
    expect(p.scrollTop).toBe(1220);
    stop();
  });

  it('holds the change through late relayouts (an image above it loading), then lets go', async () => {
    const { p, at } = pane([[null, 0, 1500], ['changed', 1500, 40]]);
    const stop = holdFirstChange(p);
    await vi.advanceTimersByTimeAsync(20);
    expect(p.scrollTop).toBe(1220);
    at(1, 1900);
    await relayout(p);
    expect(p.scrollTop).toBe(1620);
    await vi.advanceTimersByTimeAsync(OPEN_HOLD_MS + 50);
    at(1, 2500);
    await relayout(p);
    expect(p.scrollTop).toBe(1620);
    stop();
  });

  it('lets go once the user scrolls', async () => {
    const { p, at } = pane([[null, 0, 1500], ['changed', 1500, 40]]);
    const stop = holdFirstChange(p);
    await vi.advanceTimersByTimeAsync(20);
    p.scrollTop = 300;
    at(1, 1900);
    await relayout(p);
    expect(p.scrollTop).toBe(300);
    stop();
  });

  it('stops when stopped', async () => {
    const { p } = pane([[null, 0, 1500], ['changed', 1500, 40]]);
    holdFirstChange(p)();
    await vi.advanceTimersByTimeAsync(20);
    expect(p.scrollTop).toBe(0);
  });
});

describe('holdLine (review comments: a note opens the rendered diff at its line)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

  it("waits for the line's block to render (a later chunk), then goes to it", async () => {
    const p = document.createElement('div');
    let top = 0;
    Object.defineProperty(p, 'scrollTop', { get: () => top, set: (v: number) => { top = Math.max(0, v); } });
    p.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    document.body.append(p);
    const stop = holdLine(p, { side: 'modified', line: 7 });
    await vi.advanceTimersByTimeAsync(20);
    expect(top).toBe(0);
    const el = document.createElement('p');
    el.dataset.srcId = '3';
    el.dataset.srcNew = '6-8';
    el.getBoundingClientRect = () => ({ top: 100 + 2000 - top, bottom: 100 + 2040 - top }) as DOMRect;
    p.append(el);
    await vi.advanceTimersByTimeAsync(20);
    expect(top).toBe(2000 + 20 - 300);
    stop();
  });
});
