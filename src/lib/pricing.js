/**
 * Sourcing price conversion.
 *
 * Supplier prices are browsed in SGD; the store sells in MVR. The conversion
 * is deliberately explicit and testable, because a silent error here is a
 * pricing error on every imported product.
 *
 *   MVR = source × rate × (1 + feePercent/100) + flatFee   → rounded
 *
 * Money is integer cents throughout. Rounding happens once, at the end, on
 * the whole-MVR amount — rounding intermediate steps compounds the error.
 */

export const DEFAULT_CONFIG = {
  sourceCurrency: 'SGD',
  targetCurrency: 'MVR',
  rate: 1,
  feePercent: 0,
  flatFeeMvr: 0,
  rounding: 'none',
  roundToMvr: 1,
};

/** Reject a config that would silently produce nonsense prices. */
export function validateConfig(cfg) {
  const errors = [];
  const n = (v) => typeof v === 'number' && Number.isFinite(v);

  if (!n(cfg?.rate) || cfg.rate <= 0) errors.push('rate must be a positive number');
  if (!n(cfg?.feePercent) || cfg.feePercent < 0) errors.push('feePercent must be 0 or more');
  if (!n(cfg?.flatFeeMvr) || cfg.flatFeeMvr < 0) errors.push('flatFeeMvr must be 0 or more');
  if (!['up', 'nearest', 'none'].includes(cfg?.rounding ?? 'none')) {
    errors.push('rounding must be "up", "nearest" or "none"');
  }
  if (cfg?.rounding !== 'none' && (!n(cfg?.roundToMvr) || cfg.roundToMvr <= 0)) {
    errors.push('roundToMvr must be a positive number when rounding is enabled');
  }
  // A rate this far from plausible is almost certainly a typo — say so rather
  // than pricing a whole catalog wrongly.
  if (n(cfg?.rate) && (cfg.rate > 1000 || cfg.rate < 0.001)) {
    errors.push(`rate ${cfg.rate} looks wrong — check it is ${cfg.targetCurrency ?? 'MVR'} per 1 ${cfg.sourceCurrency ?? 'SGD'}`);
  }
  return errors;
}

/**
 * Convert a source-currency amount to MVR cents.
 * Returns the integer cents plus a breakdown, so the UI can show its working.
 */
export function convertToMvrCents(sourceAmount, config = DEFAULT_CONFIG) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const amount = Number(sourceAmount);
  if (!Number.isFinite(amount) || amount < 0) return null;

  const converted = amount * cfg.rate;
  const withPercent = converted * (1 + cfg.feePercent / 100);
  const withFlat = withPercent + cfg.flatFeeMvr;

  let final = withFlat;
  if (cfg.rounding === 'up') {
    final = Math.ceil(withFlat / cfg.roundToMvr) * cfg.roundToMvr;
  } else if (cfg.rounding === 'nearest') {
    final = Math.round(withFlat / cfg.roundToMvr) * cfg.roundToMvr;
  }

  return {
    cents: Math.round(final * 100),
    breakdown: {
      source: amount,
      converted: Math.round(converted * 100) / 100,
      afterPercent: Math.round(withPercent * 100) / 100,
      afterFlat: Math.round(withFlat * 100) / 100,
      final: Math.round(final * 100) / 100,
    },
  };
}

/** One-line explanation of how a price was reached, for the editor. */
export function explain(sourceAmount, config = DEFAULT_CONFIG) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const out = convertToMvrCents(sourceAmount, cfg);
  if (!out) return 'Invalid amount';

  const parts = [`${cfg.sourceCurrency} ${Number(sourceAmount).toFixed(2)} × ${cfg.rate}`];
  if (cfg.feePercent) parts.push(`+${cfg.feePercent}%`);
  if (cfg.flatFeeMvr) parts.push(`+${cfg.targetCurrency} ${cfg.flatFeeMvr}`);
  if (cfg.rounding !== 'none') parts.push(`rounded ${cfg.rounding} to ${cfg.roundToMvr}`);

  return `${parts.join(' ')} = ${cfg.targetCurrency} ${out.breakdown.final.toFixed(2)}`;
}

/** Warn when a stored rate is old enough to be misleading. */
export function rateAgeWarning(config, maxDays = 7) {
  if (!config?.rateUpdated) return 'No rate date recorded — is this rate current?';
  const days = Math.floor((Date.now() - new Date(config.rateUpdated)) / 86400000);
  if (Number.isNaN(days)) return 'Rate date is unreadable.';
  if (days > maxDays) {
    return `Rate was set ${days} days ago. Check it before importing.`;
  }
  return null;
}
