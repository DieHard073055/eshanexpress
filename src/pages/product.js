import { loadCatalog, bySku, imgAttrs } from '../lib/catalog.js';
import { setCurrency, formatCents, discountPercent } from '../lib/money.js';
import { setView, errorView, esc, toast } from '../components/layout.js';
import { productCard } from '../components/product-card.js';
import { add } from '../lib/cart.js';
import { isPreorder, leadTimeLabel, preorderNotice } from '../lib/preorder.js';

export async function productPage({ sku }) {
  let data;
  try {
    data = await loadCatalog();
  } catch (e) {
    return setView(errorView(e.message));
  }

  setCurrency(data.currency);
  const index = bySku(data.products);
  const p = index.get(sku);

  if (!p) {
    return setView(`
      <div class="card mx-auto max-w-md p-10 text-center">
        <h2 class="text-lg font-semibold">Product not found</h2>
        <p class="mt-2 text-sm text-neutral-600">
          This item may have been removed since you last visited.
        </p>
        <a href="#/" class="btn-primary mt-5">Continue shopping</a>
      </div>`);
  }

  const store = data.stores.find((s) => s.slug === p.storeSlug);
  const off = discountPercent(p.priceCents, p.compareAtCents);
  const out = p.stockTotal <= 0;
  const pre = isPreorder(p);
  // A per-item cap on how many you are willing to source at once.
  const max = Math.max(Math.min(p.stockTotal, p.maxPerOrder ?? Infinity), 1);

  const related = data.products
    .filter((r) => r.sku !== p.sku && (r.categories ?? []).some((c) => (p.categories ?? []).includes(c)))
    .slice(0, 4)
    .map((r) => ({ ...r, thumb: r.images[0] }));

  const hero = imgAttrs(p.images[0], '(max-width: 768px) 100vw, 480px');

  setView(`
    <nav class="mb-4 text-sm text-neutral-500" aria-label="Breadcrumb">
      <a href="#/" class="hover:text-brand-600">Shop</a>
      ${p.categories?.[0] ? ` <span aria-hidden="true">/</span>
        <a href="#/?cat=${encodeURIComponent(p.categories[0])}" class="hover:text-brand-600">${esc(p.categories[0])}</a>` : ''}
    </nav>

    <div class="grid gap-8 md:grid-cols-2">
      <div>
        <div class="card overflow-hidden">
          <img id="hero" src="${hero.src}" srcset="${hero.srcset}" sizes="${hero.sizes}"
               alt="${esc(hero.alt)}" class="aspect-square w-full object-cover" />
        </div>
        ${p.images.length > 1 ? `
          <div class="mt-3 flex gap-2">
            ${p.images.map((im, i) => {
              const t = imgAttrs(im, '80px');
              return `<button type="button" data-thumb="${i}"
                        class="thumb h-16 w-16 overflow-hidden rounded-lg border-2 ${i === 0 ? 'border-brand-500' : 'border-transparent'}"
                        aria-label="View image ${i + 1}">
                        <img src="${t.src}" alt="" class="h-full w-full object-cover" />
                      </button>`;
            }).join('')}
          </div>` : ''}
      </div>

      <div>
        <h1 class="text-xl font-semibold leading-snug sm:text-2xl">${esc(p.title)}</h1>
        ${store ? `<p class="mt-1.5 text-sm text-neutral-500">Sold by
          <a href="#/?store=${encodeURIComponent(store.slug)}" class="text-brand-600 hover:underline">${esc(store.name)}</a></p>` : ''}

        <div class="mt-4 flex items-baseline gap-2.5">
          <span class="text-2xl font-bold text-brand-600">${formatCents(p.priceCents)}</span>
          ${p.compareAtCents && p.compareAtCents > p.priceCents
            ? `<span class="text-neutral-400 line-through">${formatCents(p.compareAtCents)}</span>
               <span class="rounded bg-brand-50 px-1.5 py-0.5 text-xs font-bold text-brand-700">-${off}%</span>` : ''}
        </div>

        ${pre && !out
          ? `<div class="mt-4 rounded-lg border border-sky-200 bg-sky-50 p-3">
               <p class="flex items-center gap-1.5 text-sm font-semibold text-sky-800">
                 <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
                   <circle cx="12" cy="12" r="9" /><path stroke-linecap="round" d="M12 7v5l3 2" />
                 </svg>
                 Preorder — ships in ${leadTimeLabel(p.leadTimeDays)}
               </p>
               <p class="mt-1 text-xs leading-relaxed text-sky-900">${esc(preorderNotice(p))}</p>
             </div>`
          : `<p class="mt-3 text-sm ${out ? 'text-red-600' : p.stockTotal <= 5 ? 'text-amber-600' : 'text-green-700'}">
               ${out ? 'Out of stock' : p.stockTotal <= 5 ? `Only ${p.stockTotal} left` : 'In stock'}
             </p>`}

        <div class="mt-6 flex items-center gap-3">
          <label for="qty" class="text-sm text-neutral-600">Qty</label>
          <input id="qty" type="number" min="1" max="${max}" value="1" ${out ? 'disabled' : ''}
                 class="w-20 rounded-lg border border-neutral-300 px-3 py-2 text-sm" />
          ${p.maxPerOrder ? `<span class="text-xs text-neutral-500">Max ${p.maxPerOrder} per order</span>` : ''}
        </div>

        <button id="add" class="btn-primary mt-4 w-full sm:w-auto sm:px-10" ${out ? 'disabled' : ''}>
          ${out ? 'Out of stock' : pre ? 'Preorder now' : 'Add to cart'}
        </button>

        <p class="mt-3 text-xs text-neutral-500">
          Stock shown was set at the last site update. Availability is confirmed at checkout.
        </p>

        ${p.description ? `
          <div class="mt-8 border-t border-neutral-200 pt-6">
            <h2 class="font-semibold">Description</h2>
            <p class="mt-2 whitespace-pre-line text-sm leading-relaxed text-neutral-700">${esc(p.description)}</p>
          </div>` : ''}

        ${p.specs && Object.keys(p.specs).length ? `
          <div class="mt-6">
            <h2 class="font-semibold">Specifications</h2>
            <dl class="mt-2 divide-y divide-neutral-100 text-sm">
              ${Object.entries(p.specs).map(([k, v]) => `
                <div class="flex gap-4 py-2">
                  <dt class="w-40 shrink-0 text-neutral-500">${esc(k)}</dt>
                  <dd class="text-neutral-800">${esc(v)}</dd>
                </div>`).join('')}
            </dl>
          </div>` : ''}
      </div>
    </div>

    ${related.length ? `
      <section class="mt-14">
        <h2 class="mb-4 text-lg font-semibold">You might also like</h2>
        <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          ${related.map(productCard).join('')}
        </div>
      </section>` : ''}
  `);

  // Thumbnail switching
  const heroEl = document.getElementById('hero');
  for (const btn of document.querySelectorAll('.thumb')) {
    btn.addEventListener('click', () => {
      const im = imgAttrs(p.images[Number(btn.dataset.thumb)], '(max-width: 768px) 100vw, 480px');
      heroEl.src = im.src;
      heroEl.srcset = im.srcset;
      heroEl.alt = im.alt;
      for (const b of document.querySelectorAll('.thumb')) {
        b.classList.toggle('border-brand-500', b === btn);
        b.classList.toggle('border-transparent', b !== btn);
      }
    });
  }

  document.getElementById('add')?.addEventListener('click', () => {
    const input = document.getElementById('qty');
    const qty = Math.min(Math.max(parseInt(input.value, 10) || 1, 1), max);
    input.value = String(qty);
    add(p.sku, qty, p.stockTotal);
    toast(`Added ${qty} × ${p.title}`);
  });
}
