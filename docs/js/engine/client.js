// The page's side of the engine: sends jobs to the worker, and runs step B (pdf.js rendering) on the page
// when the user has agreed to turn pages into images. Even then, every rendered page is handed to the
// worker for resizing and JPEG encoding, so the page stays responsive (and a background tab, whose
// canvas encoding the browser slows down, still runs at full speed).
import { rasterize, splitToFit } from './pipeline.js';
import { openPdfRenderer } from './render-pdfjs.js';

export function createEngine() {
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const pending = new Map();
  let next = 1;
  worker.onmessage = ({ data }) => {
    const job = pending.get(data.id);
    if (!job) return;
    if (data.progress) return job.onProgress?.(data.progress);
    pending.delete(data.id);
    if (data.error) job.reject(new Error(data.error));
    else job.resolve(data.result);
  };
  const call = (cmd, args, onProgress, transfer = []) =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject, onProgress });
      worker.postMessage({ id, cmd, args }, transfer);
    });

  const pageEnv = { codec: createWorkerCodec(call), openRenderer: (bytes) => openPdfRenderer(bytes) };

  return {
    /** Exact facts for a dropped file. */
    describe: (file) => call('describe', { file }),
    /** The job (see pipeline.js makeItFit). Step B is never run here - it returns 'ask-rasterize'. */
    fit: (job, onProgress) => call('fit', { ...job, allowRasterize: false }, onProgress),
    /** Step B after the user said yes. */
    rasterize: (source, limit, name, onProgress) => rasterize(source, limit, pageEnv, onProgress, name),
    /** Split into parts; 'pages' mode renders on the page, the others run in the worker. */
    split: (args, onProgress) => (args.mode === 'pages' ? splitToFit(args, pageEnv, onProgress) : call('split', args, onProgress)),
    terminate: () => worker.terminate(),
  };
}

/**
 * A codec for rasters rendered on the page: the first time a raster is used, its pixels move to the
 * worker as an ImageBitmap (transferred, not copied); resize / encode / release then run there.
 * Same interface as codec-browser.js for what step B needs.
 */
export function createWorkerCodec(call) {
  async function upload(r) {
    if (r.id) return r.id;
    const src = r.src;
    const bitmap = typeof src.transferToImageBitmap === 'function' ? src.transferToImageBitmap() : await createImageBitmap(src);
    if ('width' in src) {
      src.width = 0;
      src.height = 0;
    }
    r.src = null;
    const h = await call('raster-put', { bitmap }, null, [bitmap]);
    r.id = h.id;
    return r.id;
  }
  return {
    async resize(r, side) {
      const id = await upload(r);
      const h = await call('raster-resize', { id, side });
      return h.id === id ? r : { width: h.width, height: h.height, id: h.id };
    },
    async encodeJpeg(r, quality) {
      const id = await upload(r);
      return (await call('raster-encode', { id, quality })).bytes;
    },
    release(r) {
      if (!r || r.shared) return;
      if (r.id) call('raster-release', { id: r.id });
      else if (r.src && 'width' in r.src) {
        r.src.width = 0;
        r.src.height = 0;
      }
      r.id = null;
      r.src = null;
    },
    decodeImage() {
      throw new Error('decode runs in the worker');
    },
    fromRGBA() {
      throw new Error('decode runs in the worker');
    },
  };
}
