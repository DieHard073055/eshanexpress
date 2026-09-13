/**
 * Loads the baked catalog. Static JSON on GitHub Pages — no backend.
 * `buildId` is the cache key: a redeploy changes it, so stale caches expire.
 */

const BASE = import.meta.env.BASE_URL || '/';

let indexPromise = null;
let catalogPromise = null;

export function loadIndex() {
  indexPromise ??= fetch(`${BASE}catalog/index.json`).then((r) => {
    if (!r.ok) throw new Error(`Catalog unavailable (${r.status})`);
    return r.json();
  });
  return indexPromise;
}

export function loadCatalog() {
  catalogPromise ??= fetch(`${BASE}catalog/catalog.json`).then((r) => {
    if (!r.ok) throw new Error(`Catalog unavailable (${r.status})`);
    return r.json();
  });
  return catalogPromise;
}

export function bySku(products) {
  return new Map(products.map((p) => [p.sku, p]));
}

/** srcset from the width variants the build produced. */
export function imgAttrs(image, sizes = '(max-width: 640px) 50vw, 300px') {
  if (!image?.widths) return { src: '', srcset: '', sizes, alt: image?.alt ?? '' };
  const widths = Object.keys(image.widths).map(Number).sort((a, b) => a - b);
  const url = (w) => `${BASE}catalog/img/${image.widths[w].file}`;
  return {
    src: url(widths[widths.length - 1]),
    srcset: widths.map((w) => `${url(w)} ${w}w`).join(', '),
    sizes,
    alt: image.alt ?? '',
  };
}

export function categoriesOf(products) {
  const set = new Set();
  for (const p of products) for (const c of p.categories ?? []) set.add(c);
  return [...set].sort();
}
