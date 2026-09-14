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
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  // The capture endpoint is the only one the browser extension may call, so
  // it is the only one that accepts a chrome-extension:// origin. Everything
  // else stays same-origin, because this server can write to the repo.
  const origin = req.headers.origin ?? '';
  const fromExtension = origin.startsWith('chrome-extension://')
    || origin.startsWith('moz-extension://');

  if ((path === '/api/capture' || path === '/api/pricing' || path === '/api/supabase')
      && fromExtension) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  } else {
    res.setHeader('access-control-allow-origin', 'http://127.0.0.1:' + PORT);
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    // ------------------------------------------------------------ capture
    // Receives one product scraped from a page the user had open, with its
    // images already fetched by the extension. Saves images to disk and
    // stages the product for review in the editor — never publishes.
    if (path === '/api/capture' && req.method === 'POST') {
      const payload = JSON.parse((await readBody(req, 64 * 1024 * 1024)).toString('utf8'));
      const { product, images } = payload ?? {};

      if (!product?.title) return json(res, 400, { error: 'Capture needs a product title' });
      if (!Array.isArray(images)) return json(res, 400, { error: 'Capture needs an images array' });

      await mkdir(IMAGES, { recursive: true });
      const saved = [];

      // Rejections are reported rather than silently skipped: a capture that
      // saves zero images should say why, not just return a count of 0.
      const rejected = [];
      for (const img of images) {
        const raw = img?.name ?? '';
        const name = safeName(raw);
        if (!name) { rejected.push(`${raw}: unsafe filename`); continue; }
        // AliExpress and Temu serve AVIF to browsers that accept it. sharp
        // reads it (as heif) and the catalog build re-encodes anyway, so
        // convert on arrival rather than rejecting a perfectly good image.
        if (!/\.(jpe?g|png|webp|avif)$/i.test(name)) {
          rejected.push(`${name}: not a jpg/png/webp/avif`); continue;
        }
        if (typeof img.dataUrl !== 'string') {
          rejected.push(`${name}: dataUrl missing or not a string`); continue;
        }

        const comma = img.dataUrl.indexOf(',');
        if (comma < 0) { rejected.push(`${name}: malformed data URL`); continue; }

        const bytes = Buffer.from(img.dataUrl.slice(comma + 1), 'base64');
        if (!bytes.length) { rejected.push(`${name}: decoded to 0 bytes`); continue; }
        if (bytes.length > 8 * 1024 * 1024) {
          rejected.push(`${name}: ${(bytes.length / 1048576).toFixed(1)}MB exceeds 8MB`); continue;
        }

        let outName = name;
        let outBytes = bytes;

        if (/\.avif$/i.test(name)) {
          try {
            const sharp = (await import('sharp')).default;
            outBytes = await sharp(bytes).webp({ quality: 82 }).toBuffer();
            outName = name.replace(/\.avif$/i, '.webp');
          } catch (e) {
            rejected.push(`${name}: could not convert AVIF (${e.message.slice(0, 60)})`);
            continue;
          }
        }

        await writeFile(join(IMAGES, outName), outBytes);
        saved.push({ name: outName, bytes: outBytes.length, sourceUrl: img.sourceUrl ?? null });
      }

      if (rejected.length) {
        console.log(`  capture "${product.title?.slice(0, 40)}": rejected ${rejected.length} image(s)`);
        for (const r of rejected) console.log(`    - ${r}`);
      }

      // Staged separately so a capture can never overwrite the live catalog.
      const stagePath = join(DATA, 'captured.json');
      const stage = existsSync(stagePath)
        ? JSON.parse(await readFile(stagePath, 'utf8'))
        : { captured: [] };
      stage.captured.push({ ...product, images: saved, capturedAt: new Date().toISOString() });
      await writeFile(stagePath, JSON.stringify(stage, null, 2) + '\n');

      console.log(`  capture "${product.title?.slice(0, 40)}": saved ${saved.length} image(s)`);
      return json(res, 200, {
        ok: true, savedImages: saved.length, staged: stage.captured.length,
        rejected,
      });
    }

    // Supabase URL and PUBLISHABLE key, so a store owner can sign in from the
    // extension. Both are public and RLS-gated; the secret key is never here.
    if (path === '/api/supabase' && req.method === 'GET') {
      const envPath = join(ROOT, '.env');
      if (!existsSync(envPath)) return json(res, 200, { configured: false });
      const env = Object.fromEntries(
        (await readFile(envPath, 'utf8')).split('\n')
          .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
          .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
      );
      const url = env.VITE_SUPABASE_URL;
      const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;
      if (!url || !key) return json(res, 200, { configured: false });
      return json(res, 200, { configured: true, url, key });
    }

    // Pricing config, so the extension can convert as you browse.
    if (path === '/api/pricing' && req.method === 'GET') {
      const cfgPath = join(DATA, 'pricing.json');
      if (!existsSync(cfgPath)) return json(res, 200, { configured: false });
      return json(res, 200, { configured: true, ...JSON.parse(await readFile(cfgPath, 'utf8')) });
    }

    // ---------------------------------------------------------------- API
    if (path === '/api/data' && req.method === 'GET') {
      const products = JSON.parse(await readFile(join(DATA, 'products.json'), 'utf8'));
      const stores = JSON.parse(await readFile(join(DATA, 'stores.json'), 'utf8'));
      const images = existsSync(IMAGES)
        ? (await readdir(IMAGES)).filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f)).sort()
        : [];
      const capturedPath = join(DATA, 'captured.json');
      const captured = existsSync(capturedPath)
        ? JSON.parse(await readFile(capturedPath, 'utf8')).captured ?? []
        : [];
      const pricingPath = join(DATA, 'pricing.json');
      const pricing = existsSync(pricingPath)
        ? JSON.parse(await readFile(pricingPath, 'utf8')) : null;
      return json(res, 200, { products, stores, images, captured, pricing });
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

    if (path === '/api/captured' && req.method === 'DELETE') {
      const at = Number(url.searchParams.get('index'));
      const capturedPath = join(DATA, 'captured.json');
      if (!existsSync(capturedPath)) return json(res, 200, { ok: true });
      const stage = JSON.parse(await readFile(capturedPath, 'utf8'));
      if (Number.isInteger(at) && at >= 0 && at < (stage.captured?.length ?? 0)) {
        stage.captured.splice(at, 1);
        await writeFile(capturedPath, JSON.stringify(stage, null, 2) + '\n');
      }
      return json(res, 200, { ok: true, remaining: stage.captured?.length ?? 0 });
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

// A port clash otherwise kills the process with a bare stack trace, and the
// extension just reports "Failed to fetch" with no clue why.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error('  Another copy of this server may be running:');
    console.error(`    lsof -ti:${PORT} | xargs kill\n`);
  } else {
    console.error(`\n  Could not start: ${err.message}\n`);
  }
  process.exit(1);
});

// Loopback only. This process can write to the repo, so it must never be
// reachable from the network.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Product editor running at http://127.0.0.1:${PORT}/products.html`);
  console.log('  Writes to data/products.json and admin-offline/images/');
  console.log('  Local only — press Ctrl+C to stop.\n');
});
