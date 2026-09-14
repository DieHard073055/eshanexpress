import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchScore, mapImagesToVariants, describeMapping } from '../src/lib/image-match.js';

const variants = (combos) => combos.map((choices, i) => ({
  sku: `V-${i + 1}`, choices,
}));

// ------------------------------------------------------------------ scoring
test('an exact match scores highest', () => {
  assert.equal(matchScore('Black', 'Black'), 100);
});

test('case and punctuation differences still match strongly', () => {
  assert.ok(matchScore('black', 'Black') >= 90);
  assert.ok(matchScore('EDX-pro cyan', 'EDX pro cyan') >= 90);
});

test('a supplier prefix matches the full option value', () => {
  // The swatch says "Black"; the option is "Black Blue Light A".
  assert.ok(matchScore('Black', 'Black Blue Light A') >= 70);
});

test('unrelated values do not match', () => {
  assert.equal(matchScore('Black', 'Cyan'), 0);
  assert.equal(matchScore('SK-40A', 'SK-200A') < 50, true);
});

test('empty input scores zero rather than matching everything', () => {
  assert.equal(matchScore('', 'Black'), 0);
  assert.equal(matchScore('Black', ''), 0);
  assert.equal(matchScore(null, undefined), 0);
});

// ------------------------------------------------------------------ mapping
test('a swatch maps to every variant sharing its colour', () => {
  // Black covers Black/1m, Black/2m and Black/3m.
  const vs = variants([
    { Colour: 'Black', Length: '1m' },
    { Colour: 'Black', Length: '2m' },
    { Colour: 'Cyan', Length: '1m' },
  ]);
  const r = mapImagesToVariants(
    [{ name: 'black.jpg', variantValue: 'Black' }], vs);

  assert.equal(r.assignments.get('V-1'), 'black.jpg');
  assert.equal(r.assignments.get('V-2'), 'black.jpg');
  assert.equal(r.assignments.has('V-3'), false, 'must not map Black onto Cyan');
});

test('gallery images become product images, not variant guesses', () => {
  const vs = variants([{ Colour: 'Black' }, { Colour: 'Cyan' }]);
  const r = mapImagesToVariants([
    { name: 'swatch-black.jpg', variantValue: 'Black' },
    { name: 'lifestyle-1.jpg', variantValue: null },
    { name: 'lifestyle-2.jpg', variantValue: '' },
  ], vs);

  assert.equal(r.assignments.get('V-1'), 'swatch-black.jpg');
  assert.deepEqual(r.productImages, ['lifestyle-1.jpg', 'lifestyle-2.jpg']);
});

test('each colour gets its own image', () => {
  const vs = variants([{ Colour: 'Black' }, { Colour: 'Cyan' }, { Colour: 'Pink' }]);
  const r = mapImagesToVariants([
    { name: 'b.jpg', variantValue: 'Black' },
    { name: 'c.jpg', variantValue: 'Cyan' },
    { name: 'p.jpg', variantValue: 'Pink' },
  ], vs);
  assert.equal(r.assignments.get('V-1'), 'b.jpg');
  assert.equal(r.assignments.get('V-2'), 'c.jpg');
  assert.equal(r.assignments.get('V-3'), 'p.jpg');
  assert.equal(r.uncertain.length, 0, 'exact matches need no review');
});

test('a loose match is flagged rather than applied silently', () => {
  const vs = variants([{ Colour: 'Black Blue Light A' }]);
  const r = mapImagesToVariants(
    [{ name: 'black.jpg', variantValue: 'Black' }], vs);

  assert.equal(r.assignments.get('V-1'), 'black.jpg', 'still mapped');
  assert.equal(r.uncertain.length, 1, 'but reported for review');
  assert.equal(r.uncertain[0].matchedValue, 'Black Blue Light A');
});

test('a swatch matching nothing is kept as a product image', () => {
  const vs = variants([{ Colour: 'Black' }]);
  const r = mapImagesToVariants(
    [{ name: 'mystery.jpg', variantValue: 'Rose Gold Deluxe' }], vs);

  assert.equal(r.assignments.size, 0);
  assert.equal(r.unmatched.length, 1);
  assert.ok(r.productImages.includes('mystery.jpg'), 'not discarded');
});

test('the first swatch wins when two match the same variant', () => {
  const vs = variants([{ Colour: 'Black' }]);
  const r = mapImagesToVariants([
    { name: 'first.jpg', variantValue: 'Black' },
    { name: 'second.jpg', variantValue: 'black' },
  ], vs);
  assert.equal(r.assignments.get('V-1'), 'first.jpg');
});

test('handles a real two-axis product', () => {
  // 2 colours x 3 lengths, with one swatch per colour.
  const vs = variants([
    { Colour: 'Black', Length: '1m' }, { Colour: 'Black', Length: '2m' },
    { Colour: 'Black', Length: '3m' }, { Colour: 'Cyan', Length: '1m' },
    { Colour: 'Cyan', Length: '2m' }, { Colour: 'Cyan', Length: '3m' },
  ]);
  const r = mapImagesToVariants([
    { name: 'black.jpg', variantValue: 'Black' },
    { name: 'cyan.jpg', variantValue: 'Cyan' },
    { name: 'box.jpg', variantValue: null },
  ], vs);

  assert.equal(r.assignments.size, 6, 'every variant should get an image');
  for (const sku of ['V-1', 'V-2', 'V-3']) assert.equal(r.assignments.get(sku), 'black.jpg');
  for (const sku of ['V-4', 'V-5', 'V-6']) assert.equal(r.assignments.get(sku), 'cyan.jpg');
  assert.deepEqual(r.productImages, ['box.jpg']);
});

test('no images yields no assignments rather than throwing', () => {
  const r = mapImagesToVariants([], variants([{ Colour: 'Black' }]));
  assert.equal(r.assignments.size, 0);
  assert.deepEqual(r.productImages, []);
});

test('describeMapping states what happened', () => {
  const vs = variants([{ Colour: 'Black' }, { Colour: 'Cyan' }]);
  const r = mapImagesToVariants([
    { name: 'b.jpg', variantValue: 'Black' },
    { name: 'g.jpg', variantValue: null },
  ], vs);
  const s = describeMapping(r, 2);
  assert.match(s, /1 of 2 variant/);
  assert.match(s, /1 product image/);
});
