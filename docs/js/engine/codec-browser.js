// The browser codec: decodes photos (HEIC through libheif only when the browser can't do it itself),
// resizes with canvas, encodes JPEG. Works on the page and inside a Web Worker (OffscreenCanvas).
// Re-encoding through a canvas drops every bit of metadata, including GPS location.
import { scaledSize } from './images.js';

const hasOffscreen = typeof OffscreenCanvas !== 'undefined';

function makeCanvas(width, height) {
  if (hasOffscreen) return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

function context(c) {
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

async function canvasToBytes(c, type, quality) {
  const blob = c.convertToBlob
    ? await c.convertToBlob({ type, quality })
    : await new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, quality));
  return new Uint8Array(await blob.arrayBuffer());
}

let heifModule = null;
/** libheif (LGPL, vendored as a separate file) - loaded the first time a HEIC needs it. */
async function libheif() {
  if (!heifModule) {
    heifModule = import('../../vendor/libheif/libheif-bundle.mjs').then(async (m) => {
      const lib = m.default();
      return typeof lib?.then === 'function' && !lib.HeifDecoder ? await lib : lib;
    });
  }
  return heifModule;
}

export let heifLoaded = false;

async function decodeHeif(bytes) {
  const lib = await libheif();
  heifLoaded = true;
  const decoder = new lib.HeifDecoder();
  const images = decoder.decode(bytes);
  if (!images.length) throw new Error('This HEIC photo could not be read');
  const image = images.find((i) => i.is_primary?.()) || images[0];
  const width = image.get_width();
  const height = image.get_height();
  const data = await new Promise((resolve, reject) => {
    image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (d) => (d ? resolve(d) : reject(new Error('HEIC decode failed'))));
  });
  for (const i of images) i.free?.();
  const c = makeCanvas(width, height);
  c.getContext('2d').putImageData(new ImageData(data.data, width, height), 0, 0);
  return c;
}

function rotated(raster, degrees) {
  const d = ((degrees % 360) + 360) % 360;
  if (!d) return raster;
  const swap = d === 90 || d === 270;
  const w = swap ? raster.height : raster.width;
  const h = swap ? raster.width : raster.height;
  const c = makeCanvas(w, h);
  const ctx = context(c);
  ctx.translate(w / 2, h / 2);
  ctx.rotate((d * Math.PI) / 180);
  ctx.drawImage(raster.src, -raster.width / 2, -raster.height / 2);
  return { width: w, height: h, src: c };
}

function releaseSource(src) {
  if (!src) return;
  if (typeof src.close === 'function') src.close();
  else if ('width' in src) {
    src.width = 0;
    src.height = 0;
  }
}

export function createBrowserCodec() {
  return {
    /** bytes -> raster ({ width, height, src }), upright (EXIF orientation applied), rotated by `rotate`. */
    async decodeImage(bytes, mime, { rotate = 0 } = {}) {
      let src;
      try {
        src = await createImageBitmap(new Blob([bytes], { type: mime }), { imageOrientation: 'from-image' });
      } catch (err) {
        if (mime !== 'image/heic') throw err;
        src = await decodeHeif(bytes);
      }
      const raster = { width: src.width, height: src.height, src };
      const r = rotated(raster, rotate);
      if (r !== raster) releaseSource(src);
      return r;
    },

    fromRGBA(data, width, height) {
      const c = makeCanvas(width, height);
      c.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
      return { width, height, src: c };
    },

    /** Fits the long side into `side` (never upscales); halves step by step for a clean downscale. */
    async resize(raster, side) {
      const target = scaledSize(raster.width, raster.height, side);
      if (target.width === raster.width && target.height === raster.height) return raster;
      let src = raster.src;
      let w = raster.width;
      let h = raster.height;
      const temps = [];
      while (w / 2 >= target.width * 1.0 && h / 2 >= target.height * 1.0) {
        const nw = Math.round(w / 2);
        const nh = Math.round(h / 2);
        const c = makeCanvas(nw, nh);
        context(c).drawImage(src, 0, 0, nw, nh);
        temps.push(c);
        src = c;
        w = nw;
        h = nh;
      }
      const out = makeCanvas(target.width, target.height);
      context(out).drawImage(src, 0, 0, target.width, target.height);
      for (const t of temps) releaseSource(t);
      return { width: target.width, height: target.height, src: out };
    },

    /** JPEG bytes at `quality` (0-1), on white (transparent areas become white, like paper). */
    async encodeJpeg(raster, quality) {
      if (!raster.flat) {
        const c = makeCanvas(raster.width, raster.height);
        const ctx = context(c);
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, raster.width, raster.height);
        ctx.drawImage(raster.src, 0, 0);
        raster.flat = c;
      }
      return canvasToBytes(raster.flat, 'image/jpeg', quality);
    },

    /** Frees a raster's memory. A `shared` raster is a view of a kept decode: only its own copy goes. */
    release(raster) {
      if (!raster) return;
      if (raster.flat && raster.flat !== raster.src) releaseSource(raster.flat);
      if (!raster.shared) releaseSource(raster.src);
      raster.src = null;
      raster.flat = null;
    },
  };
}
