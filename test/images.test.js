import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { sniff, scaledSize, stripExif, inflate, unpredictPng, toRGBA } from '../docs/js/engine/images.js';
import { syntheticJpeg } from './helpers/node-codec.js';

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const pad = (b) => { const o = new Uint8Array(64); o.set(b); return o; };

test('sniff tells the allowed kinds apart and rejects the rest', () => {
  assert.equal(sniff(pad(ascii('%PDF-1.7\n'))), 'pdf');
  assert.equal(sniff(pad([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.equal(sniff(pad([0x89, ...ascii('PNG\r\n')])), 'png');
  assert.equal(sniff(pad(ascii('RIFF\0\0\0\0WEBPVP8 '))), 'webp');
  assert.equal(sniff(pad(ascii('\0\0\0\x18ftypheic\0\0\0\0mif1heic'))), 'heic');
  assert.equal(sniff(pad(ascii('PK\x03\x04word/document.xml'))), null); // a Word file
  assert.equal(sniff(pad(ascii('\0\0\0\x20ftypisom\0\0\x02\0isomiso2mp41'))), null); // a video
});

test('scaled size never upscales and keeps proportions', () => {
  assert.deepEqual(scaledSize(4032, 3024, 2000), { width: 2000, height: 1500 });
  assert.deepEqual(scaledSize(800, 600, 2000), { width: 800, height: 600 });
});

test('stripExif removes APP1 and keeps a decodable JPEG', () => {
  const jpg = syntheticJpeg(32, 16, 3);
  const exif = Uint8Array.from([0xff, 0xe1, 0x00, 0x08, ...ascii('Exif\0\0')]);
  const withExif = new Uint8Array(jpg.length + exif.length);
  withExif.set(jpg.subarray(0, 2));
  withExif.set(exif, 2);
  withExif.set(jpg.subarray(2), 2 + exif.length);
  const stripped = stripExif(withExif);
  assert.equal(stripped.length, jpg.length);
  assert.deepEqual(stripped, jpg);
});

test('Flate image data with PNG predictors decodes to RGBA', async () => {
  const w = 3, h = 2;
  // Row 0 filter Sub, row 1 filter Up, RGB.
  const rows = [
    [1, 10, 20, 30, 1, 1, 1, 1, 1, 1],
    [2, 5, 5, 5, 5, 5, 5, 5, 5, 5],
  ];
  const packed = zlib.deflateSync(Uint8Array.from(rows.flat()));
  const raw = unpredictPng(await inflate(packed), w, 3);
  assert.deepEqual([...raw], [10, 20, 30, 11, 21, 31, 12, 22, 32, 15, 25, 35, 16, 26, 36, 17, 27, 37]);
  const rgba = toRGBA(raw, w, h, 3);
  assert.equal(rgba.length, w * h * 4);
  assert.deepEqual([...rgba.subarray(0, 4)], [10, 20, 30, 255]);
});

test('palette images: 4-bit indices with a PNG predictor expand to their colours', async () => {
  const { expandIndexed } = await import('../docs/js/engine/images.js');
  // 3 x 2 pixels, 4-bit indices: row 0 = 0,1,2  row 1 = 3,0,1 (rows padded to whole bytes).
  const raw = Uint8Array.from([0x01, 0x20, 0x30, 0x10]);
  const palette = Uint8Array.from([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
  const rgb = expandIndexed(raw, 3, 2, 4, palette, 3);
  assert.deepEqual([...rgb], [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0]);
  // The same rows behind PNG "Up" filters (filter byte 2, row length 2 bytes).
  const withFilters = Uint8Array.from([2, 0x01, 0x20, 2, 0x2f, 0xf0]);
  const back = unpredictPng(await inflate(zlib.deflateSync(withFilters)), 3, 1, 4);
  assert.deepEqual([...back], [0x01, 0x20, 0x30, 0x10]);
});
