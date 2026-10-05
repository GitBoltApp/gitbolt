import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyScrollWhenReady, BLOCK_WAIT_MS, blockPosOf, noteScroll, PENDING_MS, registerScrollSource, SCROLL_WAIT_MS, scrollBlockOf, scrollOf, scrollToAnchorWhenReady, scrollToBlockWhenReady, setPendingScroll, takePendingScroll, useScrollPlace } from './scroll';

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

// --- final review: a long Markdown document comes back to its first visible block ---
const BLOCKS_PER_CHUNK = 4;
/** A long rendered document: `chunks` chunks of BLOCKS_PER_CHUNK blocks (block 0 of each a
 * heading), laid out at `chunkHeight` px a chunk (the pane's top at 0, 500 px tall). */
function LongDoc({ chunks, chunkHeight, ready = true }: { chunks: number; chunkHeight: number; ready?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useScrollPlace({ tabId: 't', kind: 'file', key: 'file:c:README.md', el: () => ref.current, active: true, ready, view: 'rendered', blocks: true });
  const h = chunkHeight / BLOCKS_PER_CHUNK;
  const at = (c: number, j: number) => (el: HTMLElement | null) => {
    if (!el) return;
    el.getBoundingClientRect = () => {
      const top = c * chunkHeight + j * h - el.closest<HTMLElement>('[data-testid="doc"]')!.scrollTop;
      return { top, bottom: top + h } as DOMRect;
    };
  };
  const pane = (el: HTMLDivElement | null) => {
    ref.current = el;
    if (!el) return;
    el.getBoundingClientRect = () => ({ top: 0, bottom: 500 }) as DOMRect;
    el.getClientRects = () => [{}] as unknown as DOMRectList;
  };
  return (
    <div ref={pane} data-testid="doc">
      <div className="md">
        {Array.from({ length: chunks }, (_, c) => (
          <div key={c} className="md-chunk">
            <h2 ref={at(c, 0)} id={`user-content-part-${c}`}>Part {c}</h2>
            {Array.from({ length: BLOCKS_PER_CHUNK - 1 }, (_, j) => <p key={j} ref={at(c, j + 1)}>text</p>)}
          </div>
        ))}
      </div>
    </div>
  );
}

describe('a long Markdown document (chunks with estimated heights)', () => {
  it('reports its first visible block and the offset past its top; a short one none', () => {
    render(<LongDoc chunks={40} chunkHeight={1000} />);
    const doc = screen.getByTestId('doc');
    doc.scrollTop = 25 * 1000 + 2 * 250 + 30;
    expect(scrollBlockOf('t', 'file', 'file:c:README.md')).toEqual({ block: 25 * BLOCKS_PER_CHUNK + 2, offset: 30 });
    const short = box(1000);
    short.innerHTML = '<div class="md"><h2>Short</h2></div>';
    expect(blockPosOf(short)).toBeNull();
  });

  it('Back to it puts the heading read last at the top, though the chunks above it hold placeholder heights, once its chunk renders', async () => {
    // Read with the real heights: scrolled to Part 30's heading.
    const first = render(<LongDoc chunks={40} chunkHeight={1000} />);
    const doc = screen.getByTestId('doc');
    doc.scrollTop = 30 * 1000;
    const block = scrollBlockOf('t', 'file', 'file:c:README.md');
    expect(block).toEqual({ block: 30 * BLOCKS_PER_CHUNK, offset: 0 });
    first.unmount();
    // Away and back: the chunks render a few at a time, at placeholder heights (600 px, not 1000).
    setPendingScroll('t', 'file', { key: 'file:c:README.md', view: 'rendered', top: 30_000, anchor: null, block });
    const back = render(<LongDoc chunks={10} chunkHeight={600} />);
    const again = screen.getByTestId('doc');
    for (const n of [20, 31, 40]) {
      await new Promise((r) => setTimeout(r, 30));
      back.rerender(<LongDoc chunks={n} chunkHeight={600} />);
    }
    // It asked for block 120 (Part 30's heading), not for scrollTop 30000 (Part 50: past the end).
    await waitFor(() => expect(again.scrollTop).toBe(30 * 600));
    expect(screen.getByRole('heading', { name: 'Part 30' }).getBoundingClientRect().top).toBe(0);
  });

  it('a short document restores its scrollTop', async () => {
    setPendingScroll('t', 'file', { key: 'file:c:README.md', view: 'rendered', top: 700, anchor: null, block: { block: 3, offset: 0 } });
    const { rerender } = render(<LongDoc chunks={0} chunkHeight={600} ready={false} />);
    tall(screen.getByTestId('doc'), 3000);
    rerender(<LongDoc chunks={0} chunkHeight={600} />);
    await waitFor(() => expect(screen.getByTestId('doc').scrollTop).toBe(700));
  });

  it('a wheel before the block arrives stops the restore', () => {
    vi.useFakeTimers();
    const el = box(4000);
    el.innerHTML = '<div class="md"><div class="md-chunk"><p>one</p></div></div>';
    scrollToBlockWhenReady(el, { block: 9, offset: 0 }, 2000);
    fireEvent.wheel(el);
    vi.advanceTimersByTime(BLOCK_WAIT_MS + 100);
    expect(el.scrollTop).toBe(0);
  });
});
