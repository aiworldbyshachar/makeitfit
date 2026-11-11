// Copies the browser libraries from node_modules into docs/vendor/ so the site serves every file itself
// (no CDN). Run after `npm install`:  npm run vendor
// Each library keeps its own licence file next to it, and docs/vendor/NOTICE.md lists them all.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = path.join(root, 'node_modules');
const out = path.join(root, 'docs', 'vendor');

const version = (pkg) => JSON.parse(fs.readFileSync(path.join(nm, pkg, 'package.json'), 'utf8')).version;

function copy(from, to) {
  const src = path.join(nm, from);
  const dst = path.join(out, to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}

fs.rmSync(out, { recursive: true, force: true });

// pdf.js (Apache-2.0) - the "legacy" build, which also runs on older phones (iOS 15/16 Safari).
const pdfjs = version('pdfjs-dist');
copy('pdfjs-dist/legacy/build/pdf.min.mjs', 'pdfjs/pdf.min.mjs');
copy('pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'pdfjs/pdf.worker.min.mjs');
copy('pdfjs-dist/cmaps', 'pdfjs/cmaps');
copy('pdfjs-dist/iccs', 'pdfjs/iccs');
for (const f of ['jbig2.wasm', 'jbig2_nowasm_fallback.js', 'openjpeg.wasm', 'openjpeg_nowasm_fallback.js', 'qcms_bg.wasm',
  'LICENSE_JBIG2', 'LICENSE_OPENJPEG', 'LICENSE_PDFJS_JBIG2', 'LICENSE_PDFJS_OPENJPEG', 'LICENSE_PDFJS_QCMS', 'LICENSE_QCMS']) {
  copy(`pdfjs-dist/wasm/${f}`, `pdfjs/wasm/${f}`);
}
copy('pdfjs-dist/LICENSE', 'pdfjs/LICENSE');

// pdf-lib (MIT) - ES module build.
const pdflib = version('pdf-lib');
copy('pdf-lib/dist/pdf-lib.esm.min.js', 'pdf-lib/pdf-lib.esm.min.js');
copy('pdf-lib/LICENSE.md', 'pdf-lib/LICENSE.md');

// libheif-js (LGPL-3.0) - a separate, unmodified file, loaded only when a HEIC photo arrives and the
// browser can't decode HEIC itself. The LICENSE files hold the LGPL-3.0 and GPL-3.0 texts.
const heif = version('libheif-js');
copy('libheif-js/libheif-wasm/libheif-bundle.mjs', 'libheif/libheif-bundle.mjs');
copy('libheif-js/libheif-wasm/LICENSE', 'libheif/LICENSE');
copy('libheif-js/LICENSE', 'libheif/LICENSE-libheif-js');

const notice = `# Third-party libraries

MakeItFit's own code is MIT (see LICENSE in the repository root). The site serves these libraries from
this folder - nothing is loaded from a CDN. They are copied unmodified from npm by \`scripts/vendor.js\`.

| Folder | Library | Version | Licence | Source |
|---|---|---|---|---|
| \`pdfjs/\` | pdf.js (pdfjs-dist, legacy build) with its JBIG2, OpenJPEG and QCMS WebAssembly modules, CMaps and ICC profile | ${pdfjs} | Apache-2.0 (modules: see \`pdfjs/wasm/LICENSE_*\`) | https://github.com/mozilla/pdf.js |
| \`pdf-lib/\` | pdf-lib (ES module build, includes pako and tslib) | ${pdflib} | MIT | https://github.com/Hopding/pdf-lib |
| \`libheif/\` | libheif-js: libheif with the libde265 HEVC decoder, compiled to WebAssembly | ${heif} | LGPL-3.0 | https://github.com/catdad-experiments/libheif-js, https://github.com/strukturag/libheif, https://github.com/strukturag/libde265 |

## About the LGPL component
\`libheif/libheif-bundle.mjs\` is licensed under the GNU Lesser General Public License v3.0 (full LGPL-3.0 and
GPL-3.0 texts in \`libheif/LICENSE\` and \`libheif/LICENSE-libheif-js\`). It is a separate file that MakeItFit
loads at runtime and never changes. You may replace it with your own build of the same library: put a
compatible \`libheif-bundle.mjs\` in this folder. Its complete source code is at the links above (npm
package \`libheif-js@${heif}\`).
`;
fs.writeFileSync(path.join(out, 'NOTICE.md'), notice);
console.log(`vendored pdf.js ${pdfjs}, pdf-lib ${pdflib}, libheif-js ${heif} into docs/vendor/`);
