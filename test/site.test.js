import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGES, STRINGS, createTranslator } from '../docs/js/i18n.js';
import { block, offlineFiles } from '../scripts/build-sw.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const flat = (msg) => (typeof msg === 'object' ? Object.values(msg) : [msg]);
const placeholders = (msg) => new Set(flat(msg).flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1])));

test('every language has every string, with the same placeholders', () => {
  for (const { code } of LANGUAGES) {
    const table = STRINGS[code];
    assert.ok(table, `missing language ${code}`);
    for (const key of Object.keys(STRINGS.en)) {
      assert.ok(key in table, `${code}: missing "${key}"`);
      const want = placeholders(STRINGS.en[key]);
      const got = placeholders(table[key]);
      for (const p of want) if (p !== 'n') assert.ok(got.has(p), `${code}.${key}: lost {${p}}`);
    }
  }
});

test('short hyphens only: no em or en dashes in any string or site file', () => {
  for (const { code } of LANGUAGES) {
    for (const [key, msg] of Object.entries(STRINGS[code])) for (const s of flat(msg)) assert.ok(!/[–—]/.test(s), `${code}.${key}: ${s}`);
  }
  const files = ['docs/index.html', 'docs/css/site.css', 'docs/manifest.webmanifest', 'docs/sw.js', 'README.md', 'dev/engine.html'];
  for (const f of fs.readdirSync(path.join(root, 'docs/js'), { recursive: true })) if (String(f).endsWith('.js')) files.push(`docs/js/${String(f).replace(/\\/g, '/')}`);
  for (const f of files) assert.ok(!/[–—]/.test(read(f)), `${f} has a long dash`);
});

test('every key the page uses exists', () => {
  const html = read('docs/index.html');
  const used = [...html.matchAll(/data-i18n(?:-html|-aria|-title)?="(\w+)"/g)].map((m) => m[1]);
  const js = read('docs/js/app.js');
  used.push(...[...js.matchAll(/\bt\('(\w+)'/g)].map((m) => m[1]));
  used.push(...[...js.matchAll(/'(stage\w+)'/g)].map((m) => m[1]));
  assert.ok(used.length > 40);
  for (const key of used) assert.ok(key in STRINGS.en, `missing string "${key}"`);
});

test('plurals and placeholders are filled in', () => {
  const { t } = createTranslator('en');
  assert.equal(t('pages', { n: 1 }), '1 page');
  assert.equal(t('pages', { n: 300 }), '300 pages');
  assert.equal(t('resultFits', { size: '2.94 MB', limit: '3 MB' }), '2.94 MB - fits under 3 MB');
  assert.equal(t('cantSplit', { n: 3 }), 'Split into 3 files');
  assert.equal(createTranslator('xx').code, 'en');
});

test('the page loads nothing from other sites, and says so in its CSP', () => {
  const html = read('docs/index.html');
  assert.match(html, /Content-Security-Policy" content="default-src 'self'/);
  assert.match(html, /connect-src 'self'/);
  for (const [, attr, url] of html.matchAll(/<(?:script|link|img)[^>]*?\b(src|href)="([^"]+)"/g)) {
    assert.ok(!/^(https?:)?\/\//.test(url), `${attr}="${url}" loads from another site`);
  }
  const css = read('docs/css/site.css');
  assert.ok(!/url\(\s*['"]?(https?:)?\/\//.test(css), 'the stylesheet loads from another site');
});

test('the service worker lists every file the site needs, and its list is up to date', () => {
  const files = offlineFiles();
  for (const must of ['index.html', 'js/app.js', 'js/engine/worker.js', 'vendor/pdf-lib/pdf-lib.esm.min.js', 'vendor/pdfjs/pdf.worker.min.mjs', 'vendor/pdfjs/wasm/openjpeg.wasm', 'vendor/libheif/libheif-bundle.mjs', 'icons/icon-192.png', 'manifest.webmanifest']) {
    assert.ok(files.includes(must), `missing ${must}`);
  }
  assert.ok(read('docs/sw.js').includes(block(files)), 'docs/sw.js is out of date - run npm run sw');
});

test('the manifest points at icons that exist', () => {
  const m = JSON.parse(read('docs/manifest.webmanifest'));
  assert.equal(m.name, 'MakeItFit');
  for (const icon of m.icons) assert.ok(fs.existsSync(path.join(root, 'docs', icon.src)), icon.src);
});
