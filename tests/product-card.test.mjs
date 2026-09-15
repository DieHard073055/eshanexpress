/**
 * "from X" price label.
 *
 * The label must appear only when a product's variants actually span a price
 * range. This is easy to get wrong because the two catalog payloads differ:
 * index.json omits priceFrom unless priceTo differs, but catalog.json always
 * carries both. A check of `priceFrom != null` alone therefore says "from" on
 * every variant product when fed from the full catalog — which is what the
 * store page (#/store/:slug) does, while the home page reads the index. The
 * same product then showed "MVR 925.00" on one page and "from MVR 925.00" on
 * the other.
 *
 * productCard itself cannot be imported under node:test — it pulls in
 * catalog.js, which reads Vite's import.meta.env at module load. The rule
 * lives in money.js so it stays testable.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { hasPriceRange } = await import('../src/lib/money.js');

describe('hasPriceRange', () => {
  test('index payload for a single-price product: no range', () => {
    // priceFrom/priceTo omitted entirely by the build.
    assert.equal(hasPriceRange({ priceCents: 100000 }), false);
  });

  test('catalog payload with equal bounds: no range', () => {
    // The regression. catalog.json emits both even when every variant is
    // the same price.
    assert.equal(hasPriceRange({ priceCents: 100000, priceFrom: 100000, priceTo: 100000 }), false);
  });

  test('a genuine spread is a range', () => {
    assert.equal(hasPriceRange({ priceFrom: 100000, priceTo: 250000 }), true);
  });

  test('both payload shapes agree for the same single-price product', () => {
    const fromIndex = hasPriceRange({ priceCents: 100000 });
    const fromCatalog = hasPriceRange({ priceCents: 100000, priceFrom: 100000, priceTo: 100000 });
    assert.equal(fromIndex, fromCatalog,
      'home page and store page must not disagree about the "from" label');
  });

  test('a half-populated payload is not treated as a range', () => {
    assert.equal(hasPriceRange({ priceFrom: 100000 }), false);
    assert.equal(hasPriceRange({ priceTo: 250000 }), false);
  });

  test('tolerates a missing product', () => {
    assert.equal(hasPriceRange(undefined), false);
    assert.equal(hasPriceRange(null), false);
  });
});
