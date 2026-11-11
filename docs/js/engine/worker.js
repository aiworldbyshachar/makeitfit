// Runs the heavy work off the page so it never freezes: decoding (HEIC too), resizing, JPEG encoding
// (OffscreenCanvas), and building / rewriting PDFs with pdf-lib.
// Step B needs pdf.js to render pages, which happens on the page; the rendered pages come here as
// ImageBitmaps ("raster-*" commands) so all resizing and encoding still runs in this worker.
import { makeItFit, splitToFit, describe } from './pipeline.js';
import { createBrowserCodec } from './codec-browser.js';

const codec = createBrowserCodec();
const rasters = new Map();
let nextRaster = 1;

function keep(raster) {
  const id = nextRaster++;
  rasters.set(id, raster);
  return { id, width: raster.width, height: raster.height };
}

function transferables(result) {
  const list = [];
  const add = (b) => b?.buffer instanceof ArrayBuffer && !list.includes(b.buffer) && list.push(b.buffer);
  for (const o of result?.outputs || []) add(o.bytes);
  add(result?.source);
  add(result?.bytes);
  return list;
}

const commands = {
  describe: (args) => describe(args.file),
  fit: (args, progress) => makeItFit(args, { codec }, progress),
  split: (args, progress) => splitToFit(args, { codec }, progress),
  'raster-put': ({ bitmap }) => keep({ width: bitmap.width, height: bitmap.height, src: bitmap }),
  'raster-resize': async ({ id, side }) => {
    const r = rasters.get(id);
    const scaled = await codec.resize(r, side);
    return scaled === r ? { id, width: r.width, height: r.height } : keep(scaled);
  },
  'raster-encode': async ({ id, quality }) => ({ bytes: await codec.encodeJpeg(rasters.get(id), quality) }),
  'raster-release': ({ id }) => {
    codec.release(rasters.get(id));
    rasters.delete(id);
    return true;
  },
};

self.onmessage = async ({ data }) => {
  const { id, cmd, args } = data;
  const progress = (p) => self.postMessage({ id, progress: p });
  try {
    if (!commands[cmd]) throw new Error(`unknown command ${cmd}`);
    const result = await commands[cmd](args, progress);
    self.postMessage({ id, result }, transferables(result));
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
