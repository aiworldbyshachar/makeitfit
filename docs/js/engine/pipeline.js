// The whole job: files + a limit in, one result out.
//
// Results (status):
//   'done'           outputs: [{ name, bytes, size }], method, details
//   'already-fits'   outputs: the original file, unchanged
//   'ask-rasterize'  step A wasn't enough; the user must agree before pages become images (source kept)
//   'cannot-fit'     even the readable floor is over the limit; offer to split into `parts` files
//   'unsupported'    a file isn't a photo or a PDF (the one rule)
//   'protected'      a PDF is password-protected and can't be merged
import { PDFDocument, degrees } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';
import { sniff, PHOTO_KINDS, MIME, scaledPixels, sharedView } from './images.js';
import { SetFitter, PHOTO_STEPS, fitSet, pickMix } from './search.js';
import { buildImagePdf, imagePdfOverhead, photoPageSize, stampInfo, copyPageRun } from './pdf-build.js';
import { stepA, stepB, splitPages, loadPdf, openScaled } from './pdf-shrink.js';
import { partsNeeded, balancedRuns } from './split.js';
import { outputName } from './sizes.js';

const margin = (limit) => Math.max(2000, Math.ceil(limit * 0.004));
const COMBINE_SIDE = 3000; // photos added to a PDF before step A are first stored at this size
const COMBINE_QUALITY = 0.92;

/** Facts shown the moment a file is dropped: kind, exact size, pages for PDFs. */
export async function describe(file) {
  const kind = sniff(file.bytes);
  const out = { name: file.name, kind, size: file.bytes.length };
  if (kind === 'pdf') {
    try {
      const doc = await loadPdf(file.bytes);
      out.pages = doc.getPageCount();
      out.encrypted = doc.isEncrypted;
    } catch {
      out.damaged = true;
    }
  }
  return out;
}

const done = (method, outputs, details = {}) => ({
  status: 'done',
  method,
  outputs: outputs.map((o) => ({ ...o, size: o.bytes.length })),
  details,
});

// ---------- photos ----------

/**
 * Photo items for the fitter. With only a few photos, each is decoded once and kept for the whole search
 * (HEIC decoding can take seconds); with many, each open decodes again to stay inside a phone's memory.
 */
async function photoItems(photos, codec) {
  const keep = photos.length <= 3;
  const items = [];
  for (const p of photos) {
    const decode = () => codec.decodeImage(p.bytes, MIME[p.kind], { rotate: p.rotate || 0 });
    let full = await decode();
    const { width, height } = full;
    if (!keep) {
      codec.release(full);
      full = null;
    }
    items.push({
      width,
      height,
      pixelsAt: (side) => scaledPixels(width, height, side),
      open: async (side) => {
        if (!full) return openScaled(decode, codec, side);
        const scaled = await codec.resize(full, side);
        // The kept decode must survive the fitter's release: hand out a shared view of it.
        return scaled === full ? sharedView(full) : scaled;
      },
      close: () => {
        if (full) codec.release(full);
        full = null;
      },
    });
  }
  return items;
}

/** One photo -> a JPG under the limit. */
export async function photoToJpeg(photo, limit, codec, onProgress) {
  const items = await photoItems([photo], codec);
  const fitter = new SetFitter(items, codec, { steps: PHOTO_STEPS, onProgress });
  try {
    const r = await fitSet(fitter, limit);
    if (!r.ok) return { ok: false, floorSize: r.floor };
    return { ok: true, bytes: r.picks[0].bytes, setting: r.setting, width: r.picks[0].width, height: r.picks[0].height };
  } finally {
    fitter.dispose();
  }
}

/** Several photos -> one PDF under the limit, one photo per page. */
export async function photosToPdf(photos, limit, codec, onProgress) {
  const items = await photoItems(photos, codec);
  const overhead = imagePdfOverhead(photos.length);
  const fitter = new SetFitter(items, codec, { steps: PHOTO_STEPS, onProgress });
  try {
    let budget = limit - overhead - margin(limit);
    const r = await fitSet(fitter, budget);
    if (!r.ok) return { ok: false, floorSize: r.floor + overhead };
    let picks = r.picks;
    let out;
    for (let attempt = 0; attempt < 3; attempt++) {
      out = await buildImagePdf(picks.map((p) => ({ jpeg: p.bytes, width: p.width, height: p.height })));
      if (out.length <= limit) return { ok: true, bytes: out, setting: r.setting, pages: photos.length };
      budget -= out.length - limit + margin(limit);
      const mix = pickMix(r.candidates, budget);
      if (!mix) break;
      picks = mix.picks;
    }
    return { ok: false, floorSize: out.length };
  } finally {
    fitter.dispose();
  }
}

// ---------- combining ----------

class ProtectedError extends Error {}

/** Every input in order -> one PDF (PDF pages copied, photos stored as high-quality pages). */
async function combine(items, codec) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  stampInfo(doc);
  for (const it of items) {
    if (it.kind === 'pdf') {
      const src = await loadPdf(it.bytes);
      if (src.isEncrypted) throw new ProtectedError(it.name);
      const pages = await doc.copyPages(src, src.getPageIndices());
      for (const p of pages) {
        if (it.rotate) p.setRotation(degrees((p.getRotation().angle + it.rotate) % 360));
        doc.addPage(p);
      }
    } else {
      const full = await codec.decodeImage(it.bytes, MIME[it.kind], { rotate: it.rotate || 0 });
      const scaled = await codec.resize(full, COMBINE_SIDE);
      if (scaled !== full) codec.release(full);
      const jpeg = await codec.encodeJpeg(scaled, COMBINE_QUALITY);
      const { width, height } = scaled;
      codec.release(scaled);
      const img = await doc.embedJpg(jpeg);
      const size = photoPageSize(width, height);
      doc.addPage([size.width, size.height]).drawImage(img, { x: 0, y: 0, ...size });
    }
  }
  return doc.save({ useObjectStreams: true });
}

// ---------- the job ----------

/**
 * job: { files: [{ name, bytes, rotate? }], limit, output?: 'pdf' | 'jpg' | 'separate', allowRasterize? }
 * env: { codec, openRenderer?(bytes) } - openRenderer exists where pdf.js can render (the page).
 */
export async function makeItFit(job, env, onProgress = () => {}) {
  const { limit } = job;
  const codec = env.codec;
  const items = job.files.map((f) => ({ ...f, kind: sniff(f.bytes) }));
  const bad = items.filter((i) => !i.kind);
  if (bad.length) return { status: 'unsupported', names: bad.map((i) => i.name) };
  const photos = items.filter((i) => PHOTO_KINDS.has(i.kind));
  const pdfs = items.filter((i) => i.kind === 'pdf');
  const output = job.output || (items.length === 1 && photos.length === 1 ? 'jpg' : 'pdf');
  const name = items[0].name;
  const progress = (stage) => (p) => onProgress({ stage, ...p });

  if (output === 'jpg') {
    const p = photos[0];
    if (!p || items.length !== 1) throw new Error('JPG output needs exactly one photo');
    if (p.kind === 'jpeg' && !p.rotate && p.bytes.length <= limit) return { status: 'already-fits', outputs: [{ name: p.name, bytes: p.bytes, size: p.bytes.length }] };
    const r = await photoToJpeg(p, limit, codec, progress('photo'));
    if (!r.ok) return { status: 'cannot-fit', smallestReadable: r.floorSize, parts: null };
    return done('photo', [{ name: outputName(name, limit, 'jpg'), bytes: r.bytes }], { setting: r.setting, width: r.width, height: r.height });
  }

  if (output === 'separate') {
    const outputs = [];
    const failed = [];
    for (const it of items) {
      if (it.bytes.length <= limit && !it.rotate && (it.kind === 'pdf' || it.kind === 'jpeg')) {
        outputs.push({ name: it.name, bytes: it.bytes, unchanged: true });
        continue;
      }
      const src = it.kind === 'pdf' && it.rotate ? await combine([it], codec) : it.bytes;
      const r = it.kind === 'pdf' ? await stepA(src, limit, codec, { onProgress: progress('stepA') }) : await photoToJpeg(it, limit, codec, progress('photo'));
      if (r.ok) outputs.push({ name: outputName(it.name, limit, it.kind === 'pdf' ? 'pdf' : 'jpg'), bytes: r.bytes });
      else failed.push({ name: it.name, reason: r.reason || 'floor', smallestReadable: r.floorSize });
    }
    return { ...done('separate', outputs), failed };
  }

  // One PDF.
  if (items.length === 1 && pdfs.length === 1 && pdfs[0].bytes.length <= limit && !pdfs[0].rotate) {
    return { status: 'already-fits', outputs: [{ name, bytes: pdfs[0].bytes, size: pdfs[0].bytes.length }] };
  }
  const pdfName = outputName(name, limit, 'pdf');
  if (!pdfs.length) {
    const r = await photosToPdf(photos, limit, codec, progress('photos'));
    if (r.ok) return done('photos', [{ name: pdfName, bytes: r.bytes }], { setting: r.setting, pages: r.pages });
    return { status: 'cannot-fit', smallestReadable: r.floorSize, parts: partsNeeded(r.floorSize, limit), mode: 'photos' };
  }

  let source;
  try {
    source = items.length === 1 && !pdfs[0].rotate ? pdfs[0].bytes : await combine(items, codec);
  } catch (e) {
    if (e instanceof ProtectedError) return { status: 'protected', names: [e.message] };
    throw e;
  }
  if (source.length <= limit) return done('combined', [{ name: pdfName, bytes: source }]);

  const a = await stepA(source, limit, codec, { onProgress: progress('stepA') });
  if (a.ok) return done(a.cleanedOnly ? 'cleaned' : 'stepA', [{ name: pdfName, bytes: a.bytes }], { setting: a.setting, changed: a.changed, images: a.images, pages: a.pages });
  const ask = { status: 'ask-rasterize', source, name, stepA: { reason: a.reason, smallestReadable: a.floorSize } };
  if (!job.allowRasterize || !env.openRenderer) return ask;
  return rasterize(source, limit, env, onProgress, name);
}

/**
 * Step B on a source PDF, after the user agreed. Needs env.openRenderer (pdf.js).
 * `name` is the original file name (the output gets " (3 MB)" added).
 */
export async function rasterize(source, limit, env, onProgress = () => {}, name = 'document.pdf') {
  const renderer = await env.openRenderer(source);
  try {
    const b = await stepB(renderer, limit, env.codec, { onProgress: (p) => onProgress({ stage: 'stepB', ...p }) });
    if (b.ok) return done('stepB', [{ name: outputName(name, limit, 'pdf'), bytes: b.bytes }], { setting: b.setting, pages: b.pages, textIsImage: true });
    return { status: 'cannot-fit', smallestReadable: b.floorSize, parts: partsNeeded(b.floorSize, limit), mode: 'pages', source, name };
  } finally {
    renderer.close();
  }
}

/**
 * Splits into several files, each under the limit.
 * args: { mode: 'pages' | 'photos' | 'stepA', source?, files?, limit, parts, name }
 *   'pages'  - pages become images (needs env.openRenderer)
 *   'stepA'  - keeps text selectable (the user declined step B)
 *   'photos' - several photos, several PDFs
 */
export async function splitToFit(args, env, onProgress = () => {}) {
  const { mode, limit, name } = args;
  const codec = env.codec;
  let parts = Math.max(2, args.parts || 2);
  const named = (i, n) => outputName(name, limit, 'pdf', { index: i + 1, count: n });

  for (let attempt = 0; attempt < 4; attempt++, parts++) {
    const outputs = [];
    let failed = false;
    if (mode === 'pages') {
      // One pass: each page rendered once, then packed (see splitPages).
      const renderer = await env.openRenderer(args.source);
      try {
        const s = await splitPages(renderer, limit, codec, { parts, onProgress: (p) => onProgress({ stage: 'split', ...p }) });
        if (!s.ok) return { status: 'cannot-fit', smallestReadable: null, parts: null, reason: s.reason };
        return done('split-pages', s.parts.map((o, i) => ({ ...o, name: named(i, s.parts.length) })), { parts: s.parts.length, setting: { step: s.dpi, quality: s.quality }, textIsImage: true });
      } finally {
        renderer.close();
      }
    } else if (mode === 'stepA') {
      const src = await loadPdf(args.source);
      const runs = balancedRuns(src.getPageIndices().map(() => 1), parts);
      for (const [k, [start, end]] of runs.entries()) {
        onProgress({ stage: 'split', done: k, total: runs.length });
        const a = await stepA(await copyPageRun(src, start, end), limit, codec);
        if (!a.ok) { failed = true; break; }
        outputs.push({ bytes: a.bytes, pages: [start + 1, end] });
      }
    } else if (mode === 'photos') {
      const photos = args.files.map((f) => ({ ...f, kind: sniff(f.bytes) }));
      const runs = balancedRuns(photos.map(() => 1), parts);
      for (const [k, [start, end]] of runs.entries()) {
        onProgress({ stage: 'split', done: k, total: runs.length });
        const r = await photosToPdf(photos.slice(start, end), limit, codec);
        if (!r.ok) { failed = true; break; }
        outputs.push({ bytes: r.bytes, pages: [start + 1, end] });
      }
    } else {
      throw new Error(`unknown split mode ${mode}`);
    }
    if (!failed) return done(`split-${mode}`, outputs.map((o, i) => ({ ...o, name: named(i, outputs.length) })), { parts: outputs.length });
  }
  return { status: 'cannot-fit', smallestReadable: null, parts: null };
}
