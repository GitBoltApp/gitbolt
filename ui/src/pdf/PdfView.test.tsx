import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import { isHex, isMedia } from '../diff/DiffPanel';
import { wantsHex } from '../diff/hexContents';
import { ZOOM_STEPS } from '../image/zoom';
import { columnHeight, pageTops, syncedScrollTop } from './layout';
import { isPdf } from './kind';
import type { PdfDoc } from './pdfjs';
import { decode, PdfView } from './PdfView';

// jsdom has no canvas and no pdf.js worker: a stand-in document whose bytes say how many pages it
// has ("pages:3"), or why it can't be opened ("error:…").
const renders: number[] = [];
/** Text layers held back by a test, until it lays them out. */
let heldText: (() => void)[] | null = null;
vi.mock('./pdfjs', async (actual) => {
  const real = await actual<typeof import('./pdfjs')>();
  return {
    ...real,
    openPdf: vi.fn(async (bytes: Uint8Array, _signal?: AbortSignal): Promise<PdfDoc> => {
      const text = new TextDecoder().decode(bytes);
      if (text.startsWith('error:')) throw new real.PdfOpenError(text.slice(6));
      const pages = Number(/pages:(\d+)/.exec(text)?.[1] ?? 1);
      // "tall:2": page 2 is taller than the rest.
      const tall = Number(/tall:(\d+)/.exec(text)?.[1] ?? 0);
      return {
        pages,
        page: async (n) => ({
          size: { w: 612, h: n === tall ? 1000 : 792 },
          render: () => {
            renders.push(n);
            return { promise: Promise.resolve(), cancel: () => {} };
          },
          // Appends its text later, as pdf.js's layer does (at once, or when a test holds it
          // back, when it lets go), unless cancelled first.
          text: (container) => {
            let cancelled = false;
            let done = () => {};
            const promise = new Promise<void>((resolve) => { done = resolve; });
            const lay = () => {
              if (!cancelled) {
                const span = document.createElement('span');
                span.textContent = `Lighthouse survey, page ${n}`;
                container.append(span);
              }
              done();
            };
            if (heldText) heldText.push(lay);
            else queueMicrotask(lay);
            return { promise, cancel: () => { cancelled = true; } };
          },
        }),
        destroy: () => {},
      };
    }),
  };
});

const pdf = (text: string, size = 4096) => ({ base64: btoa(text), size });
const stepOf = (s: (typeof ZOOM_STEPS)[number]) => String(ZOOM_STEPS.indexOf(s));
const pages = (pane: HTMLElement) => Array.from(pane.querySelectorAll<HTMLElement>('.pdf-page'));

/** jsdom keeps no scroll position: a pane that scrolls as a browser's does, clamped to its
 * column's end (the test setup's panes are 600 px tall), with a scroll event after each change. */
function scrollable(el: HTMLElement) {
  let top = 0;
  let left = 0;
  const max = () => Math.max(0, parseFloat(el.querySelector<HTMLElement>('.pdf-column')?.style.height ?? '0') - 600);
  const changed = () => queueMicrotask(() => el.dispatchEvent(new Event('scroll')));
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { const next = Math.min(max(), Math.max(0, v)); if (next !== top) { top = next; changed(); } } });
  Object.defineProperty(el, 'scrollLeft', { configurable: true, get: () => left, set: (v: number) => { if (v !== left) { left = v; changed(); } } });
}

/** Scrolls `el` as the user would, and lets the scroll events it causes run. */
async function scrollTo(el: HTMLElement, top: number, left?: number) {
  await act(async () => {
    el.scrollTop = top;
    if (left !== undefined) el.scrollLeft = left;
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

afterEach(() => {
  renders.length = 0;
  heldText = null;
});

describe('PdfView', () => {
  it('File View: every page reserves its size, the first ones are drawn with their text, and the toolbar counts them', async () => {
    render(<PdfView old={null} new={pdf('pages:3')} />);
    await waitFor(() => expect(screen.getByTestId('pdf-pages')).toHaveTextContent('3 pages'));
    expect(screen.getByTestId('pdf-meta')).toHaveTextContent(/^Page 1 · 3 pages · 4\.0 KB$/);
    const pane = screen.getByRole('document', { name: 'PDF' });
    const letters = [{ w: 612, h: 792 }, { w: 612, h: 792 }, { w: 612, h: 792 }];
    // The column holds all three; the two near the view are mounted (the test setup's panes are 600 px tall).
    expect(pane.querySelector<HTMLElement>('.pdf-column')!.style.height).toBe(`${columnHeight(letters, 1)}px`);
    expect(pages(pane).map((p) => [p.style.width, p.style.height])).toEqual([['612px', '792px'], ['612px', '792px']]);
    expect(pages(pane).map((p) => p.style.top)).toEqual(pageTops(letters, 1).slice(0, 2).map((t) => `${t}px`));
    // Only the pages near the view are drawn (the test setup's panes are 600 px tall: the first two).
    await waitFor(() => expect(within(pane).getByText('Lighthouse survey, page 1')).toBeInTheDocument());
    expect(renders).toEqual([1, 2]);
    expect(screen.queryByText('Old')).toBeNull();
  });

  it('a zoom cancels the text layer still being laid out: the page ends with one', async () => {
    const held: (() => void)[] = [];
    heldText = held;
    const { container } = render(<PdfView old={null} new={pdf('pages:1')} />);
    await waitFor(() => expect(held).toHaveLength(1));
    // Zoomed while the first layout is still running: it's cancelled, and the second one starts.
    fireEvent.change(screen.getByRole('slider', { name: 'Zoom' }), { target: { value: stepOf(0.5) } });
    await waitFor(() => expect(held).toHaveLength(2));
    act(() => held.forEach((lay) => lay()));
    expect(container.querySelectorAll('.textLayer span')).toHaveLength(1);
  });

  it('keeps the toolbar\'s "Page N ·" room while the PDF opens and for its longest page number', async () => {
    const { openPdf } = await import('./pdfjs');
    const opens = vi.mocked(openPdf).getMockImplementation()!;
    let open: () => void = () => {};
    vi.mocked(openPdf).mockImplementationOnce((bytes) => new Promise((resolve) => { open = () => resolve(opens(bytes)); }));
    render(<PdfView old={null} new={pdf('pages:120')} />);
    const slot = screen.getByTestId('pdf-page').parentElement!;
    expect(slot).toHaveStyle({ visibility: 'hidden' });
    await act(async () => open());
    await waitFor(() => expect(slot).not.toHaveStyle({ visibility: 'hidden' }));
    expect(slot.style.minWidth).toBe('8ch');
    expect(screen.getByTestId('pdf-page')).toHaveTextContent('Page 1');
  });

  it('a long PDF mounts only the pages near the view, with every page\'s height kept; sizes come in behind the first', async () => {
    const { container } = render(<PdfView old={null} new={pdf('pages:2000;tall:1500')} />);
    await waitFor(() => expect(screen.getByTestId('pdf-pages')).toHaveTextContent('2000 pages'));
    const pane = screen.getByRole('document', { name: 'PDF' });
    const sizes = Array.from({ length: 2000 }, (_, i) => ({ w: 612, h: i === 1499 ? 1000 : 792 }));
    // Page 1500's own size arrives in a later batch.
    await waitFor(() => expect(container.querySelector<HTMLElement>('.pdf-column')!.style.height).toBe(`${columnHeight(sizes, 1)}px`));
    expect(pages(pane)).toHaveLength(2);
    scrollable(pane);
    const tops = pageTops(sizes, 1);
    await scrollTo(pane, tops[1499]);
    expect(pages(pane).map((p) => p.style.top)).toEqual([1498, 1499, 1500].map((i) => `${tops[i]}px`));
    expect(pages(pane)[1].style.height).toBe('1000px');
    expect(screen.getByTestId('pdf-page')).toHaveTextContent('Page 1500');
  });

  it('zooms by the slider, Ctrl+wheel and Fit width, keeping every page box in step', async () => {
    const { container } = render(<PdfView old={null} new={pdf('pages:2')} />);
    await waitFor(() => expect(screen.getByTestId('pdf-pages')).toHaveTextContent('2 pages'));
    const fit = screen.getByRole('button', { name: 'Fit width' });
    expect(fit).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getByRole('slider', { name: 'Zoom' }), { target: { value: stepOf(0.5) } });
    expect(screen.getByTestId('pdf-zoom')).toHaveTextContent('50%');
    expect(fit).toHaveAttribute('aria-pressed', 'false');
    expect(pages(container).map((p) => p.style.width)).toEqual(['306px', '306px']);
    const stage = container.querySelector('.pdf-stage')!;
    act(() => { stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })); });
    expect(screen.getByTestId('pdf-zoom')).toHaveTextContent('67%');
    // A plain wheel scrolls; it doesn't zoom.
    act(() => { stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })); });
    expect(screen.getByTestId('pdf-zoom')).toHaveTextContent('67%');
    fireEvent.click(fit);
    expect(fit).toHaveAttribute('aria-pressed', 'true');
    // jsdom's pane has no width: Fit width falls back to 100%.
    expect(screen.getByTestId('pdf-zoom')).toHaveTextContent('100%');
  });

  it('Diff View: both versions side by side, labelled, and scrolling one scrolls the other to the same page', async () => {
    render(<PdfView old={pdf('pages:3', 4096)} new={pdf('pages:4', 5120)} />);
    await waitFor(() => expect(screen.getByTestId('pdf-pages')).toHaveTextContent('3 pages → 4 pages'));
    expect(screen.getByTestId('pdf-meta')).toHaveTextContent('4.0 KB → 5.0 KB');
    expect(screen.getByText('Old')).toBeInTheDocument();
    expect(screen.getByText('New')).toBeInTheDocument();
    const old = screen.getByRole('document', { name: 'Old PDF' });
    const neu = screen.getByRole('document', { name: 'New PDF' });
    await waitFor(() => expect(neu.querySelector<HTMLElement>('.pdf-column')).not.toBeNull());
    scrollable(old);
    scrollable(neu);
    const letter = { w: 612, h: 792 };
    const three = { sizes: [letter, letter, letter], scale: 1 };
    const four = { sizes: [letter, letter, letter, letter], scale: 1 };
    await scrollTo(old, 1000, 30);
    expect(neu.scrollTop).toBeCloseTo(syncedScrollTop(three, four, 1000));
    expect(neu.scrollLeft).toBe(30);
    expect(old.scrollTop).toBe(1000);
    expect(screen.getByTestId('pdf-page')).toHaveTextContent('Page 2');
    // Scrolling the new side leads the old one in turn.
    await scrollTo(neu, 20);
    expect(old.scrollTop).toBeCloseTo(20);
    // The longer side scrolls on past the shorter one's end: the old side stops at its end
    // (clamped), and that clamped scroll doesn't pull the new side back.
    const oldEnd = columnHeight(three.sizes, 1) - 600;
    await scrollTo(neu, 2500);
    expect(old.scrollTop).toBe(oldEnd);
    expect(neu.scrollTop).toBe(2500);
    // A zoom keeps each side on its own place (each clamped to its new end), neither leading the other.
    const at = (sizes: typeof four.sizes, top: number) => Math.min(columnHeight(sizes, 0.5) - 600, syncedScrollTop({ sizes, scale: 1 }, { sizes, scale: 0.5 }, top));
    await act(async () => {
      fireEvent.change(screen.getByRole('slider', { name: 'Zoom' }), { target: { value: stepOf(0.5) } });
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(neu.scrollTop).toBeCloseTo(at(four.sizes, 2500));
    expect(old.scrollTop).toBeCloseTo(at(three.sizes, oldEnd));
  });

  it('an added PDF shows its one side, said so; one that can\'t be opened says why', async () => {
    const { unmount } = render(<PdfView old={null} new={pdf('pages:1', 70)} single="added" />);
    await waitFor(() => expect(screen.getByTestId('pdf-meta')).toHaveTextContent(/^Page 1 · 1 page · 70 B \(added\)$/));
    unmount();
    render(<PdfView old={null} new={pdf('error:This PDF is password-protected')} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('This PDF is password-protected');
  });

  it('a PDF no longer shown stops opening', async () => {
    const { openPdf } = await import('./pdfjs');
    const { unmount } = render(<PdfView old={null} new={pdf('pages:1')} />);
    const signal = vi.mocked(openPdf).mock.lastCall![1]!;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it('Hex shows the source instead of the pages, and says so to the panel', async () => {
    const onSourceChange = vi.fn();
    const { unmount } = render(<PdfView old={null} new={pdf('pages:1')} source={<div>hex dump</div>} onSourceChange={onSourceChange} />);
    const hex = screen.getByRole('button', { name: 'Hex' });
    fireEvent.click(hex);
    expect(hex).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('hex dump')).toBeInTheDocument();
    expect(screen.queryByRole('document')).toBeNull();
    expect(onSourceChange).toHaveBeenLastCalledWith(true);
    unmount();
    expect(onSourceChange).toHaveBeenLastCalledWith(false);
  });
});

describe('decode', () => {
  it('reads base64 natively where the engine can, else through atob, to the same bytes', () => {
    const b64 = btoa('%PDF-1.7\n\u00e2\u00e3');
    const expected = Uint8Array.from('%PDF-1.7\n\u00e2\u00e3', (c) => c.charCodeAt(0));
    const native = vi.fn((_s: string) => expected);
    vi.stubGlobal('Uint8Array', Object.assign(class extends Uint8Array {}, { fromBase64: native }));
    try {
      expect(decode(b64)).toBe(expected);
      expect(native).toHaveBeenCalledWith(b64);
    } finally {
      vi.unstubAllGlobals();
    }
    vi.stubGlobal('Uint8Array', Object.assign(class extends Uint8Array {}, { fromBase64: undefined }));
    try {
      expect(Array.from(decode(b64))).toEqual(Array.from(expected));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('a PDF in the diff panel', () => {
  const contents = (over: Partial<DiffContentsPayload>): DiffContentsPayload => ({
    old: null,
    new: { size: 9, binary: true, encoding: '', eol: 'none', text: null, base64: btoa('%PDF-1.4'), hash: null },
    tooLarge: false, eolOnly: false, image: false, ...over,
  });
  const target = { path: 'docs/survey.pdf' } as Parameters<typeof isHex>[0];

  it('shows as pages, not hex; a large one keeps the load-anyway prompt', () => {
    expect(isPdf(contents({ pdf: true }))).toBe(true);
    expect(isHex(target, contents({ pdf: true }))).toBe(false);
    expect(wantsHex(contents({ pdf: true }))).toBe(false);
    expect(isPdf(contents({ pdf: true, tooLarge: true }))).toBe(false);
    // Without the flag (another extension): a binary, as before.
    expect(isPdf(contents({}))).toBe(false);
    expect(isHex(target, contents({}))).toBe(true);
  });

  it('a side without its bytes (a Git LFS pointer named .pdf) isn\'t shown as pages; a PDF is never media', () => {
    const pointer = { size: 120, binary: false, encoding: 'UTF-8', eol: 'lf' as const, text: 'version https://git-lfs.github.com/spec/v1\n', base64: null, hash: null };
    expect(isPdf(contents({ pdf: true, new: pointer }))).toBe(false);
    expect(isPdf(contents({ pdf: true, old: pointer }))).toBe(false);
    expect(isPdf(contents({ pdf: true, new: null }))).toBe(false);
    expect(isMedia(target, contents({ pdf: true }))).toBe(false);
  });
});
