/**
 * Builds the static catalog from data/*.json + admin-offline/images/.
 *
 * Output -> public/catalog/
 *   catalog.json        full catalog consumed by the storefront
 *   index.json          trimmed listing payload (no descriptions/specs)
 *   img/<sku>/<n>.webp  optimised images in three widths
 *
 * Validation is strict and fails the build: a bad catalog must never deploy.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_IMAGES = join(ROOT, 'admin-offline', 'images');
const OUT = join(ROOT, 'public', 'catalog');
const WIDTHS = [400, 800, 1200];

const errors = [];
const warnings = [];
const fail = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`\n  Cannot read ${p}\n  ${e.message}\n`);
    process.exit(1);
  }
}

const productsDoc = readJson(join(ROOT, 'data', 'products.json'));
const storesDoc = readJson(join(ROOT, 'data', 'stores.json'));

const stores = storesDoc.stores ?? [];
const products = productsDoc.products ?? [];
const currency = productsDoc.currency ?? 'MVR';
const storeSlugs = new Set(stores.map((s) => s.slug));

// ---------------------------------------------------------------- validation
const seenSku = new Set();

for (const [i, p] of products.entries()) {
  const at = p.sku ? `product "${p.sku}"` : `product #${i + 1}`;

  if (!p.sku) fail(`${at}: missing "sku"`);
  else if (!/^[A-Za-z0-9._-]+$/.test(p.sku)) fail(`${at}: sku has characters unsafe for a URL/path`);
  else if (seenSku.has(p.sku)) fail(`${at}: duplicate sku`);
  else seenSku.add(p.sku);

  if (!p.title?.trim()) fail(`${at}: missing "title"`);
  if (!p.storeSlug) fail(`${at}: missing "storeSlug"`);
  else if (!storeSlugs.has(p.storeSlug)) fail(`${at}: storeSlug "${p.storeSlug}" not in stores.json`);

  // Money is integer cents everywhere. Floats here cause rounding bugs later.
  if (!Number.isInteger(p.priceCents)) fail(`${at}: "priceCents" must be an integer (cents)`);
  else if (p.priceCents < 0) fail(`${at}: "priceCents" cannot be negative`);

  if (p.compareAtCents != null) {
    if (!Number.isInteger(p.compareAtCents)) fail(`${at}: "compareAtCents" must be an integer (cents)`);
    else if (p.compareAtCents <= p.priceCents)
      warn(`${at}: compareAtCents (${p.compareAtCents}) is not above priceCents — the "was" price will not show`);
  }

  if (!Number.isInteger(p.stockTotal)) fail(`${at}: "stockTotal" must be an integer`);
  else if (p.stockTotal < 0) fail(`${at}: "stockTotal" cannot be negative`);

  if (!Array.isArray(p.images) || p.images.length === 0) fail(`${at}: needs at least one image`);
  else {
    for (const img of p.images) {
      if (!existsSync(join(SRC_IMAGES, img))) fail(`${at}: image not found — admin-offline/images/${img}`);
    }
  }

  if (!p.description?.trim()) warn(`${at}: no description`);
}

if (errors.length) {
  console.error(`\n  Catalog build failed — ${errors.length} error(s):\n`);
  for (const e of errors) console.error(`   ✗ ${e}`);
  console.error('');
  process.exit(1);
}

// ------------------------------------------------------------------- images
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'img'), { recursive: true });

let sharp = null;
try {
  ({ default: sharp } = await import('sharp'));
} catch {
  warn('sharp unavailable — images copied without optimisation');
}

const imageManifest = {};
let totalBytes = 0;

for (const p of products) {
  const variants = [];
  for (const [idx, img] of p.images.entries()) {
    const src = join(SRC_IMAGES, img);
    const dir = join(OUT, 'img', p.sku);
    mkdirSync(dir, { recursive: true });

    if (sharp) {
      const meta = await sharp(src).metadata();
      const set = {};
      for (const w of WIDTHS) {
        if (meta.width && meta.width < w && w !== WIDTHS[0]) continue; // don't upscale
        const name = `${idx}-${w}.webp`;
        const info = await sharp(src)
          .resize(w, null, { withoutEnlargement: true })
          .webp({ quality: 78 })
          .toFile(join(dir, name));
        set[w] = { file: `${p.sku}/${name}`, bytes: info.size };
        totalBytes += info.size;
      }
      variants.push({ widths: set, alt: `${p.title} — image ${idx + 1}` });
    } else {
      const name = `${idx}${extname(img)}`;
      writeFileSync(join(dir, name), readFileSync(src));
      variants.push({ widths: { 800: { file: `${p.sku}/${name}` } }, alt: p.title });
    }
  }
  imageManifest[p.sku] = variants;
}

// ------------------------------------------------------------------ catalog
const buildId = new Date().toISOString();

const enriched = products.map((p) => ({
  ...p,
  images: imageManifest[p.sku],
  inStock: p.stockTotal > 0,
}));

const catalog = { buildId, currency, stores, products: enriched };

// Listing payload omits description/specs so the grid stays light.
const index = {
  buildId,
  currency,
  stores,
  products: enriched.map(({ sku, title, storeSlug, priceCents, compareAtCents, stockTotal, categories, images, inStock }) => ({
    sku, title, storeSlug, priceCents, compareAtCents, stockTotal, categories,
    inStock,
    thumb: images[0],
  })),
};

writeFileSync(join(OUT, 'catalog.json'), JSON.stringify(catalog));
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index));

// -------------------------------------------------------------------- report
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const catalogBytes = Buffer.byteLength(JSON.stringify(catalog));
const indexBytes = Buffer.byteLength(JSON.stringify(index));

console.log(`\n  Catalog built — ${products.length} products, ${stores.length} stores`);
console.log(`    index.json    ${kb(indexBytes)}   (loaded on every page)`);
console.log(`    catalog.json  ${kb(catalogBytes)}`);
console.log(`    images        ${kb(totalBytes)}`);

if (indexBytes > 150 * 1024) {
  console.log(`\n  Note: index.json is over 150 KB. Consider paginating the listing payload.`);
}
if (warnings.length) {
  console.log(`\n  ${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`   ! ${w}`);
}
console.log('');
