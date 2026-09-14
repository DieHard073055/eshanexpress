/**
 * Local helper for the offline product editor.
 *
 * A browser page cannot write to disk, so this tiny server does it. It binds
 * to 127.0.0.1 only and is never deployed — it exists so `admin-offline/` can
 * save data/products.json and drop images into admin-offline/images/.
 *
 *   npm run admin   ->  http://127.0.0.1:4321/products.html
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const IMAGES = join(ROOT, 'admin-offline', 'images');
const PORT = 4321;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
};

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function readBody(req, limitBytes = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limitBytes) throw new Error('Payload too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** Reject anything that could escape the intended directory. */
function safeName(name) {
  const base = normalize(String(name)).replace(/^(\.\.[/\\])+/, '').split(/[/\\]/).pop();
  if (!base || base.startsWith('.')) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(base)) return null;
  return base;
}

const server = createServer(async (req, res) => {
  // Same-origin only; this server has write access to the repo.
  res.setHeader('access-control-allow-origin', 'http://127.0.0.1:' + PORT);

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  try {
    // ---------------------------------------------------------------- API
    if (path === '/api/data' && req.method === 'GET') {
      const products = JSON.parse(await readFile(join(DATA, 'products.json'), 'utf8'));
      const stores = JSON.parse(await readFile(join(DATA, 'stores.json'), 'utf8'));
      const images = existsSync(IMAGES)
        ? (await readdir(IMAGES)).filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f)).sort()
        : [];
      return json(res, 200, { products, stores, images });
    }

    if (path === '/api/products' && req.method === 'PUT') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));

      if (!Array.isArray(body?.products)) {
        return json(res, 400, { error: 'Expected { products: [...] }' });
      }
      // Never overwrite a good file with something structurally broken.
      for (const p of body.products) {
        if (!p.sku || !p.title) {
          return json(res, 400, { error: `Every product needs a sku and title (bad: ${p.sku ?? '?'})` });
        }
      }

      const file = join(DATA, 'products.json');
      // Keep a single rollback copy: this is the catalog's source of truth.
      if (existsSync(file)) await writeFile(file + '.bak', await readFile(file));
      await writeFile(file, JSON.stringify(body, null, 2) + '\n');

      return json(res, 200, { ok: true, count: body.products.length });
    }

    if (path === '/api/image' && req.method === 'POST') {
      const name = safeName(url.searchParams.get('name') ?? '');
      if (!name) return json(res, 400, { error: 'Unsafe or missing filename' });
      if (!/\.(jpe?g|png|webp)$/i.test(name)) {
        return json(res, 400, { error: 'Only JPEG, PNG and WebP images are accepted' });
      }
      const buf = await readBody(req);
      if (!buf.length) return json(res, 400, { error: 'Empty file' });

      await mkdir(IMAGES, { recursive: true });
      await writeFile(join(IMAGES, name), buf);
      return json(res, 200, { ok: true, name, bytes: buf.length });
    }

    if (path === '/api/image' && req.method === 'DELETE') {
      const name = safeName(url.searchParams.get('name') ?? '');
      if (!name) return json(res, 400, { error: 'Unsafe or missing filename' });
      const target = join(IMAGES, name);
      if (existsSync(target)) await unlink(target);
      return json(res, 200, { ok: true });
    }

    // ------------------------------------------------------------- static
    let filePath;
    if (path === '/' || path === '/products.html') {
      filePath = join(ROOT, 'admin-offline', 'products.html');
    } else if (path.startsWith('/images/')) {
      const name = safeName(path.slice('/images/'.length));
      if (!name) return json(res, 400, { error: 'Bad image path' });
      filePath = join(IMAGES, name);
    } else if (path.startsWith('/src/')) {
      // The editor reuses src/lib modules rather than duplicating them.
      const rel = normalize(path).replace(/^([/\\])+/, '');
      filePath = join(ROOT, rel);
      if (!filePath.startsWith(join(ROOT, 'src'))) return json(res, 403, { error: 'Forbidden' });
    } else if (path.startsWith('/admin-offline/')) {
      const rel = normalize(path).replace(/^([/\\])+/, '');
      filePath = join(ROOT, rel);
      if (!filePath.startsWith(join(ROOT, 'admin-offline'))) return json(res, 403, { error: 'Forbidden' });
    } else {
      res.writeHead(404); return res.end('Not found');
    }

    if (!existsSync(filePath)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream' });
    res.end(await readFile(filePath));
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

// Loopback only. This process can write to the repo, so it must never be
// reachable from the network.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Product editor running at http://127.0.0.1:${PORT}/products.html`);
  console.log('  Writes to data/products.json and admin-offline/images/');
  console.log('  Local only — press Ctrl+C to stop.\n');
});
