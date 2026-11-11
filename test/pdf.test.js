import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { PDFDocument, StandardFonts, PDFName, PDFRawStream, PDFHexString } from '../docs/vendor/pdf-lib/pdf-lib.esm.min.js';
import { buildImagePdf, imagePdfOverhead } from '../docs/js/engine/pdf-build.js';
import { stepA, stepB, findImages, loadPdf } from '../docs/js/engine/pdf-shrink.js';
import { createNodeCodec, syntheticJpeg, syntheticRGBA } from './helpers/node-codec.js';

/** A text PDF with two big photos, one raw (Flate) image, metadata and an unused object. */
async function textPdfWithPhotos() {
  const doc = await PDFDocument.create();
  doc.setAuthor('Someone Private');
  doc.setTitle('Payslip');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < 2; p++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Salary statement page ${p + 1} - the text must stay selectable`, { x: 40, y: 790, size: 14, font });
    const img = await doc.embedJpg(syntheticJpeg(1600, 1200, 10 + p, 0.95, { noise: 40 }));
    page.drawImage(img, { x: 40, y: 300, width: 515, height: 386 });
  }
  // A raw RGB image (FlateDecode, no predictor), like scanners and some exporters write.
  const w = 500, h = 400;
  const rgba = syntheticRGBA(w, h, 99, { noise: 60 });
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, o = 0; i < w * h; i++) { rgb[o++] = rgba[i * 4]; rgb[o++] = rgba[i * 4 + 1]; rgb[o++] = rgba[i * 4 + 2]; }
  const ctx = doc.context;
  const flate = ctx.stream(zlib.deflateSync(rgb), { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode' });
  const flateRef = ctx.register(flate);
  const page = doc.getPage(1);
  const name = page.node.newXObject('RawImg', flateRef);
  page.pushOperators(...[]);
  const content = ctx.stream(`q 200 0 0 160 40 80 cm /${name.toString().slice(1)} Do Q`);
  page.node.addContentStream(ctx.register(content));
  // Junk that step A should drop: an unreachable object and XMP metadata.
  ctx.register(ctx.stream(new Uint8Array(50_000).fill(7)));
  doc.catalog.set(PDFName.of('Metadata'), ctx.register(ctx.stream('<x:xmpmeta>private</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' })));
  return doc.save();
}

test('photos into one PDF: one page per photo, overhead within the estimate', async () => {
  const jpegs = [syntheticJpeg(400, 300, 1), syntheticJpeg(300, 400, 2), syntheticJpeg(500, 500, 3)];
  const pdf = await buildImagePdf(jpegs.map((jpeg, i) => ({ jpeg, width: [400, 300, 500][i], height: [300, 400, 500][i] })));
  const doc = await PDFDocument.load(pdf);
  assert.equal(doc.getPageCount(), 3);
  const { width, height } = doc.getPage(1).getSize();
  assert.ok(Math.abs(height - 841.89) < 0.01 && width < height);
  const overhead = pdf.length - jpegs.reduce((s, j) => s + j.length, 0);
  assert.ok(overhead <= imagePdfOverhead(3), `overhead ${overhead} > ${imagePdfOverhead(3)}`);
});

test('step A: hits the limit, keeps the text, drops metadata and junk', async () => {
  const src = await textPdfWithPhotos();
  const before = findImages(await loadPdf(src));
  assert.equal(before.filter((i) => i.eligible).length, 3, JSON.stringify(before.map((i) => i.reason)));
  const limit = Math.floor(src.length * 0.35);
  const codec = createNodeCodec();
  const r = await stepA(src, limit, codec);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.bytes.length <= limit, `${r.bytes.length} > ${limit}`);
  assert.equal(r.changed, 3);
  const out = await PDFDocument.load(r.bytes);
  assert.equal(out.getPageCount(), 2);
  assert.equal(out.getAuthor(), undefined);
  assert.equal(out.getTitle(), undefined);
  assert.equal(out.catalog.get(PDFName.of('Metadata')), undefined);
  // The text is still text: the page still uses the Helvetica font and its content stream is untouched.
  const fonts = out.context.enumerateIndirectObjects().filter(([, o]) => o?.get?.(PDFName.of('Type'))?.toString() === '/Font');
  assert.equal(fonts.length, 1);
  const images = findImages(out);
  assert.ok(images.every((i) => i.filter === 'DCTDecode'), 'every photo is JPEG now');
  const junk = out.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.contents.length === 50_000);
  assert.equal(junk.length, 0, 'the unreachable object is gone');
});

test('step A says when even the readable floor is too big', async () => {
  const src = await textPdfWithPhotos();
  const r = await stepA(src, 60_000, createNodeCodec());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'floor');
  assert.ok(r.floorSize > 60_000);
});

test('step A on a PDF without photos reports no-images', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 20; i++) doc.addPage().drawText('text only', { x: 50, y: 700, font });
  const src = await doc.save({ useObjectStreams: false });
  const r = await stepA(src, 1000, createNodeCodec());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-images');
});

test('step B: rendered pages rebuilt under the limit, page sizes kept', async () => {
  const codec = createNodeCodec();
  const pages = 6;
  const renderer = {
    pageCount: pages,
    pageSize: async () => ({ width: 595.28, height: 841.89 }),
    renderPage: async (i, dpi) => {
      const w = Math.round((595.28 / 72) * dpi);
      const h = Math.round((841.89 / 72) * dpi);
      return { width: w, height: h, data: syntheticRGBA(w, h, i + 1, { noise: 30 }) };
    },
  };
  const limit = 1_500_000; // the floor (100 DPI, q 0.5) of these noisy pages is about 1.09 MB
  const r = await stepB(renderer, limit, codec);
  assert.equal(r.ok, true, JSON.stringify(r.reason));
  assert.ok(r.bytes.length <= limit);
  const out = await PDFDocument.load(r.bytes);
  assert.equal(out.getPageCount(), pages);
  const { width, height } = out.getPage(0).getSize();
  assert.ok(Math.abs(width - 595.28) < 0.01 && Math.abs(height - 841.89) < 0.01);
});

test('split with pages as images: one render per page, fewest parts, each under the limit, pages in order', async () => {
  const { splitPages } = await import('../docs/js/engine/pdf-shrink.js');
  const codec = createNodeCodec();
  let renders = 0;
  const pages = 12;
  const renderer = {
    pageCount: pages,
    pageSize: async () => ({ width: 595.28, height: 841.89 }),
    renderPage: async (i, dpi) => {
      renders++;
      const w = Math.round((595.28 / 72) * dpi);
      const h = Math.round((841.89 / 72) * dpi);
      return { width: w, height: h, data: syntheticRGBA(w, h, i + 1, { noise: 30 }) };
    },
  };
  const limit = 700_000;
  const r = await splitPages(renderer, limit, codec, { parts: 4 });
  assert.equal(r.ok, true);
  assert.equal(renders, pages, 'each page rendered once');
  assert.ok(r.parts.length <= 4, `${r.parts.length} parts`);
  let next = 1;
  for (const p of r.parts) {
    assert.ok(p.bytes.length <= limit, `${p.bytes.length} > ${limit}`);
    assert.equal(p.pages[0], next);
    const doc = await PDFDocument.load(p.bytes);
    assert.equal(doc.getPageCount(), p.pages[1] - p.pages[0] + 1);
    next = p.pages[1] + 1;
  }
  assert.equal(next, pages + 1);
});

test('compacting: identical streams are stored once, uncompressed ones get compressed', async () => {
  const { compactStreams } = await import('../docs/js/engine/pdf-shrink.js');
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  // The same 40 KB uncompressed content stream written separately for two pages (as some exporters do).
  const ops = Array.from({ length: 2000 }, (_, i) => `${(i * 7) % 500} ${(i * 13) % 800} 2 2 re f`).join('\n');
  for (let p = 0; p < 2; p++) {
    const page = doc.addPage([595, 842]);
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(ops)));
  }
  const before = await doc.save({ useObjectStreams: false });
  const r = await compactStreams(doc);
  assert.equal(r.merged, 1);
  assert.ok(r.compressed >= 1);
  const after = await doc.save({ useObjectStreams: false });
  assert.ok(after.length < before.length / 3, `${after.length} vs ${before.length}`);
  const back = await PDFDocument.load(after);
  const [a, b] = back.getPages().map((p) => p.node.get(PDFName.of('Contents')));
  assert.equal(a.toString(), b.toString(), 'both pages point at one stream');
});

test('step A re-encodes palette (indexed) images too', async () => {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const w = 600, h = 450;
  const idx = new Uint8Array(w * h);
  let s = 7;
  for (let i = 0; i < idx.length; i++) idx[i] = (Math.floor((i % w) / 3 + i / w / 3) + (((s = (s * 1103515245 + 12345) >>> 0) >>> 28) & 3)) % 200; // a gradient with a little grain
  const palette = new Uint8Array(200 * 3).map((_, i) => [Math.floor(i / 3), 220 - Math.floor(i / 6), 60 + Math.floor(i / 5)][i % 3]); // a smooth colour ramp
  const img = ctx.register(ctx.stream(zlib.deflateSync(idx), {
    Type: 'XObject', Subtype: 'Image', Width: w, Height: h, BitsPerComponent: 8, Filter: 'FlateDecode',
    ColorSpace: ctx.obj(['Indexed', 'DeviceRGB', 199, PDFHexString.of(Buffer.from(palette).toString('hex'))]),
  }));
  const page = doc.addPage([595, 842]);
  const name = page.node.newXObject('Pal', img);
  page.node.addContentStream(ctx.register(ctx.stream(`q 500 0 0 375 40 300 cm ${name.toString()} Do Q`)));
  const src = await doc.save();
  const found = findImages(await loadPdf(src));
  assert.equal(found[0].eligible, true, found[0].reason);
  const limit = Math.floor(src.length * 0.5);
  const r = await stepA(src, limit, createNodeCodec());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.bytes.length <= limit);
  const out = findImages(await loadPdf(r.bytes));
  assert.equal(out[0].filter, 'DCTDecode');
});
