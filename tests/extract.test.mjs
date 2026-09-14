/**
 * Extension extractor, run against REAL saved pages in docs/samples/.
 *
 * Caveat both pages share: they are client-rendered, so a saved file contains
 * far less than a live tab. AliExpress still ships its SKU markup, which is
 * why the option/swatch assertions below are meaningful. Temu ships almost
 * nothing, so it is tested for "degrades safely", not for extraction.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const SAMPLES = 'docs/samples';
const have = existsSync(`${SAMPLES}/laser_distance.html`);

let JSDOM;
before(async () => {
  if (!have) return;
  try { ({ JSDOM } = await import('jsdom')); } catch { JSDOM = null; }
});

function run(file, url) {
  const dom = new JSDOM(readFileSync(`${SAMPLES}/${file}`, 'utf8'), { url });
  const g = globalThis;
  const prevDoc = g.document;
  const prevLoc = g.location;
  g.document = dom.window.document;
  // location is read-only in node; define it for the duration.
  Object.defineProperty(g, 'location', { value: dom.window.location, configurable: true });
  try {
    // eslint-disable-next-line no-eval
    return eval(readFileSync('extension/extract.js', 'utf8'));
  } finally {
    g.document = prevDoc;
    Object.defineProperty(g, 'location', { value: prevLoc, configurable: true });
  }
}

describe('extractor against real pages', { skip: have ? false : 'samples missing' }, () => {
  test('AliExpress: title is the product, not the site name', function () {
    if (!JSDOM) return; // jsdom is a dev-only convenience
    const r = run('laser_distance.html', 'https://www.aliexpress.com/item/1.html');
    assert.match(r.title, /Snakol Laser Distance Meter/);
    assert.notEqual(r.title, 'Aliexpress', 'the site-name h1 must not win');
  });

  test('AliExpress: takes the CURRENT price, not the struck-through one', function () {
    if (!JSDOM) return;
    const r = run('laser_distance.html', 'https://www.aliexpress.com/item/1.html');
    // Page reads "Rf163.30 New shoppers save Rf157.14 Rf320.44".
    assert.equal(r.priceNumber, 163.3);
    assert.equal(r.priceCurrency, 'Rf');
  });

  test('AliExpress: extracts every colour option', function () {
    if (!JSDOM) return;
    const r = run('laser_distance.html', 'https://www.aliexpress.com/item/1.html');
    assert.equal(r.options.length, 1);
    assert.equal(r.options[0].name, 'Color');
    assert.equal(r.options[0].values.length, 7);
    // Matches the JSON export for the same product.
    for (const v of ['SK-40A', 'SK-50A', 'SK-200A']) {
      assert.ok(r.options[0].values.includes(v), `missing ${v}`);
    }
  });

  test('AliExpress: every swatch image carries its option value', function () {
    if (!JSDOM) return;
    const r = run('laser_distance.html', 'https://www.aliexpress.com/item/1.html');
    assert.equal(r.swatches.length, 7, 'one image per colour');
    for (const s of r.swatches) {
      assert.ok(s.value, 'a swatch with no value cannot be mapped to a variant');
      assert.ok(r.options[0].values.includes(s.value), `unknown value ${s.value}`);
    }
  });

  test('Temu: degrades safely rather than throwing', function () {
    if (!JSDOM) return;
    // This page is almost entirely client-rendered; the point is no crash.
    const r = run('screen_protector.html', 'https://www.temu.com/x.html');
    assert.ok(r.title.length > 10);
    assert.deepEqual(r.options, []);
  });

  test('Temu: cart UI and seller badges are not mistaken for options', function () {
    if (!JSDOM) return;
    // A loose fallback matched "Subtotal / Free shipping / Select all" and a
    // seller badge row as product options. A wrong option becomes a real
    // variant in the catalog, so no options must beat bad ones.
    const r = run('screen_protector.html', 'https://www.temu.com/x.html');
    const flat = r.options.flatMap((o) => [o.name, ...o.values]).join(' ').toLowerCase();
    for (const junk of ['subtotal', 'checkout', 'free shipping', 'star seller', 'followers']) {
      assert.ok(!flat.includes(junk), `"${junk}" must not appear as an option`);
    }
  });

  test('Temu: skips the "$0123456789.01" placeholder and finds the real price', function () {
    if (!JSDOM) return;
    // Temu ships a sequential-digit string used to size the price element.
    // The live popup reported it as the price until this was rejected.
    const r = run('screen_protector.html', 'https://www.temu.com/x.html');
    assert.equal(r.priceNumber, 2.95, 'should find the actual listed price');
    assert.doesNotMatch(String(r.priceText), /0123456789/);
  });
});
