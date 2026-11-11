// Generates MakeItFit's icons as PNG files with no external tools (the family recipe from
// aiworld-brand/assets/tools/make-icons.js): a rounded square with the family gradient rotated to this
// tool's own hue step, a white page glyph with a lavender fold, and indigo arrows pressing in.
//
//   node scripts/make-icons.js              the site's icons into docs/icons/
//   node scripts/make-icons.js --variants   variants beside the family icons -> test/out/icons/sheet.png
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// The chosen look (see --variants): glyph style and hue rotation of the family gradient.
const ICON = { glyph: 'squeeze', hue: -235 }; // coral #F5756E -> #E8984F, picked 2026-11-11

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- PNG ----------
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
export function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * stride + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
/** Decodes an 8-bit RGBA, non-interlaced PNG (the family icons). */
function decodePNG(buf) {
  let i = 8, w = 0, h = 0;
  const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    i += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(w * h * 4);
  const rowLen = w * 4;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (rowLen + 1)];
    for (let x = 0; x < rowLen; x++) {
      const v = raw[y * (rowLen + 1) + 1 + x];
      const a = x >= 4 ? out[y * rowLen + x - 4] : 0;
      const b = y ? out[(y - 1) * rowLen + x] : 0;
      const c = y && x >= 4 ? out[(y - 1) * rowLen + x - 4] : 0;
      const p = a + b - c;
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      out[y * rowLen + x] = (f === 0 ? v : f === 1 ? v + a : f === 2 ? v + b : f === 3 ? v + ((a + b) >> 1) : v + pr) & 255;
    }
  }
  return { w, h, data: out };
}

// ---------- colours ----------
const hexToRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbToHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
export function shiftHue(hex, deg) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2, d = max - min;
  if (!d) return hex;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (((h * 60 + deg) % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return rgbToHex([(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255]);
}

// ---------- shapes (unit coordinates) ----------
const roundRect = (cx, cy, hw, hh, r) => (x, y) => {
  const qx = Math.abs(x - cx) - (hw - r), qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r <= 0;
};
const capsule = (ax, ay, bx, by, r) => (x, y) => {
  const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay;
  const t = Math.min(1, Math.max(0, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * t, pay - bay * t) <= r;
};
const triangle = (p1, p2, p3) => (x, y) => {
  const side = (a, b) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
  const d1 = side(p1, p2), d2 = side(p2, p3), d3 = side(p3, p1);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
const union = (...shapes) => (x, y) => shapes.some((s) => s(x, y));
/** An arrow from a to b (the head at b). */
const arrow = (ax, ay, bx, by, r, head) => {
  const len = Math.hypot(bx - ax, by - ay);
  const ux = (bx - ax) / len, uy = (by - ay) / len;
  const baseX = bx - ux * head, baseY = by - uy * head;
  const px = -uy * head * 0.78, py = ux * head * 0.78;
  return union(capsule(ax, ay, baseX + ux * r, baseY + uy * r, r), triangle([bx + ux * head * 0.12, by + uy * head * 0.12], [baseX + px, baseY + py], [baseX - px, baseY - py]));
};
const solid = (hex) => { const c = [...hexToRgb(hex), 255]; return () => c; };
const diagonal = (from, to) => {
  const a = hexToRgb(from), b = hexToRgb(to);
  return (x, y) => { const t = Math.min(1, Math.max(0, (x + y) / 2)); return [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t).concat(255); };
};

function render(size, layers, samples) {
  const out = new Uint8Array(size * size * 4);
  const n = samples * samples;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) / size, y = (py + (sy + 0.5) / samples) / size;
          let color = null;
          for (const layer of layers) if (layer.shape(x, y)) color = layer.erase ? null : layer.paint(x, y);
          if (color) { const al = color[3] / 255; r += color[0] * al; g += color[1] * al; b += color[2] * al; a += al; }
        }
      }
      const i = (py * size + px) * 4;
      if (a > 0) { out[i] = Math.round(r / a); out[i + 1] = Math.round(g / a); out[i + 2] = Math.round(b / a); }
      out[i + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

const INDIGO = '#4F46E5', LAVENDER = '#C7D2FE';
const WHITE = solid('#FFFFFF'), BLUE = solid(INDIGO);
const background = (shift) => diagonal(shiftHue('#6E72F5', shift), shiftHue('#8B4FE8', shift));

/**
 * The glyph inside a box (cx, cy, scale): a page with a folded corner.
 *   squeeze - two arrows on the page press in toward a centre line (the file is made to fit)
 *   corners - four arrows outside the page's corners point in at it
 */
function glyph(kind, cx, cy, s, bg) {
  const P = (x, y) => [cx + (x - 0.5) * s, cy + (y - 0.5) * s];
  const page = { l: 0.27, r: 0.73, t: 0.2, b: 0.8 };
  if (kind === 'corners') Object.assign(page, { l: 0.34, r: 0.66, t: 0.29, b: 0.73 });
  const fold = 0.13;
  const [pl, pt] = P(page.l, page.t), [pr, pb] = P(page.r, page.b);
  const pcx = (pl + pr) / 2, pcy = (pt + pb) / 2;
  const body = roundRect(pcx, pcy, (pr - pl) / 2, (pb - pt) / 2, 0.035 * s);
  const corner = triangle([pr - fold * s, pt - 0.01], [pr + 0.01, pt - 0.01], [pr + 0.01, pt + fold * s]);
  const flap = triangle([pr - fold * s, pt], [pr - fold * s, pt + fold * s], [pr, pt + fold * s]);
  // The folded corner shows the background through (repainted, not erased, so no hole in the icon).
  const layers = [{ shape: body, paint: WHITE }, { shape: union(corner, (x, y) => corner(x, y) && body(x, y)), paint: bg }, { shape: flap, paint: solid(LAVENDER) }];
  const r = 0.034 * s, head = 0.105 * s;
  if (kind === 'squeeze') {
    const y = pcy + 0.04 * s;
    const bar = capsule(pcx, y - 0.12 * s, pcx, y + 0.12 * s, r * 0.85);
    layers.push({ shape: union(arrow(pl + 0.045 * s, y, pcx - 0.05 * s, y, r, head), arrow(pr - 0.045 * s, y, pcx + 0.05 * s, y, r, head), bar), paint: BLUE });
  } else {
    const d = 0.13 * s;
    const ends = [[pl, pt], [pr, pt], [pl, pb], [pr, pb]];
    const arrows = ends.map(([ex, ey]) => {
      const dx = ex < pcx ? -1 : 1, dy = ey < pcy ? -1 : 1;
      return arrow(ex + dx * (d + 0.05 * s), ey + dy * (d + 0.05 * s), ex + dx * 0.025 * s, ey + dy * 0.025 * s, r * 0.85, head * 0.85);
    });
    layers.push({ shape: union(...arrows), paint: BLUE });
    layers.push({ shape: union(capsule(pl + 0.05 * s, pcy - 0.05 * s, pr - 0.05 * s, pcy - 0.05 * s, r * 0.6), capsule(pl + 0.05 * s, pcy + 0.05 * s, pr - 0.09 * s, pcy + 0.05 * s, r * 0.6)), paint: solid(LAVENDER) });
  }
  return layers;
}

/** App icon: the macOS-style margin around the rounded square (as the family's icon.png). */
const appIcon = ({ glyph: g, hue }) => [{ shape: roundRect(0.5, 0.5, 0.41, 0.41, 0.19), paint: background(hue) }, ...glyph(g, 0.5, 0.5, 0.82, background(hue))];
/** Full-bleed square (iOS home screen, PWA "maskable"): the glyph stays inside the 80% safe zone. */
const bleedIcon = ({ glyph: g, hue }, glyphScale = 0.74) => [{ shape: () => true, paint: background(hue) }, ...glyph(g, 0.5, 0.5, glyphScale, background(hue))];
/** Favicon: the rounded square fills the canvas so it reads at 16-32 px. */
const favIcon = ({ glyph: g, hue }) => [{ shape: roundRect(0.5, 0.5, 0.5, 0.5, 0.22), paint: background(hue) }, ...glyph(g, 0.5, 0.5, 1.08, background(hue))];

function write(rel, size, layers, samples = 4) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePNG(size, size, render(size, layers, samples)));
  console.log('wrote', rel);
}

// ---------- the comparison sheet ----------
function sheet(variants) {
  const family = ['copypastemacpc', 'foldersync', 'keybridge'].map((d) => decodePNG(fs.readFileSync(path.join(root, '..', d, 'assets', 'icon.png'))));
  const cell = 200, gap = 24, n = family.length + variants.length;
  const W = n * cell + (n + 2) * gap, H = cell + 150;
  const img = new Uint8Array(W * H * 4);
  const fill = (x0, y0, x1, y1, c) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.set(c, (y * W + x) * 4); };
  fill(0, 0, W, cell + 40, [245, 245, 248, 255]);
  fill(0, cell + 40, W, H, [20, 20, 27, 255]);
  const blit = (src, sw, x0, y0, size) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const sx = Math.floor((x * sw) / size), sy = Math.floor((y * sw) / size);
      const s = (sy * sw + sx) * 4, a = src[s + 3] / 255, d = ((y0 + y) * W + x0 + x) * 4;
      for (let k = 0; k < 3; k++) img[d + k] = Math.round(src[s + k] * a + img[d + k] * (1 - a));
    }
  };
  let x = gap;
  const icons = [...family.map((f) => ({ data: f.data, w: f.w })), ...variants.map((v) => ({ data: render(256, appIcon(v), 4), w: 256, look: v }))];
  icons.forEach((ic, i) => {
    if (i === family.length) x += gap * 2;
    blit(ic.data, ic.w, x, 20, cell);
    blit(ic.data, ic.w, x + 30, cell + 60, 64);
    const fav = ic.look ? render(32, favIcon(ic.look), 6) : ic.data;
    blit(fav, ic.look ? 32 : ic.w, x + 120, cell + 76, 32);
    x += cell + gap;
  });
  return { W, H, img };
}

if (process.argv.includes('--variants')) {
  const variants = [
    { glyph: 'squeeze', hue: -200 },
    { glyph: 'squeeze', hue: -235 },
    { glyph: 'squeeze', hue: -125 },
    { glyph: 'corners', hue: -235 },
  ];
  const { W, H, img } = sheet(variants);
  const out = path.join(root, 'test', 'out', 'icons');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'sheet.png'), encodePNG(W, H, img));
  for (const v of variants) console.log(`${v.glyph} ${v.hue}: ${shiftHue('#6E72F5', v.hue)} -> ${shiftHue('#8B4FE8', v.hue)}`);
  console.log('wrote test/out/icons/sheet.png');
} else {
  write('docs/icons/icon-512.png', 512, appIcon(ICON), 3);
  write('docs/icons/icon-192.png', 192, appIcon(ICON), 4);
  write('docs/icons/maskable-512.png', 512, bleedIcon(ICON, 0.62), 3);
  write('docs/icons/apple-touch-icon.png', 180, bleedIcon(ICON), 4);
  write('docs/icons/favicon-32.png', 32, favIcon(ICON), 8);
  write('docs/icons/favicon-16.png', 16, favIcon(ICON), 8);
  write('docs/icons/icon-64.png', 64, appIcon(ICON), 6);
}
