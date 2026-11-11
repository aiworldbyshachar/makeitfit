// Image helpers shared by the browser and the tests: file type sniffing, scaled sizes, EXIF stripping,
// and decoding the raw (Flate) images found inside PDFs. Decoding and encoding real photos goes through
// a codec (codec-browser.js in the browser), so the logic here stays testable in Node.

/** The kind of file from its first bytes: 'pdf' | 'jpeg' | 'png' | 'webp' | 'heic' | null (not allowed). */
export function sniff(bytes) {
  const b = bytes;
  const ascii = (from, to) => String.fromCharCode(...b.subarray(from, to));
  if (b.length < 12) return null;
  if (ascii(0, 5) === '%PDF-') return 'pdf';
  // Some PDFs have junk before the header; the spec allows it within the first 1024 bytes.
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(4, 8) === 'ftyp') {
    const brands = ascii(8, Math.min(b.length, 40));
    if (/heic|heix|hevc|hevx|heim|heis|mif1|msf1/.test(brands)) return 'heic';
  }
  const head = ascii(0, Math.min(b.length, 1024));
  if (head.includes('%PDF-')) return 'pdf';
  return null;
}

export const PHOTO_KINDS = new Set(['jpeg', 'png', 'webp', 'heic']);

export const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', pdf: 'application/pdf' };

/**
 * A view of a raster that is kept by its owner (a decoded photo, a rendered page): the fitter may use and
 * release the view, and the codec frees only what belongs to the view, never the kept original.
 */
export function sharedView(r) {
  return { width: r.width, height: r.height, src: r.src, data: r.data, id: r.id, shared: true };
}

/** Size after fitting the long side into `side` (never upscales). */
export function scaledSize(width, height, side) {
  const long = Math.max(width, height);
  if (!side || long <= side) return { width, height };
  const s = side / long;
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

export function scaledPixels(width, height, side) {
  const s = scaledSize(width, height, side);
  return s.width * s.height;
}

/**
 * Removes APP1 (EXIF / XMP) segments from a JPEG. Used for JPEGs inside PDFs: PDF viewers ignore EXIF
 * orientation, so the decoder must ignore it too.
 */
export function stripExif(jpeg) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  const parts = [jpeg.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= jpeg.length && jpeg[i] === 0xff) {
    const marker = jpeg[i + 1];
    if (marker === 0xda) break; // start of scan: the rest is image data
    const len = (jpeg[i + 2] << 8) | jpeg[i + 3];
    if (marker !== 0xe1) parts.push(jpeg.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  if (parts.length === 1 && i === 2) return jpeg;
  parts.push(jpeg.subarray(i));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Inflates zlib data (PDF FlateDecode) with the platform's own DecompressionStream. */
export async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Undoes PNG row predictors (PDF /Predictor >= 10) into a new buffer without the filter bytes.
 * Rows hold width x components samples of `bpc` bits, padded to whole bytes.
 */
export function unpredictPng(data, width, components, bpc = 8) {
  const rowLen = Math.ceil((width * components * bpc) / 8);
  const bpp = Math.max(1, Math.ceil((components * bpc) / 8));
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  for (let y = 0; y < rows; y++) {
    const filter = data[y * (rowLen + 1)];
    const src = y * (rowLen + 1) + 1;
    const dst = y * rowLen;
    const prev = dst - rowLen;
    for (let x = 0; x < rowLen; x++) {
      const raw = data[src + x];
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = y > 0 && x >= bpp ? out[prev + x - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad PNG filter ${filter}`);
      }
      out[dst + x] = v & 0xff;
    }
  }
  return out;
}

/**
 * Palette (PDF /Indexed) image -> 8-bit samples of the base colour space. Indices have `bpc` bits
 * (1, 2, 4 or 8), rows padded to whole bytes; `palette` holds (hival + 1) x baseComponents bytes.
 */
export function expandIndexed(data, width, height, bpc, palette, baseComponents) {
  const rowLen = Math.ceil((width * bpc) / 8);
  const out = new Uint8Array(width * height * baseComponents);
  const maxIndex = Math.floor(palette.length / baseComponents) - 1;
  const mask = (1 << bpc) - 1;
  let o = 0;
  for (let y = 0; y < height; y++) {
    const row = y * rowLen;
    for (let x = 0; x < width; x++) {
      let index;
      if (bpc === 8) index = data[row + x];
      else {
        const bit = x * bpc;
        index = (data[row + (bit >> 3)] >> (8 - bpc - (bit & 7))) & mask;
      }
      const p = Math.min(index, maxIndex) * baseComponents;
      for (let k = 0; k < baseComponents; k++) out[o++] = palette[p + k] ?? 0;
    }
  }
  return out;
}

/** 8-bit Gray or RGB samples -> RGBA. */
export function toRGBA(samples, width, height, components) {
  const n = width * height;
  if (samples.length < n * components) throw new Error('image data too short');
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, s = 0, d = 0; i < n; i++, d += 4) {
    if (components === 1) {
      const g = samples[s++];
      out[d] = g; out[d + 1] = g; out[d + 2] = g;
    } else {
      out[d] = samples[s++]; out[d + 1] = samples[s++]; out[d + 2] = samples[s++];
    }
    out[d + 3] = 255;
  }
  return out;
}
