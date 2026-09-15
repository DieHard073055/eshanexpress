import { loadIndex } from '../lib/catalog.js';
import { setCurrency } from '../lib/money.js';
import { productCard } from '../components/product-card.js';
import { setView, skeletonGrid, errorView, esc } from '../components/layout.js';
import { navigate } from '../lib/router.js';

const SORTS = {
  relevance: null,
  'price-asc': (a, b) => a.priceCents - b.priceCents,
  'price-desc': (a, b) => b.priceCents - a.priceCents,
  name: (a, b) => a.title.localeCompare(b.title),
};

function matches(p, q) {
  if (!q) return true;
  const hay = `${p.title} ${(p.categories ?? []).join(' ')} ${p.sku}`.toLowerCase();
  // Every term must appear somewhere — narrows rather than widens results.
  return q.toLowerCase().split(/\s+/).every((t) => hay.includes(t));
}

/**
 * One store card in the home-page strip. Decoration is optional (§2 adds
 * logos); without one the initial-letter tile is the neutral placeholder.
 */
function storeCard(store, count) {
  const initial = esc(store.name.trim().charAt(0).toUpperCase());
  return `
    <a href="#/store/${encodeURIComponent(store.slug)}"
       class="card group flex min-w-0 items-center gap-3 p-3 transition hover:border-brand-500 hover:shadow-md">
      <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-600
                  text-lg font-bold text-white">${initial}</div>
      <div class="min-w-0">
        <h3 class="truncate text-sm font-medium text-neutral-800 group-hover:text-brand-700">${esc(store.name)}</h3>
        <p class="truncate text-xs text-neutral-500">${count} product${count === 1 ? '' : 's'}</p>
      </div>
    </a>`;
}

export async function listingPage(_params, query) {
  setView(skeletonGrid());

  let data;
  try {
    data = await loadIndex();
  } catch (e) {
    return setView(errorView(e.message));
  }

  setCurrency(data.currency);

  const q = query.q ?? '';
  const store = query.store ?? '';
  const sort = query.sort ?? 'relevance';
  const inStockOnly = query.stock === '1';

  let items = data.products.filter(
    (p) =>
      matches(p, q) &&
      (!store || p.storeSlug === store) &&
      (!inStockOnly || p.inStock),
  );

  // Out-of-stock items sink to the bottom regardless of sort — they can't be bought.
  const cmp = SORTS[sort];
  items = [...items].sort((a, b) => (a.inStock === b.inStock ? (cmp ? cmp(a, b) : 0) : a.inStock ? -1 : 1));

  const qs = (over) => {
    const merged = { q, store, sort, stock: inStockOnly ? '1' : '', ...over };
    const s = new URLSearchParams(Object.entries(merged).filter(([, v]) => v && v !== 'relevance'));
    return `#/${s.toString() ? `?${s}` : ''}`;
  };

  const chip = (label, href, active) => `
    <a href="${href}" class="shrink-0 rounded-full border px-3 py-1.5 text-sm transition
       ${active ? 'border-brand-600 bg-brand-50 font-medium text-brand-700'
                : 'border-neutral-300 bg-white text-neutral-700 hover:border-neutral-400'}">${esc(label)}</a>`;

  const stores = (data.stores ?? [])
    .map((s) => ({ store: s, count: data.products.filter((p) => p.storeSlug === s.slug).length }))
    .sort((a, b) => b.count - a.count || a.store.name.localeCompare(b.store.name));

  // Browsing a search or a store filter is a focused view — the strip is for
  // discovery, so it only shows on the unfiltered home.
  const showStrip = !q && !store;

  setView(`
    ${showStrip && stores.length ? `
      <section aria-label="Stores" class="mb-6">
        <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">Stores</h2>
        <div class="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:grid sm:grid-cols-3 sm:overflow-visible sm:px-0 lg:grid-cols-4">
          ${stores.map(({ store: s, count }) => `
            <div class="w-52 shrink-0 sm:w-auto">${storeCard(s, count)}</div>`).join('')}
        </div>
      </section>` : ''}

    <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div class="min-w-0">
        <h1 class="text-xl font-semibold">
          ${q ? `Results for “${esc(q)}”` : store ? esc((data.stores ?? []).find((s) => s.slug === store)?.name ?? store) : 'All products'}
        </h1>
        <p class="mt-0.5 text-sm text-neutral-500">${items.length} item${items.length === 1 ? '' : 's'}</p>
      </div>
      <label class="flex items-center gap-2 text-sm">
        <span class="text-neutral-600">Sort</span>
        <select id="sort" class="rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm">
          <option value="relevance"${sort === 'relevance' ? ' selected' : ''}>Featured</option>
          <option value="price-asc"${sort === 'price-asc' ? ' selected' : ''}>Price: low to high</option>
          <option value="price-desc"${sort === 'price-desc' ? ' selected' : ''}>Price: high to low</option>
          <option value="name"${sort === 'name' ? ' selected' : ''}>Name</option>
        </select>
      </label>
    </div>

    <div class="mb-5 flex gap-2 overflow-x-auto pb-1">
      ${chip(inStockOnly ? '✓ In stock' : 'In stock', qs({ stock: inStockOnly ? '' : '1' }), inStockOnly)}
    </div>

    ${items.length === 0
      ? `<div class="card p-12 text-center">
           <p class="font-medium text-neutral-700">No products found</p>
           <p class="mt-1 text-sm text-neutral-500">Try a different search or clear the filters.</p>
           <a href="#/" class="btn-secondary mt-5">Clear filters</a>
         </div>`
      : `<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
           ${items.map(productCard).join('')}
         </div>`}
  `);

  document.getElementById('sort')?.addEventListener('change', (e) => {
    navigate(qs({ sort: e.target.value }).slice(1));
  });

  const input = document.getElementById('q');
  if (input && input.value !== q) input.value = q;
}
