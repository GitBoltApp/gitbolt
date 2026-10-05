import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyScrollWhenReady, noteScroll, PENDING_MS, registerScrollSource, SCROLL_WAIT_MS, scrollOf, scrollToAnchorWhenReady, setPendingScroll, takePendingScroll, useScrollPlace } from './scroll';

const tall = (el: HTMLElement, scrollHeight: number) => Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
const box = (scrollHeight: number) => {
  const el = document.createElement('div');
  tall(el, scrollHeight);
  document.body.append(el);
  return el;
};
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('scroll sources and noted scrolls', () => {
  it("the newest source of a tab and kind answers for its own place; a removed one leaves its last reading", () => {
    let top = 10;
    const off = registerScrollSource('t', 'file', 'file:a:x.md', () => top);
    expect(scrollOf('t', 'file', 'file:a:x.md')).toBe(10);
    expect(scrollOf('t', 'file', 'file:a:y.md')).toBeNull();
    expect(scrollOf('u', 'file', 'file:a:x.md')).toBeNull();
    top = 55;
    off();
    expect(scrollOf('t', 'file', 'file:a:x.md')).toBe(55);
  });

  it('a source that reads null (hidden) falls back to the last noted scroll', () => {
    noteScroll('t', 'mr', 'mr:12', 420);
    const off = registerScrollSource('t', 'mr', 'mr:12', () => null);
    expect(scrollOf('t', 'mr', 'mr:12')).toBe(420);
    off();
    expect(scrollOf('t', 'mr', 'mr:12')).toBe(420);
  });
});

describe('pending scrolls', () => {
  it('is taken once, by the same place and view', () => {
    setPendingScroll('t', 'file', { key: 'file:a:x.md', view: 'rendered', top: 120, anchor: null });
    expect(takePendingScroll('t', 'file', 'file:a:y.md', 'rendered')).toBeNull();
    expect(takePendingScroll('t', 'file', 'file:a:x.md', 'source')).toBeNull();
    expect(takePendingScroll('t', 'file', 'file:a:x.md', 'rendered')).toEqual({ key: 'file:a:x.md', view: 'rendered', top: 120, anchor: null });
    expect(takePendingScroll('t', 'file', 'file:a:x.md', 'rendered')).toBeNull();
  });

  it(`expires after ${PENDING_MS} ms`, () => {
    vi.useFakeTimers();
    setPendingScroll('t', 'mr', { key: 'mr:12', view: null, top: 50, anchor: null });
    vi.advanceTimersByTime(PENDING_MS + 1);
    expect(takePendingScroll('t', 'mr', 'mr:12', null)).toBeNull();
  });
});

describe('scrolling once the content is there', () => {
  it('waits for the content to be tall enough, then scrolls', () => {
    vi.useFakeTimers();
    const el = box(0);
    applyScrollWhenReady(el, 900);
    expect(el.scrollTop).toBe(0);
    tall(el, 2000); // clientHeight is 600 (test-setup)
    vi.advanceTimersByTime(20);
    expect(el.scrollTop).toBe(900);
  });

  it(`gives up after ${SCROLL_WAIT_MS} ms, as far down as it goes`, () => {
    vi.useFakeTimers();
    const el = box(1000);
    applyScrollWhenReady(el, 900);
    vi.advanceTimersByTime(SCROLL_WAIT_MS + 20);
    expect(el.scrollTop).toBe(400);
  });

  it('scrolls a heading anchor into view once it renders (user-content- prefixed or not)', () => {
    vi.useFakeTimers();
    const el = box(4000);
    el.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    scrollToAnchorWhenReady(el, 'usage');
    const h = document.createElement('h2');
    h.id = 'user-content-usage';
    h.getBoundingClientRect = () => ({ top: 750 }) as DOMRect;
    el.append(h);
    vi.advanceTimersByTime(20);
    expect(el.scrollTop).toBe(650);
  });
});

function Pane({ ready, active = true }: { ready: boolean; active?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollPlace({ tabId: 't', kind: 'mr', key: 'mr:12', el: () => ref.current, active, ready, view: null });
  return <div ref={ref} data-testid="pane" />;
}

describe('useScrollPlace', () => {
  it('applies a pending scroll once ready, and notes the scroll as it changes', async () => {
    setPendingScroll('t', 'mr', { key: 'mr:12', view: null, top: 300, anchor: null });
    const { rerender } = render(<Pane ready={false} />);
    const pane = screen.getByTestId('pane');
    tall(pane, 5000);
    rerender(<Pane ready />);
    await waitFor(() => expect(pane.scrollTop).toBe(300));
    pane.scrollTop = 120;
    fireEvent.scroll(pane);
    expect(scrollOf('t', 'mr', 'mr:12')).toBe(120);
  });

  it('inactive: neither notes nor takes', () => {
    setPendingScroll('t', 'mr', { key: 'mr:12', view: null, top: 300, anchor: null });
    render(<Pane ready active={false} />);
    expect(takePendingScroll('t', 'mr', 'mr:12', null)).toMatchObject({ top: 300 });
  });
});
