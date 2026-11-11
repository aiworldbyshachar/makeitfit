// Generates the test sample set into test/samples/ (gitignored). Every file is synthetic - no real
// documents. Needs ffmpeg on the PATH (JPEG, JPEG 2000 and HEVC encoding).  npm run samples
//
//   iphone-id-front.heic, iphone-id-back.heic, iphone-payslip.heic   iPhone-size HEIC photos (12 MP)
//   photo-rotated-gps.jpg     12 MP JPEG stored sideways with EXIF Orientation 6 and a GPS location
//   small-fits.jpg            a photo that already fits 1 MB
//   screenshot-huge.png       a 5120 x 2880 PNG screenshot
//   text-with-photos.pdf      selectable text + big photos (step A territory)
//   scan-60.pdf               60 scanned pages stored as JPEG 2000 (step A can't touch them -> step B)
//   long-300.pdf              300 scanned pages (too big for 2 MB even at the floor -> split)
//   vector-report-25.pdf      25 pages of charts and text, no photos (as images it would grow -> split, text kept)
//   letter.docx               not a photo or a PDF (the one rule)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from '../docs/vendor/pdf-lib/pdf-lib.esm.min.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'samples');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'makeitfit-samples-'));
fs.mkdirSync(out, { recursive: true });
const only = process.argv.slice(2);
const want = (name) => !only.length || only.some((o) => name.includes(o));

// ---------- pixels ----------

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** RGB24 raster of a document photographed on a table (or a flat scan with `scan: true`). */
function documentPhoto(width, height, seed, { scan = false, gray = false, noise = 16, card = false } = {}) {
  const r = rng(seed);
  const px = new Uint8Array(width * height * (gray ? 1 : 3));
  // The paper's rectangle: almost the whole frame for a scan, a tilted-free inset for a photo.
  const m = scan ? 0 : Math.round(Math.min(width, height) * 0.08);
  const left = m + (scan ? 0 : Math.round(width * 0.04));
  const right = width - m;
  const top = m;
  const bottom = height - m;
  const line = Math.max(8, Math.round(height / (card ? 30 : 70)));
  const glyph = Math.max(3, Math.round(line * 0.55));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const n = (r() - 0.5) * noise;
      let R, G, B;
      const onPaper = x >= left && x < right && y >= top && y < bottom;
      if (onPaper) {
        const shade = scan ? 0 : -18 * ((x - left) / (right - left)) - 10 * ((y - top) / (bottom - top));
        R = 238 + shade; G = 235 + shade; B = 226 + shade;
        const py = y - top - line * 2;
        const px0 = x - left - line * 2;
        const inText = py > 0 && px0 > 0 && x < right - line * 2 && y < bottom - line * 2;
        if (inText) {
          const row = Math.floor(py / line);
          const inRow = py % line;
          const word = Math.floor(px0 / (glyph * 6)) + row * 7;
          const gap = (px0 % (glyph * 6)) > glyph * 5;
          const rowLen = 0.55 + 0.45 * ((row * 7919) % 100) / 100;
          if (inRow > line * 0.25 && inRow < line * 0.75 && !gap && px0 < (right - left - line * 4) * rowLen && word % 9 !== 0) {
            const ink = scan ? 175 : 150 + ((x * 3 + y * 5) % 40); // scans: even ink on clean paper
            R -= ink; G -= ink; B -= ink - 10;
          }
        }
        if (card && x > left + (right - left) * 0.68 && x < right - line * 2 && y > top + line * 3 && y < top + (bottom - top) * 0.62) {
          // The ID photo: a soft colourful patch.
          R = 170 + 40 * Math.sin(x / 37); G = 120 + 30 * Math.cos(y / 29); B = 110 + 20 * Math.sin((x + y) / 53);
        }
      } else {
        // A wooden table.
        const grain = 18 * Math.sin(y / 9 + Math.sin(x / 140) * 3) + 8 * Math.sin(y / 2.7);
        R = 128 + grain; G = 88 + grain * 0.8; B = 58 + grain * 0.5;
      }
      const i = y * width + x;
      if (gray) px[i] = clamp(0.3 * R + 0.59 * G + 0.11 * B + n);
      else {
        px[i * 3] = clamp(R + n);
        px[i * 3 + 1] = clamp(G + n);
        px[i * 3 + 2] = clamp(B + n);
      }
    }
  }
  return px;
}

/** Rotates an RGB24 raster 90 degrees counter-clockwise (how a camera stores a portrait shot). */
function rotateCCW(px, width, height) {
  const outPx = new Uint8Array(px.length);
  const w2 = height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = y;
      const ny = width - 1 - x;
      const s = (y * width + x) * 3;
      const d = (ny * w2 + nx) * 3;
      outPx[d] = px[s]; outPx[d + 1] = px[s + 1]; outPx[d + 2] = px[s + 2];
    }
  }
  return outPx;
}

// ---------- encoders ----------

function ffmpeg(args, input) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { input, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  return r.stdout;
}

function encode(px, width, height, { gray = false, codec = 'jpeg', q = 2 } = {}) {
  const raw = path.join(tmp, `in-${Math.random().toString(36).slice(2)}.raw`);
  fs.writeFileSync(raw, px);
  const input = ['-f', 'rawvideo', '-pix_fmt', gray ? 'gray' : 'rgb24', '-s', `${width}x${height}`, '-i', raw, '-frames:v', '1'];
  let file;
  if (codec === 'jpeg') {
    file = raw + '.jpg';
    ffmpeg([...input, '-c:v', 'mjpeg', '-q:v', String(q), '-pix_fmt', gray ? 'gray' : 'yuvj420p', '-update', '1', file]);
  } else if (codec === 'jpx') {
    file = raw + '.jp2';
    ffmpeg([...input, '-c:v', 'jpeg2000', '-q:v', String(q), '-pix_fmt', gray ? 'gray' : 'rgb24', '-update', '1', file]);
  } else if (codec === 'hevc') {
    file = raw + '.hevc';
    ffmpeg([...input, '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-colorspace', 'bt470bg', '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-color_range', 'tv', '-crf', String(q), '-preset', 'medium', '-x265-params', 'log-level=error:keyint=1:info=0', '-f', 'hevc', file]);
  }
  const bytes = fs.readFileSync(file);
  fs.rmSync(raw);
  fs.rmSync(file);
  return new Uint8Array(bytes);
}

// ---------- HEIF (HEIC) container around one HEVC still ----------

const u8 = (...v) => Uint8Array.from(v);
const u16 = (v) => u8(v >> 8, v & 255);
const u32 = (v) => u8(v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255);
const str = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
function cat(...parts) {
  const o = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let i = 0;
  for (const p of parts) { o.set(p, i); i += p.length; }
  return o;
}
const box = (type, ...body) => { const b = cat(...body); return cat(u32(b.length + 8), str(type), b); };
const fullbox = (type, version, flags, ...body) => box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...body);

function nalUnits(annexB) {
  const units = [];
  let i = 0;
  const starts = [];
  while (i + 3 < annexB.length) {
    if (annexB[i] === 0 && annexB[i + 1] === 0 && (annexB[i + 2] === 1 || (annexB[i + 2] === 0 && annexB[i + 3] === 1))) {
      const len = annexB[i + 2] === 1 ? 3 : 4;
      starts.push([i, i + len]);
      i += len;
    } else i++;
  }
  for (let k = 0; k < starts.length; k++) {
    let end = k + 1 < starts.length ? starts[k + 1][0] : annexB.length;
    while (end > starts[k][1] && annexB[end - 1] === 0) end--;
    const nal = annexB.subarray(starts[k][1], end);
    units.push({ type: (nal[0] >> 1) & 0x3f, data: nal });
  }
  return units;
}

function unescapeRbsp(nal) {
  const o = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    o.push(nal[i]);
  }
  return Uint8Array.from(o);
}

function heif(annexB, width, height) {
  const nals = nalUnits(annexB);
  const vps = nals.find((n) => n.type === 32);
  const sps = nals.find((n) => n.type === 33);
  const pps = nals.find((n) => n.type === 34);
  const slices = nals.filter((n) => n.type < 32);
  const rb = unescapeRbsp(sps.data);
  // SPS: 2-byte header, 1 byte (vps id, max sub layers, nesting), then profile_tier_level (12 bytes).
  const ptl = rb.subarray(3, 15);
  const arrays = [vps, sps, pps].map((n) => cat(u8(0x80 | n.type), u16(1), u16(n.data.length), n.data));
  const hvcC = box('hvcC', u8(1), ptl.subarray(0, 1), ptl.subarray(1, 5), ptl.subarray(5, 11), ptl.subarray(11, 12),
    u16(0xf000), u8(0xfc), u8(0xfc | 1), u8(0xf8), u8(0xf8), u16(0), u8(0x0f), u8(arrays.length), ...arrays);
  const ispe = fullbox('ispe', 0, 0, u32(width), u32(height));
  const pixi = fullbox('pixi', 0, 0, u8(3, 8, 8, 8));
  const colr = box('colr', str('nclx'), u16(1), u16(13), u16(6), u8(0)); // BT.709 primaries, sRGB transfer, BT.601 matrix, limited range
  const ipco = box('ipco', hvcC, ispe, pixi, colr);
  const ipma = fullbox('ipma', 0, 0, u32(1), u16(1), u8(4), u8(0x81), u8(0x02), u8(0x03), u8(0x04));
  const iprp = box('iprp', ipco, ipma);
  const mdatPayload = cat(...slices.map((s) => cat(u32(s.data.length), s.data)));
  const ftyp = box('ftyp', str('heic'), u32(0), str('mif1'), str('heic'));
  const hdlr = fullbox('hdlr', 0, 0, u32(0), str('pict'), u32(0), u32(0), u32(0), u8(0));
  const pitm = fullbox('pitm', 0, 0, u16(1));
  const iinf = fullbox('iinf', 0, 0, u16(1), fullbox('infe', 2, 0, u16(1), u16(0), str('hvc1'), u8(0)));
  const buildMeta = (offset) => fullbox('meta', 0, 0, hdlr, pitm,
    fullbox('iloc', 0, 0, u8(0x44, 0x00), u16(1), u16(1), u16(0), u16(1), u32(offset), u32(mdatPayload.length)), iinf, iprp);
  const metaLen = buildMeta(0).length;
  const offset = ftyp.length + metaLen + 8;
  return cat(ftyp, buildMeta(offset), box('mdat', mdatPayload));
}

// ---------- EXIF (orientation + GPS) ----------

function exifApp1({ orientation, lat, lon }) {
  // Little-endian TIFF. IFD0: Orientation, GPS pointer. GPS IFD: lat/lon refs and values.
  const le16 = (v) => u8(v & 255, v >> 8);
  const le32 = (v) => u8(v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24);
  const entry = (tag, type, count, value) => cat(le16(tag), le16(type), le32(count), value);
  const dms = (deg) => {
    const d = Math.floor(deg);
    const m = Math.floor((deg - d) * 60);
    const s = Math.round(((deg - d) * 60 - m) * 60 * 100);
    return cat(le32(d), le32(1), le32(m), le32(1), le32(s), le32(100));
  };
  const ifd0At = 8;
  const ifd0Size = 2 + 2 * 12 + 4;
  const gpsAt = ifd0At + ifd0Size;
  const gpsSize = 2 + 4 * 12 + 4;
  const latAt = gpsAt + gpsSize;
  const lonAt = latAt + 24;
  const tiff = cat(
    str('II'), le16(42), le32(ifd0At),
    le16(2), entry(0x0112, 3, 1, cat(le16(orientation), le16(0))), entry(0x8825, 4, 1, le32(gpsAt)), le32(0),
    le16(4), entry(1, 2, 2, cat(str(lat >= 0 ? 'N' : 'S'), u8(0, 0, 0))), entry(2, 5, 3, le32(latAt)),
    entry(3, 2, 2, cat(str(lon >= 0 ? 'E' : 'W'), u8(0, 0, 0))), entry(4, 5, 3, le32(lonAt)), le32(0),
    dms(Math.abs(lat)), dms(Math.abs(lon)),
  );
  const body = cat(str('Exif'), u8(0, 0), tiff);
  return cat(u8(0xff, 0xe1), u16(body.length + 2), body);
}

const withExif = (jpeg, exif) => cat(jpeg.subarray(0, 2), exif, jpeg.subarray(2));

// ---------- PNG ----------

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(px, width, height) {
  const rows = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rows.set(px.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  const chunk = (type, data) => cat(u32(data.length), str(type), data, u32(crc32(cat(str(type), data))));
  return cat(u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk('IHDR', cat(u32(width), u32(height), u8(8, 2, 0, 0, 0))),
    chunk('IDAT', zlib.deflateSync(rows, { level: 6 })), chunk('IEND', new Uint8Array(0)));
}

/** A busy app screenshot: panels, text rows, a photo area with gradients and fine detail. */
function screenshot(width, height) {
  const r = rng(77);
  const px = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let R = 246, G = 246, B = 250;
      if (x < 360) { R = 32; G = 34; B = 48; }
      if (y < 90) { R = 85; G = 80; B = 216; }
      const inPhoto = x > 1700 && x < 4800 && y > 300 && y < 2500;
      if (inPhoto) {
        R = 120 + 90 * Math.sin(x / 210) * Math.cos(y / 170) + (r() - 0.5) * 50;
        G = 140 + 70 * Math.cos(x / 130 + y / 300) + (r() - 0.5) * 50;
        B = 160 + 60 * Math.sin((x + y) / 250) + (r() - 0.5) * 50;
      } else if (x > 420 && x < 1600 && y > 160 && (y % 46) > 16 && (y % 46) < 34 && ((x / 11) | 0) % 9 !== 0) {
        R = G = B = 60 + (r() * 30);
      }
      const i = (y * width + x) * 3;
      px[i] = clamp(R); px[i + 1] = clamp(G); px[i + 2] = clamp(B);
    }
  }
  return px;
}

// ---------- PDFs ----------

const A4 = [595.28, 841.89];
const lorem = 'This statement lists the payments made to you this month, the deductions, and the net amount transferred to your account. Keep it for your records.';

async function textWithPhotos() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let p = 0; p < 4; p++) {
    const page = doc.addPage(A4);
    page.drawText(`Monthly report - page ${p + 1} of 4`, { x: 50, y: 790, size: 18, font: bold, color: rgb(0.2, 0.2, 0.4) });
    let y = 760;
    for (let l = 0; l < 6; l++, y -= 16) page.drawText(lorem.slice(0, 80 + ((l * 13) % 40)), { x: 50, y, size: 10, font });
    const w = 3000, h = 2000;
    const jpg = encode(documentPhoto(w, h, 300 + p, { noise: 26 }), w, h, { q: 2 });
    page.drawImage(await doc.embedJpg(jpg), { x: 50, y: 250, width: 495, height: 330 });
    y = 220;
    for (let l = 0; l < 8; l++, y -= 16) page.drawText(lorem.slice(10, 90 + ((l * 7) % 50)), { x: 50, y, size: 10, font });
  }
  return doc.save();
}

/** Scanned pages: one image per page, in the given codec (DCTDecode JPEG or JPXDecode JPEG 2000). */
async function scannedPdf(pages, dpi, codec, seedBase, q, noise = 22) {
  const doc = await PDFDocument.create();
  const w = Math.round((A4[0] / 72) * dpi);
  const h = Math.round((A4[1] / 72) * dpi);
  for (let i = 0; i < pages; i++) {
    const px = documentPhoto(w, h, seedBase + i, { scan: true, gray: true, noise });
    const data = encode(px, w, h, { gray: true, codec, q });
    const page = doc.addPage(A4);
    let img;
    if (codec === 'jpeg') img = await doc.embedJpg(data);
    else {
      const ref = doc.context.register(doc.context.stream(data, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'JPXDecode' }));
      const name = page.node.newXObject('Scan', ref);
      page.pushOperators();
      page.node.addContentStream(doc.context.register(doc.context.stream(`q ${A4[0]} 0 0 ${A4[1]} 0 0 cm ${name.toString()} Do Q`)));
      img = null;
    }
    if (img) page.drawImage(img, { x: 0, y: 0, width: A4[0], height: A4[1] });
    if ((i + 1) % 20 === 0) console.log(`  ${i + 1} / ${pages} pages`);
  }
  return doc.save();
}

/** A report that is mostly charts (vector drawings) and text, no photos - step A can't shrink it, and as
 *  images it would be bigger than the original (the case found in the first iPhone test). */
async function vectorReport(pages, marks) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const r = rng(91);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage(A4);
    page.drawText(`Case analysis - section ${p + 1}`, { x: 50, y: 790, size: 18, font: bold, color: rgb(0.2, 0.2, 0.4) });
    for (let l = 0, y = 760; l < 5; l++, y -= 15) page.drawText(lorem.slice(0, 70 + l * 9), { x: 50, y, size: 10, font });
    const ops = [];
    for (let i = 0; i < marks; i++) ops.push(`${(50 + r() * 495).toFixed(2)} ${(140 + r() * 520).toFixed(2)} ${(1 + r() * 3).toFixed(2)} ${(1 + r() * 3).toFixed(2)} re`);
    page.node.addContentStream(doc.context.register(doc.context.flateStream(['0.25 0.35 0.75 rg', ...ops, 'f'].join('\n'))));
    for (let l = 0, y = 110; l < 4; l++, y -= 15) page.drawText(lorem.slice(5, 80 + l * 5), { x: 50, y, size: 10, font });
  }
  return doc.save();
}

// ---------- write ----------

function write(name, bytes) {
  fs.writeFileSync(path.join(out, name), bytes);
  console.log(`${name.padEnd(26)} ${bytes.length.toLocaleString('en-US').padStart(12)} bytes`);
}

const t0 = Date.now();
if (want('heic')) {
  for (const [name, w, h, seed, card] of [['iphone-id-front.heic', 4032, 3024, 11, true], ['iphone-id-back.heic', 4032, 3024, 12, true], ['iphone-payslip.heic', 3024, 4032, 13, false]]) {
    const hevc = encode(documentPhoto(w, h, seed, { noise: 22, card }), w, h, { codec: 'hevc', q: 24 });
    write(name, heif(hevc, w, h));
  }
}
if (want('rotated')) {
  const w = 3024, h = 4032; // upright portrait page...
  const sideways = rotateCCW(documentPhoto(w, h, 21, { noise: 22 }), w, h); // ...stored sideways like a camera does
  const jpg = encode(sideways, h, w, { q: 2 });
  write('photo-rotated-gps.jpg', withExif(jpg, exifApp1({ orientation: 6, lat: 32.0853, lon: 34.7818 })));
}
if (want('small')) write('small-fits.jpg', encode(documentPhoto(1200, 900, 31, { noise: 10 }), 1200, 900, { q: 5 }));
if (want('screenshot')) write('screenshot-huge.png', png(screenshot(5120, 2880), 5120, 2880));
if (want('text')) write('text-with-photos.pdf', await textWithPhotos());
if (want('scan')) write('scan-60.pdf', await scannedPdf(Number(process.env.SCAN_PAGES || 60), 200, 'jpx', 1000, Number(process.env.SCAN_Q || 10), Number(process.env.SCAN_NOISE || 8)));
if (want('long')) write('long-300.pdf', await scannedPdf(Number(process.env.LONG_PAGES || 300), 150, 'jpeg', 5000, Number(process.env.LONG_Q || 10), Number(process.env.LONG_NOISE || 3)));
if (want('vector')) write('vector-report-25.pdf', await vectorReport(25, 6000));
if (want('docx')) write('letter.docx', str('PK\x03\x04\x14\x00\x06\x00[Content_Types].xml word/document.xml - not a photo or a PDF'));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${path.relative(root, out)}`);

// Check the HEIC files decode with the same libheif build the site ships.
if (want('heic')) {
  const require = createRequire(import.meta.url);
  const libheif = require('libheif-js/wasm-bundle');
  for (const name of ['iphone-id-front.heic', 'iphone-payslip.heic']) {
    const images = new libheif.HeifDecoder().decode(fs.readFileSync(path.join(out, name)));
    console.log(`libheif reads ${name}: ${images.length} image, ${images[0]?.get_width()} x ${images[0]?.get_height()}`);
  }
}
