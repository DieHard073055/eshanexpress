/**
 * Hidden products are fully unorderable: the build must omit them from
 * catalog.json, index.json AND the stock manifest, so sync-stock later drops
 * their stock rows (keeping any SKU with live reservations).
 *
 * Builds a fixture catalog in a temp dir via the build script's env
 * overrides — the real data/products.json is never touched.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let tmp;
let out;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'eshan-hidden-'));
  const data = join(tmp, 'data');
  const imgs = join(tmp, 'images');
  out = join(tmp, 'out', 'catalog');
  mkdirSync(data);
  mkdirSync(imgs);
  mkdirSync(out, { recursive: true });

  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .jpeg()
    .toFile(join(imgs, 'a.jpg'));

  writeFileSync(join(data, 'stores.json'), JSON.stringify({ stores: [{ slug: 's', name: 'S' }] }));
  writeFileSync(join(data, 'products.json'), JSON.stringify({
    currency: 'MVR',
    products: [
      { sku: 'VIS-1', title: 'Visible', storeSlug: 's', priceCents: 100, stockTotal: 2,
        images: ['a.jpg'], description: 'x' },
      { sku: 'HID-1', title: 'Hidden', storeSlug: 's', priceCents: 200, stockTotal: 4,
        images: ['a.jpg'], description: 'y', hidden: true },
      // A hidden VARIANT product: the parent and every variant SKU must go.
      { sku: 'HID-2', title: 'Hidden variant', storeSlug: 's', hidden: true,
        images: ['a.jpg'], description: 'z',
        options: [{ name: 'Color', values: ['Red'] }],
        variants: [{ sku: 'HID-2-01', choices: { Color: 'Red' }, priceCents: 300, stockTotal: 1 }] },
    ],
  }));

  execFileSync('node', [join(ROOT, 'scripts', 'build-catalog.mjs')], {
    env: {
      ...process.env,
      CATALOG_DATA_DIR: data,
      CATALOG_IMAGES_DIR: imgs,
      CATALOG_OUT_DIR: out,
    },
    stdio: 'pipe',
  });

});

after(() => rmSync(tmp, { recursive: true, force: true }));

describe('hidden products', () => {
  test('are absent from index.json and catalog.json', () => {
    const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
    const catalog = JSON.parse(readFileSync(join(out, 'catalog.json'), 'utf8'));

    for (const payload of [index, catalog]) {
      const skus = payload.products.map((p) => p.sku);
      assert.ok(skus.includes('VIS-1'), 'visible product missing');
      assert.ok(!skus.includes('HID-1'), 'hidden product shipped in the catalog');
      assert.ok(!skus.includes('HID-2'), 'hidden variant product shipped in the catalog');
    }
  });

  test('are absent from the stock manifest, including variant SKUs', () => {
    const manifest = JSON.parse(readFileSync(join(out, '..', 'stock-manifest.json'), 'utf8'));
    const skus = manifest.map((r) => r.sku);
    assert.deepEqual(skus, ['VIS-1']);
  });

  test('a hidden product still validates like any other', () => {
    // The build above succeeded with a hidden product present — a malformed
    // hidden flag would have failed it. Assert the boolean guard directly.
    const data = join(tmp, 'data');
    const products = JSON.parse(readFileSync(join(data, 'products.json'), 'utf8'));
    products.products[0].hidden = 'yes';
    writeFileSync(join(data, 'products.json'), JSON.stringify(products));

    assert.throws(
      () => execFileSync('node', [join(ROOT, 'scripts', 'build-catalog.mjs')], {
        env: {
          ...process.env,
          CATALOG_DATA_DIR: data,
          CATALOG_IMAGES_DIR: join(tmp, 'images'),
          CATALOG_OUT_DIR: join(tmp, 'out', 'catalog'),
        },
        stdio: 'pipe',
      }),
      /"hidden" must be a boolean/,
      'a non-boolean hidden flag must fail the build',
    );
  });
});
