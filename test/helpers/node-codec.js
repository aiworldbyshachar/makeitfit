// A codec for Node tests: real JPEG decode/encode with jpeg-js (dev dependency) and a box-filter resize.
// Same interface as docs/js/engine/codec-browser.js.
import jpeg from 'jpeg-js';
import { scaledSize } from '../../docs/js/engine/images.js';

export function createNodeCodec() {
  const codec = {
    encodes: 0,
    async decodeImage(bytes, mime, { rotate = 0 } = {}) {
      if (mime !== 'image/jpeg') throw new Error(`node codec reads JPEG only, got ${mime}`);
      const d = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 4096, maxResolutionInMP: 400 });
      let r = { width: d.width, height: d.height, data: d.data };
      if (rotate) r = rotate90s(r, rotate);
      return r;
    },
    fromRGBA(data, width, height) {
      return { width, height, data };
    },
    async resize(r, side) {
      const t = scaledSize(r.width, r.height, side);
      if (t.width === r.width && t.height === r.height) return r;
      return boxResize(r, t.width, t.height);
    },
    async encodeJpeg(r, quality) {
      codec.encodes++;
      return new Uint8Array(jpeg.encode({ data: r.data, width: r.width, height: r.height }, Math.round(quality * 100)).data);
    },
    release() {},
  };
  return codec;
}

function boxResize(r, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = r.width / w;
  const sy = r.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let rr = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * r.width + xx) * 4;
          rr += r.data[i]; g += r.data[i + 1]; b += r.data[i + 2]; n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = rr / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

function rotate90s(r, deg) {
  const d = ((deg % 360) + 360) % 360;
  if (d === 0) return r;
  const swap = d === 90 || d === 270;
  const w = swap ? r.height : r.width;
  const h = swap ? r.width : r.height;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      let nx, ny;
      if (d === 90) { nx = r.height - 1 - y; ny = x; }
      else if (d === 180) { nx = r.width - 1 - x; ny = r.height - 1 - y; }
      else { nx = y; ny = r.width - 1 - x; }
      const i = (y * r.width + x) * 4;
      const o = (ny * w + nx) * 4;
      out[o] = r.data[i]; out[o + 1] = r.data[i + 1]; out[o + 2] = r.data[i + 2]; out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/** A synthetic "document photo": paper, text-like strokes and noise (noise makes JPEGs realistically big). */
export function syntheticRGBA(width, height, seed = 1, { noise = 18, tint = [244, 241, 232] } = {}) {
  let s = seed >>> 0 || 1;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const n = (rand() - 0.5) * noise;
      const line = Math.floor(y / 14) % 3 !== 2 && (Math.floor(x / 9) + Math.floor(y / 14)) % 7 !== 0 && y % 14 > 3 && y % 14 < 11;
      const shade = line ? -150 : 0;
      data[i] = tint[0] + shade + n;
      data[i + 1] = tint[1] + shade + n;
      data[i + 2] = tint[2] + shade + n;
      data[i + 3] = 255;
    }
  }
  return data;
}

export function syntheticJpeg(width, height, seed, quality = 0.92, opts) {
  return new Uint8Array(jpeg.encode({ data: syntheticRGBA(width, height, seed, opts), width, height }, Math.round(quality * 100)).data);
}
