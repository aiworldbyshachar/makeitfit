import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from '../docs/vendor/pdf-lib/pdf-lib.esm.min.js';
import { makeItFit, splitToFit } from '../docs/js/engine/pipeline.js';
import { outputName } from '../docs/js/engine/sizes.js';
import { createNodeCodec, syntheticJpeg } from './helpers/node-codec.js';

const env = () => ({ codec: createNodeCodec() });
const photo = (name, w, h, seed, q = 0.95) => ({ name, bytes: syntheticJpeg(w, h, seed, q, { noise: 35 }) });

test('several photos -> one PDF under the limit', async () => {
  const files = [photo('id-front.jpg', 1400, 1000, 1), photo('id-back.jpg', 1400, 1000, 2), photo('payslip.jpg', 1000, 1400, 3)];
  const total = files.reduce((s, f) => s + f.bytes.length, 0);
  const limit = Math.floor(total * 0.5);
  const r = await makeItFit({ files, limit }, env());
  assert.equal(r.status, 'done');
  assert.equal(r.method, 'photos');
  assert.equal(r.outputs[0].name, outputName('id-front.jpg', limit, 'pdf'));
  assert.ok(r.outputs[0].size <= limit, `${r.outputs[0].size} > ${limit}`);
  assert.equal((await PDFDocument.load(r.outputs[0].bytes)).getPageCount(), 3);
});

test('a photo that already fits as JPG comes back unchanged', async () => {
  const f = photo('small.jpg', 300, 200, 4, 0.8);
  const r = await makeItFit({ files: [f], limit: 1_000_000 }, env());
  assert.equal(r.status, 'already-fits');
  assert.equal(r.outputs[0].bytes, f.bytes);
});

test('one big photo -> a JPG under the limit', async () => {
  const f = photo('big.jpg', 1800, 1200, 5);
  const limit = Math.floor(f.bytes.length * 0.4);
  const r = await makeItFit({ files: [f], limit }, env());
  assert.equal(r.status, 'done');
  assert.equal(r.outputs[0].name, outputName('big.jpg', limit, 'jpg'));
  assert.ok(r.outputs[0].size <= limit);
});

test('the one rule: a Word file or a video is refused by name', async () => {
  const word = { name: 'letter.docx', bytes: Uint8Array.from('PK\x03\x04word/document.xml.......', (c) => c.charCodeAt(0)) };
  const r = await makeItFit({ files: [word, photo('a.jpg', 100, 100, 1)], limit: 1_000_000 }, env());
  assert.equal(r.status, 'unsupported');
  assert.deepEqual(r.names, ['letter.docx']);
});

async function scannedPdf(pages, w, h) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    page.drawImage(await doc.embedJpg(syntheticJpeg(w, h, 50 + i, 0.92, { noise: 30 })), { x: 0, y: 0, width: 595, height: 842 });
    page.drawText(`page ${i + 1}`, { x: 20, y: 20, size: 9, font });
  }
  return doc.save();
}

test('a PDF that step A cannot bring down asks before turning pages into images', async () => {
  const src = await scannedPdf(4, 900, 1270);
  const r = await makeItFit({ files: [{ name: 'scan.pdf', bytes: src }], limit: 40_000 }, env());
  assert.equal(r.status, 'ask-rasterize');
  assert.equal(r.stepA.reason, 'floor');
  assert.ok(r.source.length > 0);
  assert.equal(r.name, 'scan.pdf'); // the original name; the output adds the limit
});

test('split keeping the text: every part under the limit, all pages in order', async () => {
  const src = await scannedPdf(6, 700, 990);
  const limit = Math.floor(src.length / 3);
  const r = await splitToFit({ mode: 'stepA', source: src, limit, parts: 2, name: 'long.pdf' }, env());
  assert.equal(r.status, 'done');
  let pages = 0;
  for (const [i, o] of r.outputs.entries()) {
    assert.ok(o.size <= limit, `part ${i + 1}: ${o.size} > ${limit}`);
    assert.match(o.name, new RegExp(`long \\(.+\\) - part ${i + 1} of ${r.outputs.length}\\.pdf`));
    pages += (await PDFDocument.load(o.bytes)).getPageCount();
  }
  assert.equal(pages, 6);
});

test('a PDF plus a photo combine into one PDF under the limit', async () => {
  const src = await scannedPdf(2, 700, 990);
  const files = [{ name: 'form.pdf', bytes: src }, photo('receipt.jpg', 1000, 1400, 7)];
  const limit = Math.floor((src.length + files[1].bytes.length) * 0.5);
  const r = await makeItFit({ files, limit }, env());
  assert.equal(r.status, 'done', JSON.stringify({ status: r.status, stepA: r.stepA }));
  assert.ok(r.outputs[0].size <= limit);
  assert.equal((await PDFDocument.load(r.outputs[0].bytes)).getPageCount(), 3);
});

test('a rotated PDF comes back with its pages turned', async () => {
  const src = await scannedPdf(2, 300, 420);
  const r = await makeItFit({ files: [{ name: 'sideways.pdf', bytes: src, rotate: 90 }], limit: 10_000_000 }, env());
  assert.equal(r.status, 'done');
  const doc = await PDFDocument.load(r.outputs[0].bytes);
  assert.deepEqual(doc.getPages().map((p) => p.getRotation().angle), [90, 90]);
});

/** A report that is mostly vector drawings and text (charts, no photos): like the 1.6 MB PDF from the iPhone test. */
async function vectorReport(pages, marksPerPage) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let s = 3;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Quarterly figures - page ${p + 1}`, { x: 50, y: 790, size: 16, font });
    const ops = [];
    for (let i = 0; i < marksPerPage; i++) ops.push(`${(50 + rnd() * 495).toFixed(2)} ${(120 + rnd() * 600).toFixed(2)} ${(1 + rnd() * 3).toFixed(2)} ${(1 + rnd() * 3).toFixed(2)} re`);
    page.pushOperators();
    page.node.addContentStream(doc.context.register(doc.context.flateStream(`0.3 0.4 0.8 rg\n${ops.join('\n')}\nf`)));
  }
  return doc.save();
}

test('a vector-heavy PDF that step A cannot shrink splits into files that keep the text', async () => {
  const { chooseAfterStepA } = await import('../docs/js/engine/split.js');
  const src = await vectorReport(10, 5000);
  const limit = Math.floor(src.length * 0.62);
  const r = await makeItFit({ files: [{ name: 'report.pdf', bytes: src }], limit }, env());
  assert.equal(r.status, 'ask-rasterize');
  assert.equal(r.stepA.reason, 'no-images');
  // As images it would be far bigger than the original (estimated on the page; here: twice the original).
  const plan = chooseAfterStepA({ floorA: r.stepA.size, floorB: src.length * 2, limit });
  assert.equal(plan.action, 'split-text');
  const s = await splitToFit({ mode: 'stepA', source: r.source, limit, parts: plan.parts, maxParts: plan.maxParts, name: 'report.pdf' }, env());
  assert.equal(s.status, 'done');
  assert.equal(s.outputs.length, 2);
  for (const o of s.outputs) assert.ok(o.size <= limit, `${o.size} > ${limit}`);
});
