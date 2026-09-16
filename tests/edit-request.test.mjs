/**
 * Edit-request approval flow, attacked directly.
 *
 * The same functions run inside the admin editor (admin-offline/products.html
 * imports this module), so these tests assert the real guard rails, not a
 * copy: crafted payloads must never be silently honoured.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyEditRequest, buildEditDiff } from '../admin-offline/edit-request.js';

const fixture = () => ([
  {
    sku: 'EX-1', storeSlug: 'store-a', title: 'Widget',
    priceCents: 1000, stockTotal: 5, description: 'Old text', categories: [],
  },
  {
    sku: 'EX-2', storeSlug: 'store-b', title: 'Other thing',
    priceCents: 2000, stockTotal: 3, description: 'x',
  },
  {
    sku: 'EX-3', storeSlug: 'store-a', title: 'Variant thing',
    options: [{ name: 'Color', values: ['Red'] }],
    variants: [{ sku: 'EX-3-01', choices: { Color: 'Red' }, priceCents: 500, stockTotal: 2 }],
  },
]);

const own = { targetSku: 'EX-1', storeSlug: 'store-a' };

describe('edit-request approval', () => {
  test('applies only the fields being changed', () => {
    const products = fixture();
    const r = applyEditRequest(
      { ...own, payload: { kind: 'edit', priceCents: 1900, description: 'New text' } }, products);

    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(products[0].priceCents, 1900);
    assert.equal(products[0].description, 'New text');
    assert.equal(products[0].stockTotal, 5, 'untouched field changed');
    assert.equal(products[0].title, 'Widget');
    assert.deepEqual(Object.keys(r.changes).sort(), ['description', 'priceCents']);
  });

  test('a crafted title is not silently honoured', () => {
    const products = fixture();
    const r = applyEditRequest(
      { ...own, payload: { kind: 'edit', title: 'Hacked', priceCents: 1500 } }, products);

    assert.ok(r.ok, 'valid part still applies — the request is not wholesale refused');
    assert.equal(products[0].title, 'Widget', 'non-editable field was applied');
    assert.ok(r.ignored.includes('title'), 'non-editable key not reported');
  });

  test('extra junk keys are ignored and reported', () => {
    const products = fixture();
    const r = applyEditRequest(
      { ...own, payload: { kind: 'edit', hidden: true, sku: 'EX-9', storeSlug: 'store-b', images: [] } },
      products);

    assert.ok(r.ok);
    assert.equal(products[0].hidden, true);
    assert.equal(products[0].sku, 'EX-1');
    assert.deepEqual(r.ignored.sort(), ['images', 'sku', 'storeSlug']);
  });

  test('a target_sku from another store is refused', () => {
    const products = fixture();
    const r = applyEditRequest(
      { targetSku: 'EX-2', storeSlug: 'store-a', payload: { kind: 'edit', priceCents: 1 } },
      products);
    assert.equal(r.ok, false);
    assert.match(r.reason, /belongs to store-b/);
    assert.equal(products[1].priceCents, 2000, 'foreign product was modified');
  });

  test('an unknown target_sku is refused', () => {
    const r = applyEditRequest(
      { targetSku: 'NOPE', storeSlug: 'store-a', payload: { kind: 'edit', priceCents: 1 } },
      fixture());
    assert.equal(r.ok, false);
    assert.match(r.reason, /not in the catalog/);
  });

  test('variant products stay admin-only', () => {
    const products = fixture();
    const r = applyEditRequest(
      { targetSku: 'EX-3', storeSlug: 'store-a', payload: { kind: 'edit', priceCents: 1 } },
      products);
    assert.equal(r.ok, false);
    assert.match(r.reason, /variant/);
  });

  test('malformed values are refused', () => {
    const bad = [
      { priceCents: 19.5 },              // float — money is integer cents
      { priceCents: -100 },
      { stockTotal: 2.5 },
      { stockTotal: -1 },
      { hidden: 'yes' },
      { description: 42 },
    ];
    for (const patch of bad) {
      const products = fixture();
      const r = applyEditRequest({ ...own, payload: { kind: 'edit', ...patch } }, products);
      assert.equal(r.ok, false, `payload ${JSON.stringify(patch)} was accepted`);
      assert.equal(products[0].priceCents, 1000, 'refused request mutated the product');
    }
  });

  test('a request that changes nothing is refused', () => {
    const r = applyEditRequest(
      { ...own, payload: { kind: 'edit' } }, fixture());
    assert.equal(r.ok, false);
  });

  test('buildEditDiff lists only carried fields with from/to', () => {
    const products = fixture();
    const rows = buildEditDiff({ kind: 'edit', priceCents: 1900, title: 'ignored' }, products[0]);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { field: 'priceCents', from: 1000, to: 1900 });
  });
});
