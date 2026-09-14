/**
 * Map captured images onto variants.
 *
 * Swatch images carry the option value they sat next to on the supplier page
 * ("Black", "SK-40A"). Gallery shots carry nothing, so they become the
 * product's own images rather than being guessed onto a variant.
 *
 * Matching is deliberately loose — suppliers write "black", "Black" and
 * "Black Blue Light A" for the same swatch — but every loose match is
 * reported so a wrong one is visible rather than silent.
 */

/** Normalise for comparison: case, punctuation and spacing all vary. */
const norm = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

/**
 * How well does a swatch label match an option value?
 * 100 exact · 90 normalised · 70 one contains the other · 50 shared words.
 */
export function matchScore(swatchValue, optionValue) {
  const a = String(swatchValue ?? '').trim();
  const b = String(optionValue ?? '').trim();
  if (!a || !b) return 0;
  if (a === b) return 100;

  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 90;

  // "Black" vs "Black Blue Light A" — the supplier's swatch label is often a
  // prefix of the full option value, or the reverse.
  if (na.startsWith(nb) || nb.startsWith(na)) return 75;
  if (na.includes(nb) || nb.includes(na)) return 70;

  // Fall back to shared words, which catches "cyan mic" vs "EDX pro cyan mic".
  const wa = new Set(na.split(' ').filter(Boolean));
  const wb = new Set(nb.split(' ').filter(Boolean));
  const shared = [...wa].filter((w) => wb.has(w)).length;
  if (shared === 0) return 0;
  const ratio = shared / Math.min(wa.size, wb.size);
  return ratio >= 0.5 ? Math.round(50 * ratio) : 0;
}

/**
 * Assign images to variants.
 *
 * @param {object[]} images   [{ name, variantValue }]
 * @param {object[]} variants [{ sku, choices }]
 * @param {object}   opts     { threshold = 50 }
 * @returns {{ assignments: Map<string,string>, productImages: string[],
 *             uncertain: object[], unmatched: object[] }}
 */
export function mapImagesToVariants(images = [], variants = [], { threshold = 50 } = {}) {
  const assignments = new Map();   // variant sku -> image name
  const productImages = [];
  const uncertain = [];
  const unmatched = [];

  // Images with no option value cannot belong to a specific variant.
  const swatches = [];
  for (const im of images) {
    if (im?.variantValue) swatches.push(im);
    else if (im?.name) productImages.push(im.name);
  }

  for (const im of swatches) {
    // Best-scoring variant for this swatch, across every choice it holds.
    let best = null;
    for (const v of variants) {
      for (const value of Object.values(v.choices ?? {})) {
        const score = matchScore(im.variantValue, value);
        if (score > 0 && (!best || score > best.score)) {
          best = { sku: v.sku, score, matchedValue: value };
        }
      }
    }

    if (!best || best.score < threshold) {
      // Still useful as a product image rather than discarded.
      unmatched.push({ image: im.name, value: im.variantValue });
      productImages.push(im.name);
      continue;
    }

    // A swatch usually applies to every variant sharing that option value,
    // not just one: "Black" covers Black/S, Black/M and Black/L.
    for (const v of variants) {
      const applies = Object.values(v.choices ?? {})
        .some((value) => matchScore(im.variantValue, value) >= threshold);
      if (applies && !assignments.has(v.sku)) assignments.set(v.sku, im.name);
    }

    if (best.score < 90) {
      uncertain.push({
        image: im.name,
        value: im.variantValue,
        matchedValue: best.matchedValue,
        score: best.score,
      });
    }
  }

  return { assignments, productImages, uncertain, unmatched };
}

/** One-line summary for the editor. */
export function describeMapping(result, variantCount) {
  const mapped = result.assignments.size;
  const parts = [`${mapped} of ${variantCount} variant(s) got an image`];
  if (result.productImages.length) parts.push(`${result.productImages.length} product image(s)`);
  if (result.uncertain.length) parts.push(`${result.uncertain.length} matched loosely — check`);
  if (result.unmatched.length) parts.push(`${result.unmatched.length} could not be matched`);
  return parts.join(' · ');
}
