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
