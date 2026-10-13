import { describe, expect, it, vi } from 'vitest';

// pdf.js itself, stubbed: a loading task that never finishes (a slow parse), or one that fails.
const destroy = vi.fn(async () => {});
const getDocument = vi.fn((_src: unknown) => {
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise((_, r) => { reject = r; });
  void promise.catch(() => {});
  destroy.mockImplementation(async () => reject(new Error('Worker was destroyed')));
  return { promise, destroy };
});
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument, AnnotationMode: { DISABLE: 0, ENABLE: 1 }, TextLayer: class {} }));

const { openPdf } = await import('./pdfjs');

describe('openPdf', () => {
  it('a slow open stops when its signal aborts: the loading task is destroyed, and it rejects', async () => {
    const stop = new AbortController();
    const opening = openPdf(new Uint8Array([37, 80, 68, 70]), stop.signal);
    await vi.waitFor(() => expect(getDocument).toHaveBeenCalled());
    stop.abort();
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(destroy).toHaveBeenCalled();
  });

  it('draws annotations\' appearances on the canvas (no DOM layer)', async () => {
    const render = vi.fn((_params: { annotationMode: number }) => ({ promise: Promise.resolve(), cancel: () => {} }));
    const page = { getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }), render };
    getDocument.mockImplementationOnce(() => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => page }), destroy }));
    const doc = await openPdf(new Uint8Array([37]));
    (await doc.page(1)).render(document.createElement('canvas'), 1);
    expect(render.mock.lastCall![0].annotationMode).toBe(1);
  });

  it('an already aborted signal opens nothing', async () => {
    getDocument.mockClear();
    const stop = new AbortController();
    stop.abort();
    await expect(openPdf(new Uint8Array([37]), stop.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(getDocument).not.toHaveBeenCalled();
  });
});
