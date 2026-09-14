import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasVariants, findVariant, defaultChoices, valueState, reconcile, describeChoices,
} from '../src/lib/variants.js';

const product = {
  sku: 'EX-5001',
  options: [
    { name: 'Colour', values: ['Black', 'Cyan'] },
    { name: 'Mic', values: ['With mic', 'No mic'] },
  ],
  variants: [
    { sku: 'A', choices: { Colour: 'Black', Mic: 'With mic' }, priceCents: 11584, stockTotal: 709 },
    { sku: 'B', choices: { Colour: 'Black', Mic: 'No mic' },   priceCents: 10745, stockTotal: 1102 },
    { sku: 'C', choices: { Colour: 'Cyan',  Mic: 'With mic' }, priceCents: 11584, stockTotal: 1127 },
    { sku: 'D', choices: { Colour: 'Cyan',  Mic: 'No mic' },   priceCents: 10745, stockTotal: 0 },
  ],
};

const simple = { sku: 'EX-1001', priceCents: 34900, stockTotal: 24 };

test('detects variant vs simple products', () => {
  assert.equal(hasVariants(product), true);
  assert.equal(hasVariants(simple), false);
});

test('finds a variant regardless of choice key order', () => {
  assert.equal(findVariant(product, { Mic: 'No mic', Colour: 'Black' })?.sku, 'B');
});

test('returns null for a combination that does not exist', () => {
  assert.equal(findVariant(product, { Colour: 'Purple', Mic: 'No mic' }), null);
});

test('default selection is the cheapest IN-STOCK variant', () => {
  // D is equally cheap but sold out, so B must win.
  assert.equal(findVariant(product, defaultChoices(product))?.sku, 'B');
});

test('default falls back when everything is sold out', () => {
  const dead = { ...product, variants: product.variants.map((v) => ({ ...v, stockTotal: 0 })) };
  assert.ok(findVariant(dead, defaultChoices(dead)));
});

test('a sold-out value is reported as existing but out of stock', () => {
  const s = valueState(product, 'Mic', 'No mic', { Colour: 'Cyan' });
  assert.equal(s.exists, true, 'Cyan/No mic exists as a variant');
  assert.equal(s.inStock, false, 'but has zero stock');
});

test('an in-stock value reports both true', () => {
  const s = valueState(product, 'Mic', 'With mic', { Colour: 'Cyan' });
  assert.deepEqual(s, { exists: true, inStock: true });
});

test('a value with no variant at all is reported as not existing', () => {
  const partial = {
    options: [{ name: 'Size', values: ['S', 'M', 'L'] }],
    variants: [
      { sku: 'S1', choices: { Size: 'S' }, priceCents: 100, stockTotal: 5 },
      { sku: 'M1', choices: { Size: 'M' }, priceCents: 100, stockTotal: 5 },
    ],
  };
  assert.equal(valueState(partial, 'Size', 'L', {}).exists, false);
});

test('reconcile keeps a valid selection untouched', () => {
  const choices = { Colour: 'Cyan', Mic: 'With mic' };
  assert.deepEqual(reconcile(product, choices, 'Colour'), choices);
});

test('reconcile repairs a selection that became impossible', () => {
  const partial = {
    options: [
      { name: 'Colour', values: ['Black', 'Red'] },
      { name: 'Size', values: ['S', 'XL'] },
    ],
    variants: [
      { sku: 'A', choices: { Colour: 'Black', Size: 'S' },  priceCents: 100, stockTotal: 1 },
      { sku: 'B', choices: { Colour: 'Red',   Size: 'XL' }, priceCents: 100, stockTotal: 1 },
    ],
  };
  // Black/S is valid; switching to Red leaves Red/S, which does not exist.
  const out = reconcile(partial, { Colour: 'Red', Size: 'S' }, 'Colour');
  assert.ok(findVariant(partial, out), 'must land on a real variant');
  assert.equal(out.Colour, 'Red', 'the changed option must be respected');
  assert.equal(out.Size, 'XL');
});

test('reconcile always lands on a real variant', () => {
  for (const colour of ['Black', 'Cyan']) {
    for (const mic of ['With mic', 'No mic']) {
      const out = reconcile(product, { Colour: colour, Mic: mic }, 'Colour');
      assert.ok(findVariant(product, out), `${colour}/${mic} should resolve`);
    }
  }
});

test('describeChoices reads as a label', () => {
  assert.equal(describeChoices({ Colour: 'Black', Mic: 'With mic' }), 'Black · With mic');
});
