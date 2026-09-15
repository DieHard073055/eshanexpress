/**
 * Money is integer cents everywhere. Never use floats for currency —
 * 0.1 + 0.2 !== 0.3 and order totals would drift.
 */

let currency = 'MVR';

export function setCurrency(code) {
  currency = code || 'MVR';
}

export function formatCents(cents) {
  const value = cents / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
    }).format(value);
  } catch {
    // Unknown currency code — fall back to a plain prefix.
    return `${currency} ${value.toFixed(2)}`;
  }
}

export function discountPercent(priceCents, compareAtCents) {
  if (!compareAtCents || compareAtCents <= priceCents) return null;
  return Math.round(((compareAtCents - priceCents) / compareAtCents) * 100);
}

/**
 * Should a card show "from X" rather than a flat price?
 *
 * Only when the variants genuinely span a range. The two catalog payloads
 * disagree about what they carry: index.json omits priceFrom unless priceTo
 * differs, while catalog.json always emits both. So a check of
 * `priceFrom != null` alone says "from" on every variant product when fed
 * from the full catalog — which is what the store page does, while the home
 * page reads the index. Comparing the bounds makes both agree.
 */
export function hasPriceRange(p) {
  return p?.priceFrom != null && p?.priceTo != null && p.priceTo !== p.priceFrom;
}
