# MakeItFit

Drop photos or PDFs, type the size limit ("under 3 MB"), get one file that fits - made entirely in your
browser. Nothing is uploaded.

Part of the free tools by [AI World by Shachar](https://aiworldbyshachar.github.io/).

**Status: in development** (not released yet).

- The one rule: photos and PDFs only (JPG, PNG, HEIC, WebP, PDF).
- "MB" means 1,000,000 bytes, so a "3 MB" result passes every site that checks 3 MB.
- No server, no upload, no account, no analytics, no cookies. Every library is served from this site.

## Develop
```bash
npm install
npm run vendor    # copy pdf.js, pdf-lib and the HEIC decoder into docs/vendor/
npm test          # engine tests (node --test)
npm run samples   # generate the test sample set into test/samples/
npm run preview   # http://localhost:5181/
```

## Licence
MIT. Third-party libraries in `docs/vendor/` keep their own licences (see `docs/vendor/NOTICE.md`); the HEIC
decoder is LGPL-3.0 and ships as a separate, replaceable file.
