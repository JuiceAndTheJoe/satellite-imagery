// Minimal static-file server for OSC's Node runtime.
// Serves the repo root as a static site on PORT (default 8080).
import http from 'node:http';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
};

function safeJoin(root, urlPath) {
  // Strip query, decode, drop leading slash, normalize, then re-anchor under root.
  const clean = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  const resolved = path.normalize(path.join(root, clean));
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Allow': 'GET, HEAD' });
    res.end();
    return;
  }

  let filePath = safeJoin(ROOT, req.url || '/');
  if (!filePath) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  try {
    let stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = await fs.stat(filePath);
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    // Long cache for tiles/images, short cache for HTML so updates land.
    const isAsset = ext === '.jpg' || ext === '.jpeg' || ext === '.png' ||
                    ext === '.webp' || ext === '.json';
    const cache = isAsset ? 'public, max-age=86400' : 'public, max-age=60';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': cache,
    });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(filePath).pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
    }
  }
});

server.listen(PORT, () => {
  console.log(`satellite-imagery listening on :${PORT}`);
});
