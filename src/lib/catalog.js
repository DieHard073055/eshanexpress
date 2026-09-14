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

/**
 * Index by orderable SKU.
 *
 * A variant product contributes its VARIANTS, not itself: the parent sku is
 * never orderable and has no stock row. Each variant entry carries the
 * parent's title, images and preorder settings, plus its own price, stock and
 * chosen options, so cart and checkout need no special cases.
 */
export function bySku(products) {
  const map = new Map();
  for (const p of products) {
    if (Array.isArray(p.variants) && p.variants.length) {
      for (const v of p.variants) {
        map.set(v.sku, {
          ...p,
          sku: v.sku,
          parentSku: p.sku,
          priceCents: v.priceCents,
          stockTotal: v.stockTotal,
          choices: v.choices,
          thumb: v.image ?? p.images?.[0],
          images: v.image ? [v.image, ...(p.images ?? [])] : p.images,
          variants: undefined,
          options: undefined,
        });
      }
    } else {
      map.set(p.sku, p);
    }
  }
  return map;
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
