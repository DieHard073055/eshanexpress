import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage stand-in so the cart module can run under node:test.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const cart = await import('../src/lib/cart.js');

const catalog = new Map([
  ['EX-1001', { sku: 'EX-1001', title: 'Earbuds', priceCents: 34900, stockTotal: 24 }],
  ['EX-2002', { sku: 'EX-2002', title: 'Bottle', priceCents: 12000, stockTotal: 0 }],
  ['EX-3001', { sku: 'EX-3001', title: 'Lamp', priceCents: 29900, stockTotal: 7 }],
  // Preorder: soft cap of 15, max 2 per order, 35-day lead time.
  ['EX-4001', { sku: 'EX-4001', title: 'Robot Vacuum', priceCents: 489000,
                stockTotal: 15, maxPerOrder: 2, leadTimeDays: 35 }],
]);

beforeEach(() => store.clear());

test('add then resolve computes line and subtotal', () => {
  cart.add('EX-1001', 2, 24);
  const { items, subtotalCents } = cart.resolve(catalog);
  assert.equal(items.length, 1);
  assert.equal(items[0].qty, 2);
  assert.equal(items[0].lineTotalCents, 69800);
  assert.equal(subtotalCents, 69800);
});

test('adding the same sku accumulates rather than duplicating', () => {
  cart.add('EX-1001', 1, 24);
  cart.add('EX-1001', 3, 24);
  const { items } = cart.resolve(catalog);
  assert.equal(items.length, 1);
  assert.equal(items[0].qty, 4);
});

test('add clamps to available stock', () => {
  cart.add('EX-3001', 99, 7);
  assert.equal(cart.resolve(catalog).items[0].qty, 7);
});

test('out-of-stock item resolves to qty 0 and is flagged clamped', () => {
  cart.add('EX-2002', 1, 1); // stock later drops to 0 in the catalog
  const { items } = cart.resolve(catalog);
  assert.equal(items[0].qty, 0);
  assert.equal(items[0].clamped, true);
  assert.equal(items[0].requestedQty, 1);
});

test('sku removed from catalog is reported stale, not silently dropped', () => {
  cart.add('EX-9999', 1);
  const { items, stale } = cart.resolve(catalog);
  assert.equal(items.length, 0);
  assert.deepEqual(stale, ['EX-9999']);
});

test('corrupt localStorage does not throw', () => {
  store.set('ex.cart.v1', '{not json');
  assert.deepEqual(cart.getLines(), []);
  assert.equal(cart.count(), 0);
});

test('malformed lines are filtered out', () => {
  store.set('ex.cart.v1', JSON.stringify([
    { sku: 'EX-1001', qty: 2 },
    { sku: 'EX-1001', qty: -5 },   // negative
    { sku: 'EX-3001', qty: 1.5 },  // fractional
    { qty: 3 },                    // no sku
    null,
  ]));
  const lines = cart.getLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].sku, 'EX-1001');
});

test('setQty below 1 removes the line', () => {
  cart.add('EX-1001', 3, 24);
  cart.setQty('EX-1001', 0);
  assert.equal(cart.getLines().length, 0);
});

test('count sums quantities across lines', () => {
  cart.add('EX-1001', 2, 24);
  cart.add('EX-3001', 3, 7);
  assert.equal(cart.count(), 5);
});

test('subscribers are notified on change', () => {
  let fired = 0;
  const off = cart.onCartChange(() => fired++);
  cart.add('EX-1001', 1, 24);
  cart.remove('EX-1001');
  off();
  cart.add('EX-1001', 1, 24);
  assert.equal(fired, 2); // not 3 — unsubscribed before the last
});

// --------------------------------------------------------------- preorder
test('preorder line carries lead time and per-order cap', () => {
  cart.add('EX-4001', 1, 15);
  const { items } = cart.resolve(catalog);
  assert.equal(items[0].leadTimeDays, 35);
  assert.equal(items[0].maxPerOrder, 2);
});

test('resolve clamps to maxPerOrder, not just stockTotal', () => {
  // 15 in stock but only 2 allowed per order.
  store.set('ex.cart.v1', JSON.stringify([{ sku: 'EX-4001', qty: 9 }]));
  const { items } = cart.resolve(catalog);
  assert.equal(items[0].qty, 2, 'per-order cap must win over stockTotal');
  assert.equal(items[0].clamped, true);
  assert.equal(items[0].requestedQty, 9);
});

test('maxPerOrder does not inflate a low stock count', () => {
  const low = new Map([['EX-5001',
    { sku: 'EX-5001', title: 'Rare', priceCents: 1000, stockTotal: 1, maxPerOrder: 5 }]]);
  store.set('ex.cart.v1', JSON.stringify([{ sku: 'EX-5001', qty: 5 }]));
  const { items } = cart.resolve(low);
  assert.equal(items[0].qty, 1, 'stockTotal must still cap the line');
});

test('non-preorder items report null lead time', () => {
  cart.add('EX-1001', 1, 24);
  const { items } = cart.resolve(catalog);
  assert.equal(items[0].leadTimeDays, null);
});

// ---------------------------------------------------------------- variants
test('a variant line carries its choices and parent sku', () => {
  const idx = new Map([['EX-5001-BLK-MIC', {
    sku: 'EX-5001-BLK-MIC', parentSku: 'EX-5001', title: 'KZ EDX Pro',
    priceCents: 11584, stockTotal: 709, choices: { Colour: 'Black', Mic: 'With mic' },
  }]]);
  store.set('ex.cart.v1', JSON.stringify([{ sku: 'EX-5001-BLK-MIC', qty: 2 }]));
  const { items, subtotalCents } = cart.resolve(idx);
  assert.equal(items[0].parentSku, 'EX-5001');
  assert.deepEqual(items[0].choices, { Colour: 'Black', Mic: 'With mic' });
  assert.equal(subtotalCents, 23168, 'variant price, not parent price');
});

test('a parent sku left in the cart is reported stale, not silently priced', () => {
  // Happens when a simple product later gains variants.
  const idx = new Map([['EX-5001-BLK-MIC', {
    sku: 'EX-5001-BLK-MIC', parentSku: 'EX-5001', title: 'KZ', priceCents: 11584, stockTotal: 709,
  }]]);
  store.set('ex.cart.v1', JSON.stringify([{ sku: 'EX-5001', qty: 1 }]));
  const { items, stale } = cart.resolve(idx);
  assert.equal(items.length, 0);
  assert.deepEqual(stale, ['EX-5001'], 'parent sku must never resolve to a price');
});
