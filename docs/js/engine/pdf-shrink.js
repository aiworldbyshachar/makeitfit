// Shrinking PDFs.
// Step A keeps the text sharp and selectable: clean up the file (metadata, thumbnails, unused objects,
// identical streams stored twice, uncompressed streams, object streams) and re-encode the photos inside
// it at the best quality that fits.
// Step B (only after the user agrees) renders every page and rebuilds the PDF from page images.
import { PDFDocument, PDFName, PDFRawStream, PDFDict, PDFArray, PDFNumber, PDFRef, PDFStream, PDFBool, PDFString, PDFHexString } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';
import { SetFitter, PHOTO_STEPS, PAGE_STEPS, fitSet, pickMix } from './search.js';
import { buildImagePdf, imagePdfOverhead, stampInfo } from './pdf-build.js';
import { scaledPixels, stripExif, inflate, unpredictPng, toRGBA, sharedView, expandIndexed } from './images.js';
import { packRuns, balancedRuns } from './split.js';

const N = (s) => PDFName.of(s);
const MIN_IMAGE_BYTES = 8000; // smaller images aren't worth re-encoding
const margin = (limit) => Math.max(2000, Math.ceil(limit * 0.004));

export async function loadPdf(bytes) {
  return PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
}

const nameOf = (o) => (o instanceof PDFName ? o.toString().slice(1) : null);

function single(ctx, value) {
  const v = ctx.lookup(value);
  if (v instanceof PDFArray) return v.size() === 1 ? ctx.lookup(v.get(0)) : v.size() === 0 ? undefined : 'many';
  return v;
}

/**
 * What step A needs to know about an image's colour space: { components (1 or 3), out (the colour space
 * of the re-encoded JPEG), indexed? { base, hival, lookup } }, or null when it can't re-encode it.
 */
function colourInfo(ctx, cs) {
  const v = ctx.lookup(cs);
  if (v instanceof PDFArray && nameOf(ctx.lookup(v.get(0))) === 'Indexed' && v.size() >= 4) {
    const baseRaw = v.get(1);
    const base = components(ctx, baseRaw);
    const hi = ctx.lookup(v.get(2));
    if (!base || !(hi instanceof PDFNumber)) return null;
    return { components: 1, out: base === 3 ? baseRaw : N('DeviceRGB'), indexed: { base, hival: hi.asNumber(), lookup: ctx.lookup(v.get(3)) } };
  }
  const n = components(ctx, cs);
  if (!n) return null;
  return { components: n, out: n === 3 ? cs : N('DeviceRGB') };
}

/** Components of a colour space we can re-encode (1 or 3), or 0 for anything else. */
function components(ctx, cs) {
  const v = ctx.lookup(cs);
  const n = nameOf(v);
  if (n === 'DeviceRGB') return 3;
  if (n === 'DeviceGray') return 1;
  if (v instanceof PDFArray && v.size() >= 1) {
    const family = nameOf(ctx.lookup(v.get(0)));
    if (family === 'CalRGB') return 3;
    if (family === 'CalGray') return 1;
    if (family === 'ICCBased') {
      const icc = ctx.lookup(v.get(1));
      const nn = icc instanceof PDFStream ? icc.dict.lookup(N('N')) : null;
      const count = nn instanceof PDFNumber ? nn.asNumber() : 0;
      return count === 1 || count === 3 ? count : 0;
    }
  }
  return 0;
}

/** Removes document metadata, page thumbnails and private app data, and drops unreachable objects. */
export function cleanDocument(doc) {
  const ctx = doc.context;
  for (const key of ['Metadata', 'PieceInfo']) doc.catalog.delete(N(key));
  for (const page of doc.getPages()) {
    for (const key of ['Thumb', 'PieceInfo', 'Metadata']) page.node.delete(N(key));
  }
  const info = ctx.lookup(ctx.trailerInfo.Info);
  if (info instanceof PDFDict) for (const k of info.keys()) info.delete(k);
  stampInfo(doc);

  const seen = new Set();
  const stack = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt].filter(Boolean);
  while (stack.length) {
    const o = stack.pop();
    if (o instanceof PDFRef) {
      if (seen.has(o)) continue;
      seen.add(o);
      const t = ctx.lookup(o);
      if (t !== undefined) stack.push(t);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) stack.push(o.get(i));
    } else if (o instanceof PDFStream) {
      stack.push(o.dict);
    }
  }
  let dropped = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref)) {
      ctx.delete(ref);
      dropped++;
    }
  }
  return dropped;
}

/** Every image XObject, with whether step A can re-encode it (and why not). */
export function findImages(doc) {
  const ctx = doc.context;
  const all = [];
  const masks = new Set();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || nameOf(obj.dict.lookup(N('Subtype'))) !== 'Image') continue;
    all.push({ ref, stream: obj, dict: obj.dict });
    for (const k of ['SMask', 'Mask']) {
      const m = obj.dict.get(N(k));
      if (m instanceof PDFRef) masks.add(m);
    }
  }
  for (const img of all) {
    const d = img.dict;
    const num = (k) => {
      const v = d.lookup(N(k));
      return v instanceof PDFNumber ? v.asNumber() : undefined;
    };
    img.width = num('Width');
    img.height = num('Height');
    img.bytes = img.stream.contents.length;
    const filter = single(ctx, d.get(N('Filter')));
    img.filter = filter === 'many' ? 'many' : nameOf(filter) || 'none';
    const colour = colourInfo(ctx, d.get(N('ColorSpace')));
    img.components = colour?.components || 0;
    img.outColorSpace = colour?.out;
    img.indexed = colour?.indexed;
    img.bpc = num('BitsPerComponent');
    const reason = (() => {
      if (masks.has(img.ref)) return 'mask';
      const im = d.lookup(N('ImageMask'));
      if (im instanceof PDFBool && im.asBoolean()) return 'mask';
      if (!img.width || !img.height) return 'size unknown';
      if (img.bytes < MIN_IMAGE_BYTES) return 'small';
      if (!colour) return 'colour space';
      if (img.indexed ? ![1, 2, 4, 8].includes(img.bpc) : img.bpc !== 8) return `${img.bpc}-bit`;
      if (d.lookup(N('Decode'))) return 'decode array';
      if (d.lookup(N('Mask')) instanceof PDFArray) return 'colour-key mask';
      if (img.filter === 'DCTDecode') return img.indexed ? 'indexed JPEG' : null;
      if (img.filter === 'FlateDecode' || img.filter === 'none') {
        const parms = single(ctx, d.get(N('DecodeParms')));
        const pred = parms instanceof PDFDict ? parms.lookup(N('Predictor')) : null;
        const p = pred instanceof PDFNumber ? pred.asNumber() : 1;
        if (p !== 1 && p < 10) return 'predictor';
        img.pngPredictor = p >= 10;
        return null;
      }
      return `filter ${img.filter}`;
    })();
    img.eligible = !reason;
    img.reason = reason;
  }
  return all;
}

/** The bytes of a palette: a string in the colour space array, or a (maybe compressed) stream. */
async function paletteBytes(lookup) {
  if (lookup instanceof PDFString || lookup instanceof PDFHexString) return lookup.asBytes();
  if (lookup instanceof PDFRawStream) {
    const f = lookup.dict.get(N('Filter'));
    return f ? inflate(lookup.contents) : lookup.contents;
  }
  throw new Error('palette not readable');
}

/** Decodes one eligible PDF image into a codec raster at full size. */
export async function decodePdfImage(img, codec) {
  if (img.filter === 'DCTDecode') return codec.decodeImage(stripExif(img.stream.contents), 'image/jpeg', { orientation: 'none' });
  let data = img.filter === 'FlateDecode' ? await inflate(img.stream.contents) : img.stream.contents;
  if (img.indexed) {
    if (img.pngPredictor) data = unpredictPng(data, img.width, 1, img.bpc);
    const palette = await paletteBytes(img.indexed.lookup);
    const samples = expandIndexed(data, img.width, img.height, img.bpc, palette, img.indexed.base);
    return codec.fromRGBA(toRGBA(samples, img.width, img.height, img.indexed.base), img.width, img.height);
  }
  if (img.pngPredictor) data = unpredictPng(data, img.width, img.components);
  return codec.fromRGBA(toRGBA(data, img.width, img.height, img.components), img.width, img.height);
}

// ---------- compacting: identical streams stored once, raw streams compressed ----------

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function fnv(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return h >>> 0;
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Stores identical streams once (a font or picture embedded again on every page is common in PDFs
 * made by merging or printing), and compresses streams written without any compression.
 * Returns { merged, compressed }.
 */
export async function compactStreams(doc) {
  const ctx = doc.context;
  const seen = new Map();
  const remap = new Map();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.contents.length < 1024) continue;
    const key = `${obj.contents.length}|${fnv(obj.contents)}|${obj.dict.toString()}`;
    const first = seen.get(key);
    if (!first) seen.set(key, ref);
    else if (sameBytes(ctx.lookup(first).contents, obj.contents)) remap.set(ref, first);
  }
  if (remap.size) {
    const fix = (o) => {
      if (o instanceof PDFDict) {
        for (const [k, v] of o.entries()) {
          if (v instanceof PDFRef && remap.has(v)) o.set(k, remap.get(v));
          else fix(v);
        }
      } else if (o instanceof PDFArray) {
        for (let i = 0; i < o.size(); i++) {
          const v = o.get(i);
          if (v instanceof PDFRef && remap.has(v)) o.set(i, remap.get(v));
          else fix(v);
        }
      } else if (o instanceof PDFStream) fix(o.dict);
    };
    for (const [, obj] of ctx.enumerateIndirectObjects()) fix(obj);
    for (const ref of remap.keys()) ctx.delete(ref);
  }
  let compressed = 0;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.get(N('Filter')) !== undefined || obj.contents.length < 512) continue;
    const z = await deflate(obj.contents);
    if (z.length > obj.contents.length * 0.9) continue;
    const dict = obj.dict.clone(ctx);
    dict.set(N('Filter'), N('FlateDecode'));
    ctx.assign(ref, PDFRawStream.of(dict, z));
    compressed++;
  }
  return { merged: remap.size, compressed };
}

/** Opens a raster for a ladder step (long side), releasing the full-size one when it was scaled. */
export async function openScaled(decode, codec, side) {
  const full = await decode();
  const scaled = await codec.resize(full, side);
  if (scaled !== full) codec.release(full);
  return scaled;
}

function replaceImage(ctx, img, pick) {
  const cs = img.outColorSpace || N('DeviceRGB');
  const stream = ctx.stream(pick.bytes, {
    Type: 'XObject',
    Subtype: 'Image',
    Width: pick.width,
    Height: pick.height,
    ColorSpace: cs,
    BitsPerComponent: 8,
    Filter: 'DCTDecode',
  });
  for (const k of ['SMask', 'Mask', 'Intent', 'Interpolate', 'OC', 'Alternates']) {
    const v = img.dict.get(N(k));
    if (v !== undefined) stream.dict.set(N(k), v);
  }
  ctx.assign(img.ref, stream);
}

function applyPicks(ctx, images, picks) {
  let changed = 0;
  images.forEach((img, i) => {
    if (picks[i].bytes.length < img.bytes) {
      replaceImage(ctx, img, picks[i]);
      changed++;
    } else {
      ctx.assign(img.ref, img.stream); // keep (or restore) the original
    }
  });
  return changed;
}

/**
 * Step A. Returns { ok: true, bytes, setting, changed, cleanedOnly } or
 * { ok: false, reason: 'encrypted' | 'no-images' | 'floor', floorSize?, size? }.
 */
export async function stepA(bytes, limit, codec, { onProgress } = {}) {
  const doc = await loadPdf(bytes);
  if (doc.isEncrypted) return { ok: false, reason: 'encrypted' };
  cleanDocument(doc);
  await compactStreams(doc);
  const images = findImages(doc).filter((i) => i.eligible);
  const cleaned = await doc.save({ useObjectStreams: true });
  if (cleaned.length <= limit) return { ok: true, bytes: cleaned, setting: null, changed: 0, cleanedOnly: true, pages: doc.getPageCount() };
  if (!images.length) return { ok: false, reason: 'no-images', size: cleaned.length };

  const fixed = cleaned.length - images.reduce((s, i) => s + i.bytes, 0);
  const items = images.map((img) => ({
    pixelsAt: (side) => scaledPixels(img.width, img.height, side),
    open: (side) => openScaled(() => decodePdfImage(img, codec), codec, side),
  }));
  const fitter = new SetFitter(items, codec, { steps: PHOTO_STEPS, samples: 3, onProgress });
  let budget = limit - fixed - margin(limit);
  if (budget <= 0) return { ok: false, reason: 'floor', floorSize: fixed + (await fitter.floorEstimate()) };
  const r = await fitSet(fitter, budget);
  if (!r.ok) return { ok: false, reason: 'floor', floorSize: fixed + r.floor };

  let picks = r.picks;
  let out;
  for (let attempt = 0; attempt < 3; attempt++) {
    const changed = applyPicks(doc.context, images, picks);
    out = await doc.save({ useObjectStreams: true });
    if (out.length <= limit) {
      return { ok: true, bytes: out, setting: r.setting, changed, images: images.length, pages: doc.getPageCount() };
    }
    budget -= out.length - limit + margin(limit);
    const mix = pickMix(r.candidates, budget);
    if (!mix) break;
    picks = mix.picks;
  }
  return { ok: false, reason: 'floor', floorSize: out.length };
}

// ---------- Step B ----------

const MAX_PAGE_PIXELS = 16_000_000; // stays inside every browser's canvas limit

/** Pixel size of a page rendered at `dpi`, from its size in points. */
export function pageRenderSize(widthPt, heightPt, dpi) {
  let w = Math.max(1, Math.round((widthPt / 72) * dpi));
  let h = Math.max(1, Math.round((heightPt / 72) * dpi));
  if (w * h > MAX_PAGE_PIXELS) {
    const s = Math.sqrt(MAX_PAGE_PIXELS / (w * h));
    w = Math.floor(w * s);
    h = Math.floor(h * s);
  }
  return { width: w, height: h };
}

/**
 * Step B. renderer: { pageCount, pageSize(i) -> {width, height} in points, renderPage(i, dpi) -> raster }.
 * `pages` limits it to some page indices (used by the split). Returns { ok: true, bytes, setting } or
 * { ok: false, reason: 'floor', floorSize }.
 */
/** Fitter items for rendered pages: a probed sample page is rendered once at `topDpi` and scaled down. */
function pageItems(renderer, codec, idx, sizes, topDpi = PAGE_STEPS[0]) {
  return idx.map((pageIndex, k) => {
    let top = null;
    return {
      pixelsAt: (dpi) => {
        const s = pageRenderSize(sizes[k].width, sizes[k].height, dpi);
        return s.width * s.height;
      },
      open: async (dpi, { probe } = {}) => {
        if (!top && !probe) return renderer.renderPage(pageIndex, dpi);
        if (!top) top = await renderer.renderPage(pageIndex, Math.max(topDpi, dpi));
        const want = pageRenderSize(sizes[k].width, sizes[k].height, dpi);
        const scaled = await codec.resize(top, Math.max(want.width, want.height));
        return scaled === top ? sharedView(top) : scaled;
      },
      close: () => {
        if (top) codec.release(top);
        top = null;
      },
    };
  });
}

/**
 * The smallest readable size if every page became an image (100 DPI, quality 0.5), estimated from three
 * sample pages - used to decide whether step B can help at all before offering it.
 */
export async function stepBFloor(renderer, codec, { onProgress } = {}) {
  const idx = Array.from({ length: renderer.pageCount }, (_, i) => i);
  const sizes = [];
  for (const i of idx) sizes.push(await renderer.pageSize(i));
  const floorDpi = PAGE_STEPS[PAGE_STEPS.length - 1];
  const fitter = new SetFitter(pageItems(renderer, codec, idx, sizes, floorDpi), codec, { steps: PAGE_STEPS, samples: 3, onProgress });
  try {
    return (await fitter.floorEstimate()) + imagePdfOverhead(idx.length);
  } finally {
    fitter.dispose();
  }
}

export async function stepB(renderer, limit, codec, { onProgress, pages } = {}) {
  const idx = pages || Array.from({ length: renderer.pageCount }, (_, i) => i);
  const sizes = [];
  for (const i of idx) sizes.push(await renderer.pageSize(i));
  const items = pageItems(renderer, codec, idx, sizes);
  const fitter = new SetFitter(items, codec, { steps: PAGE_STEPS, samples: 3, onProgress });
  const overhead = imagePdfOverhead(idx.length);
  let budget = limit - overhead - margin(limit);
  try {
    const r = await fitSet(fitter, budget);
    if (!r.ok) return { ok: false, reason: 'floor', floorSize: r.floor + overhead };
    let picks = r.picks;
    let out;
    for (let attempt = 0; attempt < 3; attempt++) {
      out = await buildImagePdf(picks.map((p, k) => ({ jpeg: p.bytes, width: p.width, height: p.height, pageWidth: sizes[k].width, pageHeight: sizes[k].height })));
      if (out.length <= limit) return { ok: true, bytes: out, setting: r.setting, pages: idx.length };
      budget -= out.length - limit + margin(limit);
      const mix = pickMix(r.candidates, budget);
      if (!mix) break;
      picks = mix.picks;
    }
    return { ok: false, reason: 'floor', floorSize: out.length };
  } finally {
    fitter.dispose();
  }
}

/**
 * Split with pages as images, in one pass: every page is rendered once at the readable floor (100 DPI)
 * and encoded at a few qualities; then the pages are packed, in order, into the fewest parts, using the
 * best quality that still needs no more than `parts` files. Returns { ok, parts: [{ bytes, pages: [first,
 * last] }], quality } (pages are 1-based).
 */
export const SPLIT_QUALITIES = [0.8, 0.72, 0.65, 0.58, 0.5];

export async function splitPages(renderer, limit, codec, { parts, onProgress } = {}) {
  const n = renderer.pageCount;
  const dpi = PAGE_STEPS[PAGE_STEPS.length - 1];
  const sizes = [];
  const cands = [];
  for (let i = 0; i < n; i++) {
    sizes.push(await renderer.pageSize(i));
    const raster = await renderer.renderPage(i, dpi);
    try {
      const c = [];
      for (const q of SPLIT_QUALITIES) c.push({ bytes: await codec.encodeJpeg(raster, q), width: raster.width, height: raster.height, quality: q });
      cands.push(c);
    } finally {
      codec.release(raster);
    }
    onProgress?.({ phase: 'encode', done: i + 1, total: n });
  }
  const capacity = limit - margin(limit);
  const fitsRun = (L, [a, b]) => {
    let t = imagePdfOverhead(b - a);
    for (let i = a; i < b; i++) t += cands[i][L].bytes.length;
    return t <= capacity;
  };
  let chosen = null;
  for (let L = 0; L < SPLIT_QUALITIES.length; L++) {
    const weights = cands.map((c) => c[L].bytes.length);
    const greedy = packRuns(weights, capacity, imagePdfOverhead);
    if (!greedy) continue; // a single page is too big at this quality
    // Same number of parts as greedy packing, but with even sizes when that still fits.
    const even = balancedRuns(weights, greedy.length);
    const runs = even.every((r) => fitsRun(L, r)) ? even : greedy;
    if (!chosen || runs.length < chosen.runs.length) chosen = { L, runs };
    if (runs.length <= parts) {
      chosen = { L, runs };
      break;
    }
  }
  if (!chosen) return { ok: false, reason: 'page-too-big' };
  const out = [];
  for (const [a, b] of chosen.runs) {
    const bytes = await buildImagePdf(
      Array.from({ length: b - a }, (_, k) => {
        const p = cands[a + k][chosen.L];
        return { jpeg: p.bytes, width: p.width, height: p.height, pageWidth: sizes[a + k].width, pageHeight: sizes[a + k].height };
      }),
    );
    if (bytes.length > limit) return { ok: false, reason: 'overhead' };
    out.push({ bytes, pages: [a + 1, b] });
  }
  return { ok: true, parts: out, quality: SPLIT_QUALITIES[chosen.L], dpi };
}
