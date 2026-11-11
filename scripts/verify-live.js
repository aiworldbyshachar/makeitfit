// Checks the live site against this folder: every file in docs/ that git tracks is fetched from GitHub
// Pages and its SHA-256 compared with the local one.  node scripts/verify-live.js [base-url]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = (process.argv[2] || 'https://aiworldbyshachar.github.io/makeitfit/').replace(/\/?$/, '/');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const files = execFileSync('git', ['ls-files', 'docs'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !f.endsWith('/.nojekyll'));

let ok = 0;
const bad = [];
const queue = [...files];
async function worker() {
  for (let f = queue.shift(); f; f = queue.shift()) {
    const rel = f.slice('docs/'.length);
    const local = sha(fs.readFileSync(path.join(root, f)));
    try {
      const res = await fetch(base + rel, { cache: 'no-store' });
      const live = res.ok ? sha(Buffer.from(await res.arrayBuffer())) : `HTTP ${res.status}`;
      if (live === local) ok++;
      else bad.push(`${rel}: ${res.ok ? 'different content' : live}`);
    } catch (err) {
      bad.push(`${rel}: ${err.message}`);
    }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
console.log(`${ok} of ${files.length} files match ${base}`);
for (const b of bad) console.log(`  MISMATCH ${b}`);
process.exitCode = bad.length ? 1 : 0;
