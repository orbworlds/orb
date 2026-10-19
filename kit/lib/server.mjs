// The kit's dev server (no dependencies). It serves:
//   /                      the local host page (host.html), which runs the world the way Orb does
//   /__orb/<file>          the host's own files (host.js, runtime.js)
//   /__orb/world.json      what the host needs to know about the world (orb.json, its shop)
//   /__orb/events          server-sent events: "reload" when a file of the world changes
//   /api/tree/<64 zeros>/  the world's files, with the headers Orb's file server sends (open CORS,
//                          the frame's sandbox as CSP), so a world behaves here exactly as on Orb

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TREE = '0'.repeat(64);
const SANDBOX_CSP = 'sandbox allow-scripts allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads';
const SKIP = /(^|[/\\])(\.git|node_modules|orb-kit)([/\\]|$)/;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};
const typeOf = (p) => TYPES[path.extname(p).toLowerCase()] ?? 'application/octet-stream';

/** orb.json of the world's folder (or the folder above it, for a packaged build): {} when there is none. */
function readOrbJson(dir) {
  for (const d of [dir, path.dirname(dir)]) {
    try {
      return JSON.parse(fs.readFileSync(path.join(d, 'orb.json'), 'utf8'));
    } catch {
      /* none here */
    }
  }
  return {};
}

/** The items of the page's `<script type="application/json" id="orb-shop">` (SPEC §7), as Orb would sell them. */
export function shopItems(html) {
  const m = /<script\b[^>]*\bid=["']orb-shop["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return [];
  let items;
  try {
    items = JSON.parse(m[1]).items;
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items) {
    if (out.length >= 40 || !it || typeof it !== 'object') continue;
    const { id, name, price, emoji, description } = it;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) continue;
    if (typeof name !== 'string' || !name.trim() || name.length > 40) continue;
    if (!Number.isInteger(price) || price < 1 || price > 1000) continue;
    out.push({ id, name: name.trim(), price, ...(typeof emoji === 'string' && emoji ? { emoji } : {}), ...(typeof description === 'string' && description.length <= 140 ? { description } : {}) });
  }
  return out;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end(body);
}

/**
 * Start serving the world in `dir` (a folder with an index.html). Resolves with the server and its
 * address once it listens.
 */
export function serve({ dir, port = 4242, host = '127.0.0.1', watch = true, quiet = false }) {
  const root = path.resolve(dir);
  if (!fs.existsSync(path.join(root, 'index.html'))) throw new Error(`${root} has no index.html`);
  const clients = new Set();

  if (watch) {
    let timer;
    try {
      fs.watch(root, { recursive: true }, (_event, file) => {
        if (file && SKIP.test(String(file))) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          for (const c of clients) c.write('data: reload\n\n');
        }, 120);
      });
    } catch {
      /* no file watching here: reload by hand */
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = decodeURIComponent(url.pathname);

    if (p === '/' || p === '/index.html') return send(res, 200, fs.readFileSync(path.join(HERE, 'host.html')), { 'content-type': TYPES['.html'] });
    if (p === '/__orb/world.json') {
      const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
      const meta = readOrbJson(root);
      const title = /<title>([^<]{1,80})<\/title>/i.exec(html)?.[1]?.trim();
      const id = typeof meta.world === 'string' && meta.world ? meta.world : `dev-${path.basename(root)}`;
      return send(
        res,
        200,
        JSON.stringify({ id, name: meta.name || title || path.basename(root), url: meta.url || null, repo: meta.repo || null, base: `/api/tree/${TREE}/`, shop: shopItems(html) }),
        { 'content-type': TYPES['.json'] },
      );
    }
    if (p === '/__orb/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': orb\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p.startsWith('/__orb/')) {
      const file = path.join(HERE, path.basename(p));
      if (!/\.(js|css|html)$/.test(file) || !fs.existsSync(file)) return send(res, 404, 'Not found');
      return send(res, 200, fs.readFileSync(file), { 'content-type': typeOf(file) });
    }

    const prefix = `/api/tree/${TREE}/`;
    if (!p.startsWith(prefix)) return send(res, 404, 'Not found');
    const headers = { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin', 'content-security-policy': SANDBOX_CSP, 'x-content-type-options': 'nosniff' };
    if (req.method === 'OPTIONS') return send(res, 204, null, { ...headers, 'access-control-allow-methods': 'GET, OPTIONS' });
    let rel = p.slice(prefix.length);
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) || SKIP.test(path.relative(root, file))) return send(res, 404, 'Not found', headers);
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'Not found', headers);
      res.writeHead(200, { ...headers, 'content-type': typeOf(file), 'content-length': st.size, 'cache-control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${addr.port}/`;
      if (!quiet) console.log(`Orb Local: ${url}  (open it in two tabs to play together)`);
      resolve({ server, url, close: () => new Promise((r) => { for (const c of clients) c.end(); server.close(() => r()); }) });
    });
  });
}
