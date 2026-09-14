/**
 * Importer mapping, tested against the real export's shape.
 * Values are synthetic; the structure mirrors a genuine marketplace export.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'eximport-'));

function run(doc, extra = []) {
  const f = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(doc));
  return execFileSync('node', ['scripts/import-export.mjs', f, ...extra], {
    encoding: 'utf8', cwd: process.cwd(),
  });
}

const exportDoc = (products, categories = []) => ({
  catalog: [{ categories }, { products }],
});

const product = (over = {}) => ({
  sku: '1005011634794671',
  name: 'Test Product',
  category_id: '930120',
  quantity: 3887,
  description: 'Description',
  manufacturer: '',
  product_url: 'https://example.com/item/1.html?spm=tracking',
  price: '100.00',
  combinations: [],
  ...over,
});

describe('marketplace import', () => {
  test('maps combinations to variants', () => {
    const out = run(exportDoc([product({
      combinations: [
        { sku: 'c1', quantity: 5, price: '100.00', features: [{ name: 'Color', value: 'Black' }] },
        { sku: 'c2', quantity: 8, price: '120.00', features: [{ name: 'Color', value: 'Cyan' }] },
      ],
    })]));
    assert.match(out, /1 catalog products, 2 variants/);
  });

  test('handles two option axes', () => {
    const out = run(exportDoc([product({
      combinations: [
        { sku: 'a', quantity: 1, price: '10', features: [{ name: 'Color', value: 'B' }, { name: 'Size', value: 'S' }] },
        { sku: 'b', quantity: 1, price: '20', features: [{ name: 'Color', value: 'B' }, { name: 'Size', value: 'L' }] },
      ],
    })]));
    assert.match(out, /2 variants/);
  });

  test('skips a combination missing an option axis', () => {
    const out = run(exportDoc([product({
      combinations: [
        { sku: 'a', quantity: 1, price: '10', features: [{ name: 'Color', value: 'B' }, { name: 'Size', value: 'S' }] },
        { sku: 'b', quantity: 1, price: '20', features: [{ name: 'Color', value: 'B' }] }, // no Size
      ],
    })]));
    assert.match(out, /skipped 1 combination/);
  });

  test('caps supplier stock rather than promising thousands', () => {
    const out = run(exportDoc([product({
      quantity: 69828,
      combinations: [{ sku: 'c', quantity: 9978, price: '50', features: [{ name: 'Color', value: 'X' }] }],
    })]), ['--cap', '20']);
    assert.match(out, /stock capped at 20 per variant/);
  });

  test('applies a markup to supplier prices', () => {
    const out = run(exportDoc([product({ price: '100.00' })]), ['--markup', '2']);
    assert.match(out, /prices ×2/);
    assert.match(out, /MVR 200\.00/);
  });

  test('reports products with no image, which cannot build', () => {
    const out = run(exportDoc([product()]));
    assert.match(out, /1 product\(s\) have no image/);
  });

  test('flags a keyword-stuffed title as needing a rewrite', () => {
    const out = run(exportDoc([product({
      name: '2026 New 32G Memory 800W 4K Camera Smart Glasses Men Photos and Videos 3600mAh Power Bank 120 Languages Translation AI',
    })]));
    assert.match(out, /title was cut/);
  });

  test('a short title is left alone', () => {
    const out = run(exportDoc([product({ name: 'KZ EDX Pro Earphones' })]));
    assert.doesNotMatch(out, /title was cut/);
  });

  test('never writes without --write', () => {
    const out = run(exportDoc([product()]));
    assert.match(out, /Preview only/);
  });

  test('rejects a file with no products', () => {
    assert.throws(() => run({ catalog: [{ categories: [] }] }));
  });

  test('rejects an unknown store', () => {
    assert.throws(() => run(exportDoc([product()]), ['--store', 'no-such-store']));
  });
});
