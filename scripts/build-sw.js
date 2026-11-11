// Writes the service worker's file list and version (docs/sw.js, between FILES-START and FILES-END):
// every file the site needs offline, and a hash of their contents, so a change to any file makes
// browsers fetch the new set.  npm run sw   (the test fails when the list is out of date)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(root, 'docs');

/** Paths (relative to docs/, forward slashes) the site needs offline. */
export function offlineFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.startsWith('.')) continue; // .nojekyll and the like
      const full = path.join(dir, name);
      const rel = path.relative(docs, full).split(path.sep).join('/');
      if (fs.statSync(full).isDirectory()) {
        if (rel === 'vendor/pdfjs/cmaps') continue; // 1.4 MB for rare fonts: cached when first used
        walk(full);
      } else if (rel !== 'sw.js' && !/(^|\/)(LICENSE[^/]*|NOTICE\.md|[^/]*\.md)$/.test(rel)) {
        out.push(rel);
      }
    }
  };
  walk(docs);
  return ['./', ...out];
}

export function version(files) {
  const h = crypto.createHash('sha256');
  for (const f of files) {
    if (f === './') continue;
    h.update(f);
    h.update(fs.readFileSync(path.join(docs, f)));
  }
  return h.digest('hex').slice(0, 12);
}

export function block(files = offlineFiles()) {
  return `// FILES-START (generated - do not edit by hand)\nconst VERSION = '${version(files)}';\nconst FILES = ${JSON.stringify(files, null, 2).replace(/"/g, "'")};\n// FILES-END`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const sw = path.join(docs, 'sw.js');
  const text = fs.readFileSync(sw, 'utf8');
  const next = text.replace(/\/\/ FILES-START[\s\S]*?\/\/ FILES-END/, block());
  fs.writeFileSync(sw, next);
  const files = offlineFiles();
  console.log(`docs/sw.js: ${files.length} files, version ${version(files)}`);
}
