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
// Defaults serve the real repo; the env overrides exist so tests can build a
// fixture catalog in a temp dir without touching the real data or output.
const SRC_IMAGES = process.env.CATALOG_IMAGES_DIR ?? join(ROOT, 'admin-offline', 'images');
const DATA_DIR = process.env.CATALOG_DATA_DIR ?? join(ROOT, 'data');
const OUT = process.env.CATALOG_OUT_DIR ?? join(ROOT, 'public', 'catalog');
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

const productsDoc = readJson(join(DATA_DIR, 'products.json'));
const storesDoc = readJson(join(DATA_DIR, 'stores.json'));

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
  const variantsDeclared = Array.isArray(p.variants) && p.variants.length > 0;

  if (!variantsDeclared) {
    if (!Number.isInteger(p.priceCents)) fail(`${at}: "priceCents" must be an integer (cents)`);
    else if (p.priceCents < 0) fail(`${at}: "priceCents" cannot be negative`);
  }

  if (p.compareAtCents != null) {
    if (!Number.isInteger(p.compareAtCents)) fail(`${at}: "compareAtCents" must be an integer (cents)`);
    else if (p.compareAtCents <= p.priceCents)
      warn(`${at}: compareAtCents (${p.compareAtCents}) is not above priceCents — the "was" price will not show`);
  }

  // Variant products carry price and stock on each variant instead.
  const hasVariants = Array.isArray(p.variants) && p.variants.length > 0;

  if (!hasVariants) {
    if (!Number.isInteger(p.stockTotal)) fail(`${at}: "stockTotal" must be an integer`);
    else if (p.stockTotal < 0) fail(`${at}: "stockTotal" cannot be negative`);
  }

  // Preorder items: a soft cap you are willing to order from overseas.
  if (p.leadTimeDays != null) {
    if (!Number.isInteger(p.leadTimeDays) || p.leadTimeDays <= 0)
      fail(`${at}: "leadTimeDays" must be a positive integer`);
    else if (p.leadTimeDays < 7)
      warn(`${at}: leadTimeDays is only ${p.leadTimeDays} — preorder messaging may confuse buyers`);
    if (p.stockTotal === 0)
      warn(`${at}: preorder item has stockTotal 0, so it shows as sold out`);
  }

  if (p.maxPerOrder != null) {
    if (!Number.isInteger(p.maxPerOrder) || p.maxPerOrder <= 0)
      fail(`${at}: "maxPerOrder" must be a positive integer`);
    else if (p.maxPerOrder > p.stockTotal && p.stockTotal > 0)
      warn(`${at}: maxPerOrder (${p.maxPerOrder}) exceeds stockTotal (${p.stockTotal})`);
  }

  // ---------------------------------------------------------- variants
  if (p.options != null || variantsDeclared) {
    if (!Array.isArray(p.options) || p.options.length === 0) {
      fail(`${at}: has variants but no "options" describing the pickers`);
    }
    if (!variantsDeclared) {
      fail(`${at}: has options but no "variants"`);
    }

    const optionNames = (p.options ?? []).map((o) => o?.name).filter(Boolean);
    if (optionNames.length !== new Set(optionNames).size) {
      fail(`${at}: duplicate option name`);
    }
    for (const o of p.options ?? []) {
      if (!o?.name) fail(`${at}: an option is missing "name"`);
      if (!Array.isArray(o?.values) || o.values.length === 0) {
        fail(`${at}: option "${o?.name}" has no values`);
      }
    }

    const seenCombo = new Set();
    for (const [vi, v] of (p.variants ?? []).entries()) {
      const vat = `${at} variant ${v?.sku ?? `#${vi + 1}`}`;

      if (!v?.sku) fail(`${vat}: missing "sku"`);
      else if (!/^[A-Za-z0-9._-]+$/.test(v.sku)) fail(`${vat}: sku unsafe for a URL/path`);
      else if (seenSku.has(v.sku)) fail(`${vat}: duplicate sku`);
      else seenSku.add(v.sku);   // variants share the product SKU namespace

      if (!Number.isInteger(v?.priceCents)) fail(`${vat}: "priceCents" must be an integer (cents)`);
      else if (v.priceCents < 0) fail(`${vat}: "priceCents" cannot be negative`);

      if (!Number.isInteger(v?.stockTotal)) fail(`${vat}: "stockTotal" must be an integer`);
      else if (v.stockTotal < 0) fail(`${vat}: "stockTotal" cannot be negative`);

      // Choices must cover exactly the declared options — a missing or extra
      // key means the picker cannot resolve a selection to a variant.
      const choiceKeys = Object.keys(v?.choices ?? {});
      const missing = optionNames.filter((n) => !choiceKeys.includes(n));
      const extra = choiceKeys.filter((n) => !optionNames.includes(n));
      if (missing.length) fail(`${vat}: missing choice for ${missing.join(', ')}`);
      if (extra.length) fail(`${vat}: has choice "${extra.join(', ')}" which is not a declared option`);

      for (const o of p.options ?? []) {
        const chosen = v?.choices?.[o.name];
        if (chosen != null && !o.values.includes(chosen)) {
          fail(`${vat}: "${chosen}" is not a listed value for ${o.name}`);
        }
      }

      const key = optionNames.map((n) => v?.choices?.[n]).join('\x00');
      if (seenCombo.has(key)) fail(`${vat}: another variant has the same combination`);
      seenCombo.add(key);

      if (v?.image && !existsSync(join(SRC_IMAGES, v.image))) {
        fail(`${vat}: image not found — admin-offline/images/${v.image}`);
      }
    }
  }

  if (!Array.isArray(p.images) || p.images.length === 0) fail(`${at}: needs at least one image`);
  else {
    for (const img of p.images) {
      if (!existsSync(join(SRC_IMAGES, img))) fail(`${at}: image not found — admin-offline/images/${img}`);
    }
  }

  if (!p.description?.trim()) warn(`${at}: no description`);

  // Hidden products are omitted from everything shipped (catalog, index,
  // stock manifest) — see `visible` below. Only the shape is validated here.
  if (p.hidden != null && typeof p.hidden !== 'boolean') {
    fail(`${at}: "hidden" must be a boolean`);
  }
}

if (errors.length) {
  console.error(`\n  Catalog build failed — ${errors.length} error(s):\n`);
  for (const e of errors) console.error(`   ✗ ${e}`);
  console.error('');
  process.exit(1);
}

// Hidden means fully unorderable: the product is absent from the shipped
// catalog, so listings, direct links ("Product not found"), checkout and
// stock sync all treat it as gone. sync-stock then drops its stock rows,
// keeping any SKU that still has live reservations.
const visible = products.filter((p) => !p.hidden);

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

for (const p of visible) {
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

  // Variant swatch images, keyed separately so they do not appear in the
  // product's own gallery.
  for (const v of p.variants ?? []) {
    if (!v.image) continue;
    const src = join(SRC_IMAGES, v.image);
    const dir = join(OUT, 'img', p.sku);
    mkdirSync(dir, { recursive: true });

    if (sharp) {
      const set = {};
      for (const w of WIDTHS) {
        const name = `v-${v.sku}-${w}.webp`;
        const info = await sharp(src)
          .resize(w, null, { withoutEnlargement: true })
          .webp({ quality: 78 })
          .toFile(join(dir, name));
        set[w] = { file: `${p.sku}/${name}`, bytes: info.size };
        totalBytes += info.size;
      }
      imageManifest[`${p.sku}::${v.sku}`] = [{ widths: set, alt: `${p.title} — ${Object.values(v.choices ?? {}).join(', ')}` }];
    } else {
      const name = `v-${v.sku}${extname(v.image)}`;
      writeFileSync(join(dir, name), readFileSync(src));
      imageManifest[`${p.sku}::${v.sku}`] = [{ widths: { 800: { file: `${p.sku}/${name}` } }, alt: p.title }];
    }
  }
}

// --------------------------------------------- store decoration (release §2)
// Owners edit banner/logo/blurb on their store row in Supabase; the storefront
// reads the baked catalog, so the build merges decoration in when credentials
// are present. Without them (every local `npm run catalog`) the file alone is
// used and the build still succeeds.
async function emitStoreImage(buf, slug, kind, alt) {
  const dir = join(OUT, 'img', 'stores', slug);
  mkdirSync(dir, { recursive: true });

  if (sharp) {
    const meta = await sharp(buf).metadata();
    const set = {};
    for (const w of WIDTHS) {
      if (meta.width && meta.width < w && w !== WIDTHS[0]) continue; // don't upscale
      const name = `${kind}-${w}.webp`;
      const info = await sharp(buf)
        .resize(w, null, { withoutEnlargement: true })
        .webp({ quality: 78 })
        .toFile(join(dir, name));
      set[w] = { file: `stores/${slug}/${name}`, bytes: info.size };
      totalBytes += info.size;
    }
    return { widths: set, alt };
  }

  const name = `${kind}.bin`;
  writeFileSync(join(dir, name), buf);
  return { widths: { 800: { file: `stores/${slug}/${name}` } }, alt };
}

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_SECRET = process.env.SUPABASE_SECRET_KEY;

if (SUPA_URL && SUPA_SECRET) {
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/stores?select=slug,banner_path,logo_path,blurb`, {
      headers: { apikey: SUPA_SECRET, Authorization: `Bearer ${SUPA_SECRET}` },
    });
    if (!res.ok) throw new Error(`stores fetch returned HTTP ${res.status}`);
    const rows = await res.json();

    for (const row of rows) {
      const store = stores.find((s) => s.slug === row.slug);
      if (!store) continue; // a store row without a catalog entry is not ours to judge
      if (row.blurb != null) store.blurb = row.blurb;

      for (const kind of ['banner', 'logo']) {
        const path = row[`${kind}_path`];
        if (!path) continue; // no decoration yet is not an error

        // banner_path is owner-writable, so it is untrusted input even though
        // the portal only ever writes "{store_id}/{kind}.webp". encodeURI does
        // NOT escape "../", so an owner who PATCHed a traversal path directly
        // over REST could otherwise point this fetch outside the bucket — and
        // it runs with the secret key. Accept only the shape the portal writes.
        if (!/^[0-9a-f-]{36}\/(banner|logo)\.(webp|jpe?g|png)$/i.test(path)) {
          warn(`store "${store.slug}": ignoring unexpected ${kind}_path "${path}"`);
          continue;
        }

        try {
          const img = await fetch(
            `${SUPA_URL}/storage/v1/object/public/store-assets/${encodeURI(path)}`,
          );
          if (!img.ok) throw new Error(`HTTP ${img.status}`);
          const buf = Buffer.from(await img.arrayBuffer());
          store[kind] = await emitStoreImage(buf, store.slug, kind, `${store.name} ${kind}`);
        } catch (e) {
          // A broken banner must not block a deploy that also carries product changes.
          warn(`store "${store.slug}": could not bake ${kind} (${e.message})`);
        }
      }
    }
  } catch (e) {
    warn(`store decoration not merged: ${e.message} — using stores.json alone`);
  }
} else {
  warn('SUPABASE_URL/SUPABASE_SECRET_KEY not set — store decoration not merged (stores.json alone)');
}

// ------------------------------------------------------------------ catalog
const buildId = new Date().toISOString();

const enriched = visible.map((p) => {
  const variants = Array.isArray(p.variants) && p.variants.length ? p.variants : null;

  if (!variants) {
    return { ...p, images: imageManifest[p.sku], inStock: p.stockTotal > 0 };
  }

  // Derive once here so no page has to reduce over variants at render time.
  const sellable = variants.filter((v) => v.stockTotal > 0);
  const pricePool = (sellable.length ? sellable : variants).map((v) => v.priceCents);
  const stockTotal = variants.reduce((n, v) => n + v.stockTotal, 0);

  return {
    ...p,
    images: imageManifest[p.sku],
    variants: variants.map((v) => ({
      ...v,
      // Variant images resolve through the same optimised manifest.
      image: v.image ? (imageManifest[`${p.sku}::${v.sku}`]?.[0] ?? null) : null,
    })),
    priceFrom: Math.min(...pricePool),
    priceTo: Math.max(...pricePool),
    priceCents: Math.min(...pricePool),  // cards and sorting use this
    stockTotal,
    inStock: stockTotal > 0,
  };
});

const catalog = { buildId, currency, stores, products: enriched };

// Listing payload omits description/specs so the grid stays light.
const index = {
  buildId,
  currency,
  stores,
  products: enriched.map(({ sku, title, storeSlug, priceCents, compareAtCents, stockTotal,
                            categories, images, inStock, leadTimeDays, maxPerOrder,
                            priceFrom, priceTo }) => ({
    sku, title, storeSlug, priceCents, compareAtCents, stockTotal, categories,
    inStock, leadTimeDays, maxPerOrder,
    // Present only for variant products; the card shows "from X" when the
    // range is wider than a single price.
    ...(priceFrom != null && priceTo !== priceFrom ? { priceFrom, priceTo } : {}),
    thumb: images[0],
  })),
};

writeFileSync(join(OUT, 'catalog.json'), JSON.stringify(catalog));
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index));

// Stock manifest consumed by scripts/sync-stock.mjs at deploy time. The
// database — not the client — is the authority on inventory at checkout.
// One row per orderable SKU. For a variant product that means the variants,
// never the parent — the parent is not orderable and must not hold stock.
const stockRows = [];
for (const p of visible) {
  if (Array.isArray(p.variants) && p.variants.length) {
    for (const v of p.variants) {
      stockRows.push({
        sku: v.sku, total: v.stockTotal,
        leadTimeDays: p.leadTimeDays ?? null, maxPerOrder: p.maxPerOrder ?? null,
      });
    }
  } else {
    stockRows.push({
      sku: p.sku, total: p.stockTotal,
      leadTimeDays: p.leadTimeDays ?? null, maxPerOrder: p.maxPerOrder ?? null,
    });
  }
}
writeFileSync(join(OUT, '..', 'stock-manifest.json'), JSON.stringify(stockRows, null, 2));

// -------------------------------------------------------------------- report
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const catalogBytes = Buffer.byteLength(JSON.stringify(catalog));
const indexBytes = Buffer.byteLength(JSON.stringify(index));

console.log(`\n  Catalog built — ${visible.length} products (${products.length - visible.length} hidden), ${stores.length} stores`);
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
