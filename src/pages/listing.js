import { loadIndex, categoriesOf } from '../lib/catalog.js';
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
  const cat = query.cat ?? '';
  const store = query.store ?? '';
  const sort = query.sort ?? 'relevance';
  const inStockOnly = query.stock === '1';

  let items = data.products.filter(
    (p) =>
      matches(p, q) &&
      (!cat || (p.categories ?? []).includes(cat)) &&
      (!store || p.storeSlug === store) &&
      (!inStockOnly || p.inStock),
  );

  // Out-of-stock items sink to the bottom regardless of sort — they can't be bought.
  const cmp = SORTS[sort];
  items = [...items].sort((a, b) => (a.inStock === b.inStock ? (cmp ? cmp(a, b) : 0) : a.inStock ? -1 : 1));

  const cats = categoriesOf(data.products);
  const qs = (over) => {
    const merged = { q, cat, store, sort, stock: inStockOnly ? '1' : '', ...over };
    const s = new URLSearchParams(Object.entries(merged).filter(([, v]) => v && v !== 'relevance'));
    return `#/${s.toString() ? `?${s}` : ''}`;
  };

  const chip = (label, href, active) => `
    <a href="${href}" class="shrink-0 rounded-full border px-3 py-1.5 text-sm transition
       ${active ? 'border-brand-600 bg-brand-50 font-medium text-brand-700'
                : 'border-neutral-300 bg-white text-neutral-700 hover:border-neutral-400'}">${esc(label)}</a>`;

  setView(`
    <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">
          ${q ? `Results for “${esc(q)}”` : cat ? esc(cat.replace(/^./, (c) => c.toUpperCase())) : 'All products'}
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
      ${chip('All', qs({ cat: '' }), !cat)}
      ${cats.map((c) => chip(c.replace(/^./, (ch) => ch.toUpperCase()), qs({ cat: c }), cat === c)).join('')}
      <span class="mx-1 w-px shrink-0 bg-neutral-200"></span>
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
