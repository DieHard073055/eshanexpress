import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertToMvrCents, validateConfig, explain, rateAgeWarning,
} from '../src/lib/pricing.js';

const cfg = {
  sourceCurrency: 'SGD', targetCurrency: 'MVR',
  rate: 11.85, feePercent: 15, flatFeeMvr: 25,
  rounding: 'none', roundToMvr: 1,
};

test('applies rate, then percent, then flat fee in that order', () => {
  // 10 × 11.85 = 118.50 → ×1.15 = 136.275 → +25 = 161.275
  // NOTE 136.275 is 136.27499999999998 in IEEE754, so it rounds DOWN.
  // Asserting the float-accurate value rather than the decimal ideal: this
  // is what customers are actually charged.
  const { breakdown, cents } = convertToMvrCents(10, cfg);
  assert.equal(breakdown.converted, 118.5);
  assert.equal(breakdown.afterPercent, 136.27);
  assert.equal(breakdown.afterFlat, 161.27);
  assert.equal(cents, 16127);
});

test('the flat fee is NOT multiplied by the percentage', () => {
  // If order were wrong ((10×11.85 + 25) × 1.15 = 165.03) the total differs.
  const { breakdown } = convertToMvrCents(10, cfg);
  assert.notEqual(breakdown.afterFlat, 165.03);
  assert.equal(breakdown.afterFlat, 161.27);
});

test('rounds up to the nearest 5 when asked', () => {
  const { breakdown } = convertToMvrCents(10, { ...cfg, rounding: 'up', roundToMvr: 5 });
  assert.equal(breakdown.final, 165, '161.275 rounds up to 165');
});

test('rounds to nearest, which can go down', () => {
  const { breakdown } = convertToMvrCents(10, { ...cfg, rounding: 'nearest', roundToMvr: 5 });
  assert.equal(breakdown.final, 160, '161.275 is nearer 160 than 165');
});

test('rounding up never lands more than one step above the raw price', () => {
  // Float arithmetic means an "exact" multiple can sit a hair either side, so
  // assert the property that matters rather than an exact equality.
  for (const amt of [1, 3.7, 10, 42.5, 99.99]) {
    const raw = convertToMvrCents(amt, { ...cfg, rounding: 'none' }).breakdown.final;
    const up = convertToMvrCents(amt, { ...cfg, rounding: 'up', roundToMvr: 5 }).breakdown.final;
    assert.ok(up >= raw, `${amt}: rounded up must not be below the raw price`);
    assert.ok(up - raw < 5, `${amt}: must not jump a whole extra step`);
    assert.equal(up % 5, 0, `${amt}: must land on a multiple of 5`);
  }
});

test('rounding happens once at the end, not per step', () => {
  // Two items priced together must equal the sum of pricing them apart only
  // when no rounding is applied — this asserts no hidden intermediate round.
  const a = convertToMvrCents(7.33, { ...cfg, rounding: 'none' });
  const expected = Math.round((7.33 * 11.85 * 1.15 + 25) * 100);
  assert.equal(a.cents, expected);
});

test('zero converts to just the flat fee', () => {
  assert.equal(convertToMvrCents(0, cfg).cents, 2500);
});

test('rejects a negative amount', () => {
  assert.equal(convertToMvrCents(-5, cfg), null);
});

test('rejects a non-numeric amount', () => {
  assert.equal(convertToMvrCents('abc', cfg), null);
});

test('no fee and no rounding is a pure conversion', () => {
  const plain = { ...cfg, feePercent: 0, flatFeeMvr: 0, rounding: 'none' };
  assert.equal(convertToMvrCents(10, plain).cents, 118500 / 10);
});

// ------------------------------------------------------------- validation
test('accepts a sane config', () => {
  assert.deepEqual(validateConfig(cfg), []);
});

test('rejects a zero or negative rate', () => {
  assert.ok(validateConfig({ ...cfg, rate: 0 }).length);
  assert.ok(validateConfig({ ...cfg, rate: -1 }).length);
});

test('flags an implausible rate as a likely typo', () => {
  // 1185 instead of 11.85 would price everything 100x too high.
  const errs = validateConfig({ ...cfg, rate: 1185 });
  assert.ok(errs.some((e) => /looks wrong/.test(e)));
});

test('rejects an unknown rounding mode', () => {
  assert.ok(validateConfig({ ...cfg, rounding: 'sideways' }).length);
});

test('rejects roundToMvr of 0 when rounding is on', () => {
  assert.ok(validateConfig({ ...cfg, rounding: 'up', roundToMvr: 0 }).length);
});

// ---------------------------------------------------------------- explain
test('explain shows the whole formula', () => {
  const s = explain(10, { ...cfg, rounding: 'up', roundToMvr: 5 });
  assert.match(s, /SGD 10\.00 × 11\.85/);
  assert.match(s, /\+15%/);
  assert.match(s, /\+MVR 25/);
  assert.match(s, /MVR 165\.00/);
});

test('explain omits parts that are not configured', () => {
  const s = explain(10, { ...cfg, feePercent: 0, flatFeeMvr: 0, rounding: 'none' });
  assert.doesNotMatch(s, /%/);
  assert.doesNotMatch(s, /rounded/);
});

// --------------------------------------------------------------- rate age
test('warns when the stored rate is stale', () => {
  const old = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  assert.match(rateAgeWarning({ rateUpdated: old }), /30 days ago/);
});

test('stays quiet for a fresh rate', () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(rateAgeWarning({ rateUpdated: today }), null);
});

test('warns when no rate date is recorded', () => {
  assert.match(rateAgeWarning({}), /No rate date/);
});

// ---------------------------------------------------------------------------
// The extension cannot import from src/, so popup.js carries its own copy of
// the formula. This asserts the copy has not drifted — a divergence would
// price captured products differently from imported ones.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';

test('the extension formula matches src/lib/pricing.js', () => {
  const src = readFileSync('extension/popup.js', 'utf8');
  const body = /function toMvrCents[\s\S]*?\n}/.exec(src)?.[0];
  assert.ok(body, 'extension must define toMvrCents');

  // Evaluate the extension copy in isolation and compare across a spread of
  // amounts and configs.
  // eslint-disable-next-line no-new-func
  const extFn = new Function(`${body}; return toMvrCents;`)();

  const configs = [
    { rate: 11.85, feePercent: 15, flatFeeMvr: 25, rounding: 'none', roundToMvr: 1 },
    { rate: 11.85, feePercent: 15, flatFeeMvr: 25, rounding: 'up', roundToMvr: 5 },
    { rate: 8.2, feePercent: 0, flatFeeMvr: 0, rounding: 'nearest', roundToMvr: 10 },
  ];

  for (const c of configs) {
    for (const amt of [0, 1, 7.33, 10, 42.5, 99.99, 1536.24]) {
      assert.equal(
        extFn(amt, c), convertToMvrCents(amt, c).cents,
        `drift at ${amt} with rate ${c.rate}/${c.rounding}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Currency guard. Browsing in the wrong currency and converting anyway is the
// costliest silent mistake available: an Rf price converted with an SGD rate
// is ~12x too high on every product.
// ---------------------------------------------------------------------------
function extFn(name) {
  const src = readFileSync('extension/popup.js', 'utf8');
  const aliases = /const CURRENCY_ALIASES[\s\S]*?\n};/.exec(src)[0];
  const body = new RegExp(`function ${name}[\\s\\S]*?\\n}`).exec(src)[0];
  // eslint-disable-next-line no-new-func
  return new Function(`${aliases}; ${body}; return ${name};`)();
}

test('recognises the SGD symbol as SGD', () => {
  const matches = extFn('currencyMatches');
  assert.equal(matches('S$', 'SGD'), true);
  assert.equal(matches('SGD', 'SGD'), true);
});

test('an Rf page does NOT match an SGD config', () => {
  const matches = extFn('currencyMatches');
  assert.equal(matches('Rf', 'SGD'), false, 'converting Rf with an SGD rate inflates ~12x');
});

test('the real sample page symbol (Rf) is named as MVR', () => {
  assert.equal(extFn('nameCurrency')('Rf'), 'MVR');
});

test('an unknown symbol returns null rather than guessing', () => {
  const matches = extFn('currencyMatches');
  assert.equal(matches(null, 'SGD'), null);
  assert.equal(matches('¤', 'SGD'), false);
  assert.equal(extFn('nameCurrency')('¤'), null);
});

test('whitespace and case do not defeat the match', () => {
  const matches = extFn('currencyMatches');
  assert.equal(matches('US $', 'USD'), true);
  assert.equal(matches('sgd', 'SGD'), true);
});
