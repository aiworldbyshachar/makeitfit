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
