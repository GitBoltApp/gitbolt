// pdf.js (pdfjs-dist), loaded on the first PDF shown, never at startup. The PDF is parsed in
// pdf.js's own worker; pages draw to canvases, with its text layer over them for selection.
// Nothing here loosens the webview's CSP: the worker and the image codecs' WASM are the app's own
// files ('self'), pdf.js has no eval, and no annotation layer or PDF scripting is ever built (no
// links, forms or JavaScript from the document): annotations' appearances (stamps, filled-in
// fields, highlights) are drawn on the canvas, as pixels only.
import { canvasRatio, type PageSize } from './layout';

export interface PdfRender { promise: Promise<void>; cancel: () => void }

/** One page: its size in points, and its drawing at a zoom. */
export interface PdfPage {
  size: PageSize;
  /** Draws the page into `canvas` at `scale` (and the screen's pixel ratio). */
  render: (canvas: HTMLCanvasElement, scale: number) => PdfRender;
  /** Lays the page's text out in `container` at `scale`: transparent, selectable. */
  text: (container: HTMLElement, scale: number) => PdfRender;
}

export interface PdfDoc {
  pages: number;
  /** Page `n` (from 1), read once and kept. */
  page: (n: number) => Promise<PdfPage>;
  destroy: () => void;
}

/** Why a PDF couldn't be opened, in the viewer's words. */
export class PdfOpenError extends Error {}

type PdfJs = typeof import('pdfjs-dist');

/** The image codecs pdf.js asks the page for (JPEG 2000, JBIG2): fetched only by a PDF that
 * uses them. CMaps and the standard fonts aren't bundled: a PDF that needs them falls back to
 * the system's fonts. */
const CODECS = ['openjpeg.wasm', 'jbig2.wasm'] as const;

let loading: Promise<{ pdfjs: PdfJs; codecs: Record<string, string> }> | null = null;

function load() {
  return (loading ??= Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    import('pdfjs-dist/wasm/openjpeg.wasm?url'),
    import('pdfjs-dist/wasm/jbig2.wasm?url'),
  ]).then(([pdfjs, worker, openjpeg, jbig2]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    const codecs: Record<string, string> = { [CODECS[0]]: openjpeg.default, [CODECS[1]]: jbig2.default };
    return { pdfjs, codecs };
  }, (e: unknown) => { loading = null; throw e; }));
}

const aborted = () => new DOMException('The PDF is no longer shown', 'AbortError');

/** Opens a PDF from its bytes (pdf.js takes them over: pass a copy to keep them). `signal` stops
 * a slow open: its loading task (and its worker's parse) is destroyed, and this rejects. */
export async function openPdf(bytes: Uint8Array, signal?: AbortSignal): Promise<PdfDoc> {
  const { pdfjs, codecs } = await load();
  if (signal?.aborted) throw aborted();
  // pdf.js asks the page for its binary data (`useWorkerFetch: false`): only the codecs are served.
  class BinaryData {
    async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
      const url = kind === 'wasmUrl' ? codecs[filename] : undefined;
      if (!url) throw new Error(`${filename} isn't bundled`);
      return new Uint8Array(await (await fetch(url)).arrayBuffer());
    }
  }
  const task = pdfjs.getDocument({ data: bytes, useWorkerFetch: false, BinaryDataFactory: BinaryData, enableXfa: false, stopAtErrors: false });
  const abort = () => void task.destroy();
  signal?.addEventListener('abort', abort, { once: true });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (e) {
    void task.destroy();
    if (signal?.aborted) throw aborted();
    const name = (e as { name?: string } | null)?.name;
    throw new PdfOpenError(name === 'PasswordException' ? 'This PDF is password-protected' : name === 'InvalidPDFException' ? "This file isn't a valid PDF" : "This PDF couldn't be opened");
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  // Opened, but no longer wanted: the caller never gets it to destroy.
  if (signal?.aborted) {
    void task.destroy();
    throw aborted();
  }
  const pages = new Map<number, Promise<PdfPage>>();
  const read = async (n: number): Promise<PdfPage> => {
    const p = await doc.getPage(n);
    const base = p.getViewport({ scale: 1 });
    return {
      size: { w: base.width, h: base.height },
      render: (canvas, scale) => {
        const ratio = canvasRatio({ w: base.width, h: base.height }, scale, window.devicePixelRatio || 1);
        const viewport = p.getViewport({ scale: scale * ratio });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const task = p.render({ canvas, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE });
        return { promise: task.promise, cancel: () => task.cancel() };
      },
      text: (container, scale) => {
        container.replaceChildren();
        container.style.setProperty('--total-scale-factor', String(scale));
        const layer = new pdfjs.TextLayer({ textContentSource: p.streamTextContent(), container, viewport: p.getViewport({ scale }) });
        return { promise: layer.render(), cancel: () => layer.cancel() };
      },
    };
  };
  return {
    pages: doc.numPages,
    page: (n) => {
      let p = pages.get(n);
      if (!p) pages.set(n, (p = read(n)));
      return p;
    },
    // The loading task owns the document and its worker.
    destroy: () => void task.destroy(),
  };
}
