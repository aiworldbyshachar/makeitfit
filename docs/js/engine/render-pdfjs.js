// Renders PDF pages with pdf.js (vendored; it parses in its own worker). Used by step B and for previews.
import { pageRenderSize } from './pdf-shrink.js';

const base = new URL('../../vendor/pdfjs/', import.meta.url);
let lib = null;

export async function pdfjs() {
  if (!lib) {
    lib = await import('../../vendor/pdfjs/pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', base).href;
  }
  return lib;
}

// An OffscreenCanvas when the browser has one: its pixels move to the worker without a copy.
function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

/** Opens a PDF for rendering: { pageCount, pageSize(i), renderPage(i, dpi), close() }. */
export async function openPdfRenderer(bytes, { password } = {}) {
  const p = await pdfjs();
  const task = p.getDocument({
    data: bytes.slice(), // pdf.js takes ownership of the buffer
    cMapUrl: new URL('cmaps/', base).href,
    cMapPacked: true,
    wasmUrl: new URL('wasm/', base).href,
    iccUrl: new URL('iccs/', base).href,
    isEvalSupported: false,
    enableXfa: false,
    password,
  });
  const doc = await task.promise;
  return {
    pageCount: doc.numPages,
    async pageSize(i) {
      const page = await doc.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      return { width: vp.width, height: vp.height };
    },
    /** A white-backed raster ({ width, height, src: canvas }) of page i at `dpi`, capped to a safe size. */
    async renderPage(i, dpi) {
      const page = await doc.getPage(i + 1);
      const one = page.getViewport({ scale: 1 });
      const size = pageRenderSize(one.width, one.height, dpi);
      const viewport = page.getViewport({ scale: size.width / one.width });
      const width = Math.max(1, Math.round(viewport.width));
      const height = Math.max(1, Math.round(viewport.height));
      const c = makeCanvas(width, height);
      const ctx = c.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      await page.render({ canvasContext: ctx, canvas: c, viewport, intent: 'print' }).promise;
      page.cleanup();
      return { width, height, src: c };
    },
    close() {
      task.destroy();
    },
  };
}
