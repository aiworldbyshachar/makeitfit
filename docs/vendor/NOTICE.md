# Third-party libraries

MakeItFit's own code is MIT (see LICENSE in the repository root). The site serves these libraries from
this folder - nothing is loaded from a CDN. They are copied unmodified from npm by `scripts/vendor.js`.

| Folder | Library | Version | Licence | Source |
|---|---|---|---|---|
| `pdfjs/` | pdf.js (pdfjs-dist, legacy build) with its JBIG2, OpenJPEG and QCMS WebAssembly modules, CMaps and ICC profile | 6.5.438 | Apache-2.0 (modules: see `pdfjs/wasm/LICENSE_*`) | https://github.com/mozilla/pdf.js |
| `pdf-lib/` | pdf-lib (ES module build, includes pako and tslib) | 1.17.1 | MIT | https://github.com/Hopding/pdf-lib |
| `libheif/` | libheif-js: libheif with the libde265 HEVC decoder, compiled to WebAssembly | 1.23.5 | LGPL-3.0 | https://github.com/catdad-experiments/libheif-js, https://github.com/strukturag/libheif, https://github.com/strukturag/libde265 |

## About the LGPL component
`libheif/libheif-bundle.mjs` is licensed under the GNU Lesser General Public License v3.0 (full LGPL-3.0 and
GPL-3.0 texts in `libheif/LICENSE` and `libheif/LICENSE-libheif-js`). It is a separate file that MakeItFit
loads at runtime and never changes. You may replace it with your own build of the same library: put a
compatible `libheif-bundle.mjs` in this folder. Its complete source code is at the links above (npm
package `libheif-js@1.23.5`).
