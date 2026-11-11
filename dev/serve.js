// Local preview server (dev only):  npm run preview  ->  http://localhost:5181/
//   /docs/               the site (/ redirects here)
//   /dev/engine.html     the engine bench (drop files or run the generated samples)
//   /__samples           JSON list of the generated files in test/samples/
// Serves only this folder, never .env, .git, planning/ or CLAUDE.md. Port 5181 is MakeItFit's (07-family-apps.md).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 5181;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.heic': 'image/heic',
  '.md': 'text/plain; charset=utf-8',
};
const blocked = (rel) => /(^|[\\/])(\.env|\.git|planning|CLAUDE\.md|marketing|node_modules)([\\/]|$)/i.test(rel);

http
  .createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/__save' && req.method === 'POST') {
      // Dev only: the bench saves page previews into test/out/ (gitignored) for checking by eye.
      const name = (new URL(req.url, 'http://x').searchParams.get('name') || '').replace(/[^\w. -]/g, '_');
      if (!/\.(png|jpg|pdf)$/i.test(name)) return res.writeHead(400).end('bad name');
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        fs.mkdirSync(path.join(root, 'test', 'out'), { recursive: true });
        fs.writeFileSync(path.join(root, 'test', 'out', name), Buffer.concat(chunks));
        res.writeHead(200).end('saved');
      });
      return;
    }
    if (url === '/__samples') {
      const dir = path.join(root, 'test', 'samples');
      const files = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => !f.endsWith('.md')).map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size }))
        : [];
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(files));
    }
    // The site lives in docs/ (GitHub Pages serves that folder as the site root), so its relative links work there.
    if (url === '/') return res.writeHead(302, { Location: '/docs/' }).end();
    let file = path.normalize(path.join(root, url));
    if (url.endsWith('/')) file = path.join(file, 'index.html');
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || blocked(rel)) return res.writeHead(403).end('forbidden');
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end('not found');
      res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`MakeItFit preview at http://localhost:${PORT}/docs/  (engine bench: /dev/engine.html)`));
