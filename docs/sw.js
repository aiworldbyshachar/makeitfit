// Keeps every file of the site on the device after the first visit, so MakeItFit works with the
// Wi-Fi off. Nothing is sent anywhere: this only answers the page's own requests from the cache.
// The file list and the version below are written by `npm run sw` (scripts/build-sw.js).

// FILES-START (generated - do not edit by hand)
const VERSION = 'b51d4287c52e';
const FILES = [
  './',
  'css/site.css',
  'icons/apple-touch-icon.png',
  'icons/favicon-16.png',
  'icons/favicon-32.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-64.png',
  'icons/maskable-512.png',
  'index.html',
  'js/app.js',
  'js/engine/client.js',
  'js/engine/codec-browser.js',
  'js/engine/images.js',
  'js/engine/pdf-build.js',
  'js/engine/pdf-shrink.js',
  'js/engine/pipeline.js',
  'js/engine/render-pdfjs.js',
  'js/engine/search.js',
  'js/engine/sizes.js',
  'js/engine/split.js',
  'js/engine/worker.js',
  'js/i18n.js',
  'manifest.webmanifest',
  'vendor/libheif/libheif-bundle.mjs',
  'vendor/pdf-lib/pdf-lib.esm.min.js',
  'vendor/pdfjs/iccs/CGATS001Compat-v2-micro.icc',
  'vendor/pdfjs/pdf.min.mjs',
  'vendor/pdfjs/pdf.worker.min.mjs',
  'vendor/pdfjs/wasm/jbig2.wasm',
  'vendor/pdfjs/wasm/jbig2_nowasm_fallback.js',
  'vendor/pdfjs/wasm/openjpeg.wasm',
  'vendor/pdfjs/wasm/openjpeg_nowasm_fallback.js',
  'vendor/pdfjs/wasm/qcms_bg.wasm'
];
// FILES-END

const CACHE = `makeitfit-${VERSION}`;
const RUNTIME = 'makeitfit-runtime'; // CMaps for rare PDF fonts, kept the first time they're needed

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('makeitfit-') && k !== CACHE && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(async (hit) => {
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && new URL(req.url).pathname.includes('/vendor/pdfjs/cmaps/')) {
        const copy = res.clone();
        caches.open(RUNTIME).then((c) => c.put(req, copy));
      }
      return res;
    }),
  );
});
